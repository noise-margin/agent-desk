import type {
  AgentInstallation,
  AgentProvider,
  ResolveInteractionInput,
  StartRunInput,
} from "@agentdesk/protocol";
import { CodexAdapter } from "./agents/codex-adapter.js";
import { QoderAdapter } from "./agents/qoder-adapter.js";
import { QwenCodeAdapter } from "./agents/qwen-code-adapter.js";
import type { AgentAdapter } from "./agents/types.js";
import { EventBus } from "./event-bus.js";
import { Store } from "./store.js";

export class Orchestrator {
  private readonly adapters: Map<AgentProvider, AgentAdapter>;

  constructor(
    private readonly store: Store,
    private readonly events: EventBus,
    providedAdapters?: AgentAdapter[],
  ) {
    const adapters: AgentAdapter[] = providedAdapters ?? [
      new CodexAdapter(store, events),
      new QoderAdapter(store, events),
      new QwenCodeAdapter(store, events),
    ];
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  detectAgents(): Promise<AgentInstallation[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.detect()));
  }

  start(taskId: string, body: StartRunInput) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    if (!task.workspacePath) throw new Error("请先准备工作区");
    if (task.status === "running" || task.status === "waiting_user") {
      throw new Error("任务已有正在运行的 Agent");
    }
    const adapter = this.adapters.get(task.provider);
    if (!adapter) throw new Error(`不支持 Agent：${task.provider}`);
    const session = this.store.createSession(taskId, task.provider);
    const prompt = this.composePrompt(task, body.prompt, body.mode);
    void adapter
      .start({
        taskId,
        sessionId: session.id,
        cwd: task.workspacePath,
        prompt,
        mode: body.mode,
      })
      .catch((error) => {
        this.store.updateSession(session.id, { status: "failed" });
        this.store.updateTask(taskId, { status: "failed" });
        this.events.publish(taskId, session.id, "turn.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return session;
  }

  async resolve(interactionId: string, input: ResolveInteractionInput) {
    const interaction = this.store.getInteraction(interactionId);
    if (!interaction) throw new Error("交互请求不存在");
    const task = this.store.getTask(interaction.taskId);
    const session = task?.sessions.find((item) => item.id === interaction.sessionId);
    if (!session) throw new Error("Agent 会话不存在");
    const adapter = this.adapters.get(session.provider);
    if (!adapter) throw new Error("Agent Adapter 不存在");
    await adapter.resolve(interactionId, input);
  }

  async interrupt(taskId: string) {
    const task = this.store.getTask(taskId);
    const session = task?.sessions.find((item) =>
      ["starting", "running", "waiting_user"].includes(item.status),
    );
    if (!task || !session) throw new Error("没有正在运行的 Agent 会话");
    await this.adapters.get(session.provider)?.interrupt(session.id);
  }

  async followUp(taskId: string, message: string) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    const activeSession = task.sessions.find((session) =>
      ["starting", "running", "waiting_user"].includes(session.status),
    );
    if (!activeSession) {
      const previousSession = task.sessions[0];
      const adapter = previousSession ? this.adapters.get(previousSession.provider) : undefined;
      if (previousSession?.providerSessionId && adapter?.resume && task.workspacePath) {
        void adapter
          .resume(
            {
              taskId,
              sessionId: previousSession.id,
              cwd: task.workspacePath,
              prompt: message,
            },
            previousSession.providerSessionId,
          )
          .catch((error) => {
            this.store.updateSession(previousSession.id, { status: "failed" });
            this.store.updateTask(taskId, { status: "failed" });
            this.events.publish(taskId, previousSession.id, "turn.failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return {
          mode: "new_turn" as const,
          sessionId: previousSession.id,
          providerSessionId: previousSession.providerSessionId,
          reusedSession: true,
        };
      }
      return { mode: "new_turn" as const, session: this.start(taskId, { prompt: message }) };
    }
    const adapter = this.adapters.get(activeSession.provider);
    if (!adapter?.steer) {
      throw new Error(`${activeSession.provider} 暂不支持运行中介入，请等待本轮完成后再发送`);
    }
    await adapter.steer(activeSession.id, message);
    this.events.publish(taskId, activeSession.id, "user.followup", { text: message });
    return { mode: "steer" as const, sessionId: activeSession.id };
  }

  async notifyActiveSession(taskId: string, message: string): Promise<boolean> {
    const task = this.store.getTask(taskId);
    const activeSession = task?.sessions.find((session) =>
      ["starting", "running", "waiting_user"].includes(session.status),
    );
    if (!activeSession) return false;
    const adapter = this.adapters.get(activeSession.provider);
    if (!adapter?.steer) return false;
    await adapter.steer(activeSession.id, message);
    this.events.publish(taskId, activeSession.id, "user.followup", { text: message, source: "repository_added" });
    return true;
  }

  resumeSession(
    taskId: string,
    sessionId: string,
    message: string,
    mode: StartRunInput["mode"] = "development",
  ) {
    const task = this.store.getTask(taskId);
    if (!task?.workspacePath) throw new Error("任务工作区不存在");
    const session = task.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("Agent 会话不存在");
    const adapter = this.adapters.get(session.provider);
    if (!session.providerSessionId || !adapter?.resume) {
      return this.start(taskId, { prompt: message, mode });
    }
    void adapter.resume(
      {
        taskId,
        sessionId,
        cwd: task.workspacePath,
        prompt: message,
        mode,
      },
      session.providerSessionId,
    ).catch((error) => {
      this.store.updateSession(sessionId, { status: "failed" });
      this.store.updateTask(taskId, { status: "failed" });
      this.events.publish(taskId, sessionId, "turn.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return session;
  }

  private composePrompt(
    task: NonNullable<ReturnType<Store["getTask"]>>,
    userPrompt: string,
    mode: StartRunInput["mode"] = "development",
  ) {
    const repositories =
      task.repositories.length > 0
        ? task.repositories
            .map((repo) => `- ${repo.worktreePath ?? repo.sourcePath}`)
            .join("\n")
        : "- 当前工作区（无独立仓库）";
    const materials =
      task.materials.length > 0
        ? task.materials
            .map((material) => `- materials/${material.name}`)
            .join("\n")
        : "- 暂无";
    const executionRequirements = mode === "development"
      ? `1. 先阅读 AGENTS.md 和 materials 目录。
2. 先分析影响范围，再实施修改。
3. 缺失信息会实质改变实现方案时，必须使用 AgentDesk 用户提问工具。
4. 不要访问或修改任务工作区以外的文件。
5. 修改后运行相关测试。
6. 最后总结变更、测试结果、风险和遗留事项。`
      : mode === "requirements"
        ? `1. 阅读 AGENTS.md、任务描述以及 materials 目录中的每一份材料。
2. 当前是独立需求分析任务，不得修改业务代码、原始材料或仓库状态。
3. 不得根据文件名猜测内容；需求规格必须逐份记录材料覆盖情况。
4. 缺失信息会实质改变需求或验收标准时，必须使用 AgentDesk 用户提问工具。
5. 不要访问任务工作区以外的文件。
6. 最终只返回一份完整、可追踪、可供人工确认的 Markdown 需求规格。`
        : mode === "knowledge"
          ? `1. 先阅读 AGENTS.md 和本轮指定的知识审查证据包，并逐一核对其中列出的原始材料、需求规格、用户补充、审查报告和代码 Diff。
2. 只允许修改各代码仓库的 knowledge/ 目录；不得修改业务代码、测试、配置、原始材料或 generated 证据包。
3. 按主题更新已有 Wiki 页面，避免为每个需求机械新增一篇孤立总结。
4. 每条稳定知识必须写明来源、适用范围、状态和最后验证日期；证据不足的内容只能标为 candidate。
5. 检查重复、冲突、断链、过期规则和孤立页面；无法确认时保留冲突并明确待确认事项。
6. 最终说明读取了哪些证据、修改了哪些 Wiki 页面、未沉淀哪些内容及原因。`
          : `1. 先阅读 AGENTS.md、materials 目录以及 generated 目录中的已确认需求规格。
2. 当前是独立的只读分析任务，不得修改业务代码或需求材料。
3. 可以运行不会改变业务代码的检查和测试命令。
4. 不要访问任务工作区以外的文件。
5. 结论必须基于可复现的证据；无法验证时明确说明原因，不要猜测。`;
    return `你正在 AgentDesk 任务工作区内执行一个${mode === "development" ? "开发" : mode === "knowledge" ? "独立知识审查" : "独立分析"}任务。

# 任务

${task.title}

${task.description ?? ""}

# 代码仓库

${repositories}

# 需求材料

${materials}

# 本轮指令

${userPrompt}

# 执行要求

${executionRequirements}
`;
  }
}
