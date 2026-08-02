import type {
  AcceptanceFinding,
  AcceptanceResult,
  AcceptanceVerdict,
  AgentEvent,
  CodeDiffFile,
  CodeDiffFileStatus,
  Task,
  WorkflowNodeRun,
  WorkflowRun,
} from "@agentdesk/protocol";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EventBus } from "./event-bus.js";
import { execFileAsync } from "./lib/process.js";
import { Orchestrator } from "./orchestrator.js";
import { Store } from "./store.js";
import { workflowTemplates } from "./workflow-templates.js";

function isoNow() {
  return new Date().toISOString();
}

const MAX_AUTOMATIC_QUALITY_REWORKS = 2;

function parsePorcelainStatus(value: string) {
  const fields = value.split("\0").filter(Boolean);
  const result: Array<{ code: string; path: string; oldPath?: string }> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const code = field.slice(0, 2);
    const filePath = field.slice(3);
    if (code.includes("R") || code.includes("C")) {
      result.push({ code, path: filePath, oldPath: fields[index + 1] });
      index += 1;
    } else {
      result.push({ code, path: filePath });
    }
  }
  return result;
}

function parseNameStatus(value: string) {
  const fields = value.split("\0").filter(Boolean);
  const result: Array<{ code: string; path: string; oldPath?: string }> = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++]!;
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = fields[index++];
      const filePath = fields[index++];
      if (filePath) result.push({ code, path: filePath, oldPath });
    } else {
      const filePath = fields[index++];
      if (filePath) result.push({ code, path: filePath });
    }
  }
  return result;
}

function isReviewablePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  return !normalized.startsWith("materials/")
    && !normalized.startsWith("artifacts/")
    && !normalized.startsWith("logs/")
    && normalized !== "AGENTS.md"
    && normalized !== "task.yaml";
}

function isKnowledgePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized === "knowledge" || normalized.startsWith("knowledge/") || normalized.includes("/knowledge/");
}

function isGeneratedEvidencePath(filePath: string) {
  return filePath.replaceAll("\\", "/").startsWith("generated/");
}

function nonKnowledgeSnapshot(repositories: Array<{ path: string; files: CodeDiffFile[] }>) {
  const entries = repositories.flatMap((repository) => repository.files
    .filter((file) => !isKnowledgePath(file.path) && !isGeneratedEvidencePath(file.path))
    .map((file) => {
      const key = `${path.resolve(repository.path)}::${file.path}`;
      const value = createHash("sha256")
        .update(JSON.stringify({ status: file.status, oldPath: file.oldPath, binary: file.binary, diff: file.diff }))
        .digest("hex");
      return [key, value] as const;
    }));
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function gitStatusName(code: string): CodeDiffFileStatus {
  if (code === "??" || code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("U")) return "unmerged";
  if (code.includes("M") || code.includes("T")) return "modified";
  return "unknown";
}

function countDiffLines(files: CodeDiffFile[]) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const line of file.diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }
  return { additions, deletions };
}

function parseQualityResult(output: string): AcceptanceResult {
  const candidates = [
    ...[...output.matchAll(/```json\s*([\s\S]*?)```/gi)].map((match) => match[1]),
    output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1),
  ].filter(Boolean).reverse();
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate!) as Record<string, unknown>;
      const verdict = String(parsed.verdict ?? "").toUpperCase() as AcceptanceVerdict;
      if (!["PASS", "PASS_WITH_WARNINGS", "FAIL", "INCONCLUSIVE"].includes(verdict)) continue;
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.map((value, index): AcceptanceFinding => {
            const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
            const evidence = item.evidence && typeof item.evidence === "object" ? item.evidence as Record<string, unknown> : undefined;
            const severity = ["blocking", "warning", "info"].includes(String(item.severity))
              ? String(item.severity) as AcceptanceFinding["severity"]
              : verdict === "FAIL" ? "blocking" : "warning";
            return {
              id: String(item.id ?? `AF-${String(index + 1).padStart(3, "0")}`),
              requirementId: item.requirementId ? String(item.requirementId) : undefined,
              acceptanceId: item.acceptanceId ? String(item.acceptanceId) : undefined,
              severity,
              title: String(item.title ?? "未命名验收问题"),
              expected: item.expected ? String(item.expected) : undefined,
              actual: item.actual ? String(item.actual) : undefined,
              reproductionSteps: Array.isArray(item.reproductionSteps) ? item.reproductionSteps.map(String) : [],
              evidence: evidence ? {
                command: evidence.command ? String(evidence.command) : undefined,
                output: evidence.output ? String(evidence.output) : undefined,
                file: evidence.file ? String(evidence.file) : undefined,
                path: evidence.path ? String(evidence.path) : undefined,
              } : undefined,
              suggestedDirection: item.suggestedDirection ? String(item.suggestedDirection) : undefined,
            };
          })
        : [];
      return { verdict, summary: String(parsed.summary ?? "Agent 未提供验收摘要"), findings };
    } catch {
      // Fall back to the legacy verdict marker below.
    }
  }
  const verdict = (output.match(/VERDICT\s*:\s*(PASS_WITH_WARNINGS|PASS|FAIL|INCONCLUSIVE)/i)?.[1]?.toUpperCase() ?? "INCONCLUSIVE") as AcceptanceVerdict;
  return { verdict, summary: output.trim() || "Agent 未返回可解析的验收报告", findings: [] };
}

export class WorkflowEngine {
  private readonly processing = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly events: EventBus,
    private readonly orchestrator: Orchestrator,
  ) {
    this.events.subscribeAll((event) => {
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        void this.onTurnFinished(event);
      }
    });
  }

  templates() {
    return workflowTemplates;
  }

  async recoverInterruptedWorkflows() {
    let recovered = 0;
    for (const task of this.store.listTasks()) {
      const workflow = task.workflow;
      if (!workflow) {
        if (task.status !== "interrupted") continue;
        const session = task.sessions.find((item) => item.status === "interrupted");
        if (!session) {
          this.store.updateTask(task.id, { status: "failed" });
          this.store.addActivity(task.id, "workflow.recovery_failed", { reason: "missing_interrupted_session" });
          continue;
        }
        try {
          const sessionEvents = this.store.sessionEvents(session.id);
          const latestTurnStarted = [...sessionEvents].reverse().find((event) => event.type === "turn.started");
          const terminalEvent = [...sessionEvents].reverse().find((event) =>
            (event.type === "turn.completed" || event.type === "turn.failed")
            && (!latestTurnStarted || event.id > latestTurnStarted.id),
          );
          if (terminalEvent) {
            const failed = terminalEvent.type === "turn.failed";
            this.store.updateSession(session.id, { status: failed ? "failed" : "completed" });
            this.store.updateTask(task.id, { status: failed ? "failed" : "completed" });
            this.store.addActivity(task.id, "workflow.recovered", { strategy: "replay_terminal_event", eventId: terminalEvent.id });
          } else {
            const staleInteraction = task.interactions.some((interaction) => interaction.sessionId === session.id && interaction.status === "stale");
            const originalPrompt = String(latestTurnStarted?.payload.prompt ?? "继续未完成的任务");
            const recoveryPrompt = `AgentDesk 在执行期间意外退出。请检查工作区、git diff 和已有结果，继续未完成的工作，不要重复已完成的修改。${staleInteraction ? "退出时有一个等待用户处理的请求已经失效；如仍需要，请重新提出。" : ""}\n\n退出前指令：\n${originalPrompt}`;
            this.store.updateTask(task.id, { status: "running" });
            const resumed = this.orchestrator.resumeSession(task.id, session.id, recoveryPrompt, "development");
            this.store.addActivity(task.id, "workflow.recovered", {
              strategy: resumed.id === session.id ? "resume_provider_session" : "start_recovery_session",
              previousSessionId: session.id,
              sessionId: resumed.id,
              staleInteraction,
            });
          }
          recovered += 1;
        } catch (error) {
          this.store.updateTask(task.id, { status: "failed" });
          this.store.addActivity(task.id, "workflow.recovery_failed", { error: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      if (workflow.status !== "interrupted") continue;
      const node = workflow.nodes.find((item) => item.id === workflow.currentNodeId);
      if (!node || node.status !== "interrupted") {
        this.markWorkflowFailure(task.id, new Error("无法确定服务退出时正在执行的工作流节点"));
        this.store.addActivity(task.id, "workflow.recovery_failed", { reason: "missing_interrupted_node" });
        continue;
      }
      const recoveryCount = Number(node.output?.recoveryCount ?? 0) + 1;
      try {
        const sessionEvents = node.sessionId ? this.store.sessionEvents(node.sessionId) : [];
        const latestTurnStarted = [...sessionEvents].reverse().find((event) => event.type === "turn.started");
        const terminalEvent = [...sessionEvents].reverse().find((event) =>
          (event.type === "turn.completed" || event.type === "turn.failed")
          && (!latestTurnStarted || event.id > latestTurnStarted.id),
        );
        this.store.updateWorkflowNode(task.id, node.id, {
          status: "running",
          output: { ...node.output, recoveryCount, lastRecoveryAt: isoNow() },
        });
        this.store.updateWorkflow(task.id, { status: "running", currentNodeId: node.id });
        this.store.updateTask(task.id, { status: "running" });
        if (node.sessionId) this.store.updateSession(node.sessionId, { status: "starting" });

        if (terminalEvent) {
          if (node.sessionId) {
            this.store.updateSession(node.sessionId, { status: terminalEvent.type === "turn.completed" ? "completed" : "failed" });
          }
          await this.onTurnFinished(terminalEvent);
          this.store.addActivity(task.id, "workflow.recovered", {
            nodeId: node.id,
            strategy: "replay_terminal_event",
            eventId: terminalEvent.id,
            recoveryCount,
          });
          recovered += 1;
          continue;
        }

        if (node.kind === "commit") {
          const existingCommit = [...workflow.artifacts].reverse().find((artifact) => artifact.nodeId === node.id && artifact.kind === "commit");
          if (existingCommit) {
            this.store.updateWorkflowNode(task.id, node.id, { status: "succeeded", completedAt: isoNow(), output: { recoveredFromArtifact: existingCommit.id } });
            await this.advance(task.id, node.id);
          } else {
            await this.commit(task.id, node);
          }
          this.store.addActivity(task.id, "workflow.recovered", { nodeId: node.id, strategy: "resume_idempotent_commit", recoveryCount });
          recovered += 1;
          continue;
        }

        if (node.kind === "agent_review" || node.kind === "agent_acceptance") {
          await this.startQualityAgent(task.id, node, true);
          this.store.addActivity(task.id, "workflow.recovered", { nodeId: node.id, strategy: "restart_quality_check", recoveryCount });
          recovered += 1;
          continue;
        }

        if (node.kind === "knowledge_review") {
          await this.startKnowledgeAgent(task.id, node, true);
          this.store.addActivity(task.id, "workflow.recovered", { nodeId: node.id, strategy: "restart_knowledge_review", recoveryCount });
          recovered += 1;
          continue;
        }

        const originalPrompt = String(latestTurnStarted?.payload.prompt ?? node.prompt ?? "继续当前节点");
        const staleInteraction = task.interactions.some((interaction) => interaction.sessionId === node.sessionId && interaction.status === "stale");
        const recoveryPrompt = `AgentDesk 在当前节点执行期间意外退出，现在需要恢复工作。\n\n请先检查工作区现状、git diff、已有测试结果和材料，不要重复已经完成的修改；继续完成尚未完成的部分。${staleInteraction ? "上一次退出时正在等待用户回答，原请求已失效；如果仍需要该信息，请重新提出问题。" : ""}\n\n退出前的节点指令：\n${originalPrompt}`;
        const mode = node.kind === "requirement_analysis" ? "requirements" : "development";
        const session = node.sessionId
          ? this.orchestrator.resumeSession(task.id, node.sessionId, recoveryPrompt, mode)
          : this.orchestrator.start(task.id, { prompt: recoveryPrompt, mode });
        this.store.updateWorkflowNode(task.id, node.id, { sessionId: session.id });
        this.store.addActivity(task.id, "workflow.recovered", {
          nodeId: node.id,
          strategy: session.id === node.sessionId ? "resume_provider_session" : "start_recovery_session",
          previousSessionId: node.sessionId,
          sessionId: session.id,
          recoveryCount,
          staleInteraction,
        });
        recovered += 1;
      } catch (error) {
        this.markWorkflowFailure(task.id, error);
        this.store.addActivity(task.id, "workflow.recovery_failed", {
          nodeId: node.id,
          recoveryCount,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return recovered;
  }

  async start(taskId: string, prompt: string) {
    const task = this.requireTask(taskId);
    let workflow = this.requireWorkflow(taskId);
    const development = workflow.nodes.find((node) => node.kind === "development");
    if (!development) throw new Error("工作流缺少开发节点");
    if (!task.workspacePath) throw new Error("请先准备工作区");
    if (workflow.status === "completed" || development.status === "succeeded") {
      const nodes = workflow.nodes.map((node) => ({
        ...node,
        status: "pending" as const,
        sessionId: node.kind === "development" ? node.sessionId : undefined,
        startedAt: undefined,
        completedAt: undefined,
        output: undefined,
      }));
      this.store.updateWorkflow(taskId, { status: "idle", currentNodeId: undefined, nodes });
      workflow = this.requireWorkflow(taskId);
    }
    const first = workflow.nodes[0];
    if (!first) throw new Error("工作流没有可执行节点");
    if (first.kind === "requirement_analysis") {
      await this.startRequirementAgent(taskId, first, prompt);
    } else if (first.kind === "development") {
      await this.startDevelopment(taskId, first, prompt);
    } else {
      throw new Error("工作流必须从需求分析或开发节点开始");
    }
    return this.store.getWorkflow(taskId)!;
  }

  private async startRequirementAgent(taskId: string, node: WorkflowNodeRun, instruction: string) {
    const task = this.requireTask(taskId);
    this.store.updateWorkflow(taskId, { status: "running", currentNodeId: node.id });
    this.store.updateWorkflowNode(taskId, node.id, {
      status: "running",
      attempt: node.attempt + 1,
      startedAt: isoNow(),
      completedAt: undefined,
    });
    this.store.updateTask(taskId, { status: "defining_requirements" });
    const materialManifest = task.materials.length > 0
      ? task.materials.map((material, index) => `${index + 1}. materials/${material.name}（${material.kind}，材料 ID：${material.id}）`).join("\n")
      : "（没有上传材料，仅依据任务描述和本轮说明）";
    const prompt = `你是独立的需求分析 Agent。你的唯一职责是把原始输入整理成可开发、可审查、可验收的需求基线；不得修改业务代码或原始材料。

必须逐一阅读下面清单中的全部材料，不得只根据文件名推断内容：
${materialManifest}

识别材料之间的冲突、歧义、缺失条件和范围边界。不要自行补全会实质改变方案的信息，统一放入“待确认问题”。

输出一份完整 Markdown 需求规格，严格包含以下章节：
1. 背景与目标
2. 用户与使用场景
3. 范围（明确包含与不包含）
4. 功能需求（使用 FR-001 格式连续编号；每条标注来源材料）
5. 业务规则与边界条件
6. 非功能要求
7. 上下游依赖
8. 验收条件（使用 AC-001 格式连续编号；每条关联一个或多个 FR）
9. 需求追踪矩阵（来源材料 → FR → AC）
10. 材料覆盖表（逐份列出材料、提取的要求、关联 FR；无有效要求也必须说明原因）
11. 风险与待确认问题
12. 需求理解摘要

完整性规则：材料覆盖表必须包含上述每一份材料；每个 FR 必须至少关联一个来源和一个 AC；无法确认的内容不得写成确定需求。只输出完整需求规格，不要输出分析过程。

用户本轮说明：
${instruction}`;
    const session = this.orchestrator.start(task.id, { prompt, mode: "requirements" });
    this.store.updateWorkflowNode(taskId, node.id, { sessionId: session.id });
  }

  private async startDevelopment(taskId: string, node: WorkflowNodeRun, prompt: string) {
    const task = this.requireTask(taskId);
    await this.createCheckpoint(task, node.id);
    this.store.updateWorkflow(taskId, { status: "running", currentNodeId: node.id });
    this.store.updateWorkflowNode(taskId, node.id, {
      status: "running",
      attempt: node.attempt + 1,
      startedAt: isoNow(),
      completedAt: undefined,
    });
    const session = node.sessionId
      ? this.orchestrator.resumeSession(taskId, node.sessionId, prompt)
      : this.orchestrator.start(taskId, { prompt, mode: "development" });
    this.store.updateWorkflowNode(taskId, node.id, { sessionId: session.id });
  }

  async requestChanges(
    taskId: string,
    feedback: string,
    options: { automatic?: boolean; sourceNodeId?: string } = {},
  ) {
    const workflow = this.requireWorkflow(taskId);
    const current = workflow.nodes.find((node) => node.id === workflow.currentNodeId);
    if (current?.kind === "human_requirement_approval" && current.status === "waiting_user") {
      const requirement = workflow.nodes.find((node) => node.kind === "requirement_analysis");
      if (!requirement?.sessionId) throw new Error("没有可以继续澄清的需求分析会话");
      this.store.updateWorkflowNode(taskId, current.id, {
        status: "changes_requested",
        completedAt: isoNow(),
        output: { feedback },
      });
      this.store.addWorkflowArtifact(taskId, current.id, {
        kind: "feedback",
        title: "需求修改意见",
        content: feedback,
        metadata: { requirementSessionId: requirement.sessionId },
      });
      this.store.addActivity(taskId, "changes.requested", { nodeId: current.id, feedback, phase: "requirements" });
      this.store.updateWorkflow(taskId, { status: "running", currentNodeId: requirement.id });
      this.store.updateWorkflowNode(taskId, requirement.id, {
        status: "running",
        attempt: requirement.attempt + 1,
        startedAt: isoNow(),
        completedAt: undefined,
      });
      this.store.updateTask(taskId, { status: "defining_requirements" });
      this.orchestrator.resumeSession(
        taskId,
        requirement.sessionId,
        `用户没有确认当前需求规格。请根据以下意见重新阅读材料并生成一份完整的新版本需求规格，不要只输出局部修改：\n\n${feedback}`,
      );
      return this.store.getWorkflow(taskId)!;
    }
    const development = workflow.nodes.find((node) => node.kind === "development");
    if (!development?.sessionId) throw new Error("没有可以打回的开发会话");
    if (current && current.kind !== "development" && current.status === "waiting_user") {
      this.store.updateWorkflowNode(taskId, current.id, {
        status: "changes_requested",
        completedAt: isoNow(),
        output: { feedback },
      });
    }
    this.store.addWorkflowArtifact(taskId, current?.id ?? development.id, {
      kind: "feedback",
      title: options.automatic ? "验收失败 · 自动打回修改" : "打回修改意见",
      content: feedback,
      metadata: {
        developmentSessionId: development.sessionId,
        automatic: options.automatic === true,
        sourceNodeId: options.sourceNodeId,
      },
    });
    this.store.addActivity(taskId, "changes.requested", {
      nodeId: current?.id,
      feedback,
      automatic: options.automatic === true,
    });
    this.store.updateWorkflow(taskId, { status: "running", currentNodeId: development.id });
    this.store.updateWorkflowNode(taskId, development.id, {
      status: "running",
      attempt: development.attempt + 1,
      startedAt: isoNow(),
      completedAt: undefined,
    });
    this.store.updateTask(taskId, { status: "running" });
    this.store.updateSession(development.sessionId, { status: "running" });
    const resumedSession = this.orchestrator.resumeSession(
      taskId,
      development.sessionId,
      `${options.automatic ? "独立审查或验收未通过，系统已自动将问题退回。" : "审核或验收未通过。"}请阅读以下修改意见，逐项修复 blocking 问题，运行相关回归测试，并说明每项问题的处理结果：\n\n${feedback}`,
    );
    this.store.updateWorkflowNode(taskId, development.id, { sessionId: resumedSession.id });
    return this.store.getWorkflow(taskId)!;
  }

  async approve(taskId: string, note?: string) {
    const workflow = this.requireWorkflow(taskId);
    const node = workflow.nodes.find((item) => item.id === workflow.currentNodeId);
    if (!node || !["human_review", "human_requirement_approval"].includes(node.kind) || node.status !== "waiting_user") {
      throw new Error("当前没有等待人工审核的节点");
    }
    const requirementApproval = node.kind === "human_requirement_approval";
    this.store.updateWorkflowNode(taskId, node.id, {
      status: "succeeded",
      completedAt: isoNow(),
      output: { approved: true, note },
    });
    if (requirementApproval) {
      const requirement = [...workflow.artifacts].reverse().find((artifact) => artifact.kind === "requirement");
      if (!requirement) throw new Error("没有可确认的需求规格");
      this.store.updateWorkflowArtifact(requirement.id, {
        title: requirement.title.replace("待确认", "已确认"),
        metadata: { ...requirement.metadata, approved: true, approvedAt: isoNow(), note },
      });
      this.store.addActivity(taskId, "review.approved", { nodeId: node.id, note, phase: "requirements", requirementArtifactId: requirement.id });
    } else {
      this.store.addWorkflowArtifact(taskId, node.id, {
        kind: "review",
        title: "人工审核通过",
        content: note,
        metadata: { approved: true },
      });
      this.store.addActivity(taskId, "review.approved", { nodeId: node.id, note });
    }
    try {
      await this.advance(taskId, node.id);
    } catch (error) {
      this.markWorkflowFailure(taskId, error);
      throw error;
    }
    return this.store.getWorkflow(taskId)!;
  }

  async retryCurrentQualityNode(taskId: string) {
    const workflow = this.requireWorkflow(taskId);
    const node = workflow.nodes.find((item) => item.id === workflow.currentNodeId);
    if (!node || !["agent_review", "agent_acceptance"].includes(node.kind) || !["failed", "waiting_user"].includes(node.status)) {
      throw new Error("当前没有可以重新执行的审查或验收节点");
    }
    this.store.updateWorkflow(taskId, { status: "running", currentNodeId: node.id });
    await this.startQualityAgent(taskId, node);
    return this.store.getWorkflow(taskId)!;
  }

  async retryFailedNodeRecovery(taskId: string) {
    const workflow = this.requireWorkflow(taskId);
    const node = workflow.nodes.find((item) => item.id === workflow.currentNodeId);
    if (!node || workflow.status !== "failed" || node.status !== "failed") {
      throw new Error("当前没有恢复失败的工作流节点");
    }
    this.store.updateWorkflowNode(taskId, node.id, {
      status: "interrupted",
      completedAt: undefined,
      output: { ...node.output, manualRecoveryRequestedAt: isoNow() },
    });
    this.store.updateWorkflow(taskId, { status: "interrupted", currentNodeId: node.id });
    this.store.updateTask(taskId, { status: "interrupted" });
    await this.recoverInterruptedWorkflows();
    return this.store.getWorkflow(taskId)!;
  }

  async recoverAutomaticQualityReworks() {
    let recovered = 0;
    for (const task of this.store.listTasks()) {
      const workflow = task.workflow;
      if (!workflow || workflow.status !== "changes_requested") continue;
      const node = workflow.nodes.find((item) => item.id === workflow.currentNodeId);
      if (!node || !["agent_review", "agent_acceptance"].includes(node.kind) || node.status !== "failed") continue;
      if (node.attempt > MAX_AUTOMATIC_QUALITY_REWORKS) continue;
      const reportKind = node.kind === "agent_review" ? "review" : "acceptance";
      const report = [...workflow.artifacts].reverse().find((artifact) => artifact.nodeId === node.id && artifact.kind === reportKind);
      if (String(report?.metadata.verdict ?? "") !== "FAIL") continue;
      await this.requestChanges(
        task.id,
        `${node.kind === "agent_review" ? "代码审查" : "目标验收"}第 ${node.attempt} 次未通过，系统恢复后自动打回修改。\n\n${report?.content ?? report?.metadata.summary ?? "请根据验收报告修复问题。"}`,
        { automatic: true, sourceNodeId: node.id },
      );
      recovered += 1;
    }
    return recovered;
  }

  async discard(taskId: string) {
    const task = this.requireTask(taskId);
    const workflow = this.requireWorkflow(taskId);
    const checkpoint = [...workflow.artifacts].reverse().find((item) => item.kind === "checkpoint");
    const targets = (checkpoint?.metadata.targets ?? []) as Array<{ path: string; commit: string }>;
    if (!targets.length) throw new Error("没有可用的 Git 检查点");
    for (const target of targets) {
      const status = await this.gitStatus(target.path);
      if (status) {
        await execFileAsync("git", ["-C", target.path, "stash", "push", "-u", "-m", `agentdesk-backup-${Date.now()}`], { timeout: 60_000 });
      }
      await execFileAsync("git", ["-C", target.path, "reset", "--hard", target.commit], { timeout: 60_000 });
      await execFileAsync("git", ["-C", target.path, "clean", "-fd"], { timeout: 60_000 });
    }
    this.store.updateWorkflow(taskId, { status: "completed" });
    this.store.updateTask(taskId, { status: "discarded" });
    this.store.addWorkflowArtifact(taskId, workflow.currentNodeId ?? "development", {
      kind: "checkpoint",
      title: "已回退到开发前检查点",
      content: "回退前的未提交修改已保存在 Git stash 中，可人工恢复。",
      metadata: { targets, recoverable: true },
    });
    this.store.addActivity(taskId, "workflow.discarded", { recoverable: true });
    return this.store.getWorkflow(taskId)!;
  }

  async diff(taskId: string) {
    const task = this.requireTask(taskId);
    const targets = await this.gitTargets(task, true);
    return Promise.all(targets.map(async (target) => {
      const workflow = this.store.getWorkflow(taskId);
      const checkpointTargets = [...(workflow?.artifacts ?? [])].reverse()
        .find((artifact) => artifact.kind === "checkpoint")?.metadata.targets as Array<{ path: string; commit: string }> | undefined;
      const repositoryBase = task.repositories.find((repo) => path.resolve(repo.worktreePath ?? repo.sourcePath) === path.resolve(target.path))?.baseCommit;
      const checkpointBase = checkpointTargets?.find((item) => path.resolve(item.path) === path.resolve(target.path))?.commit;
      const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const baseCommit = checkpointBase ?? repositoryBase ?? (task.sessions.length > 0 ? emptyTree : undefined);
      const rawStatus = (await execFileAsync("git", ["-C", target.path, "status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
      const workingEntries = parsePorcelainStatus(rawStatus);
      const workingPaths = new Set(workingEntries.map((entry) => entry.path));
      const committedEntries = baseCommit
        ? parseNameStatus((await execFileAsync("git", ["-C", target.path, "diff", "--name-status", "-z", baseCommit, "--", "."], { timeout: 30_000 })).stdout)
        : [];
      const entryMap = new Map(committedEntries.map((entry) => [entry.path, entry]));
      for (const entry of workingEntries) entryMap.set(entry.path, entry);
      const entries = [...entryMap.values()].filter((entry) => isReviewablePath(entry.path)).slice(0, 200);
      const files = await Promise.all(entries.map(async (entry): Promise<CodeDiffFile> => {
        if (entry.code === "??") return this.untrackedDiff(target.path, entry.path);
        const output = (await execFileAsync(
          "git",
          ["-C", target.path, "diff", baseCommit ?? "HEAD", "--no-ext-diff", "--", entry.path],
          { timeout: 30_000 },
        )).stdout;
        const limited = output.slice(0, 1024 * 1024);
        return {
          path: entry.path,
          oldPath: entry.oldPath,
          status: gitStatusName(entry.code),
          staged: workingPaths.has(entry.path) && entry.code[0] !== " " && entry.code[0] !== "?",
          diff: limited,
          binary: /Binary files .* differ|GIT binary patch/.test(output),
          truncated: output.length > limited.length,
        };
      }));
      const counts = countDiffLines(files);
      return {
        path: target.path,
        files,
        ...counts,
      };
    }));
  }

  private async untrackedDiff(root: string, relative: string): Promise<CodeDiffFile> {
    const absolute = path.resolve(root, relative);
    const resolvedRoot = path.resolve(root);
    if (absolute !== resolvedRoot && !absolute.startsWith(resolvedRoot + path.sep)) {
      return { path: relative, status: "unknown", staged: false, diff: "" };
    }
    try {
      const content = await fs.readFile(absolute);
      if (content.includes(0)) return { path: relative, status: "added", staged: false, diff: "", binary: true };
      const text = content.toString("utf8");
      const limited = text.slice(0, 512 * 1024);
      const lines = limited ? limited.replace(/\r?\n$/, "").split(/\r?\n/) : [];
      return {
        path: relative,
        status: "added",
        staged: false,
        diff: lines.length
          ? `--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`
          : "",
        truncated: text.length > limited.length,
      };
    } catch {
      return { path: relative, status: "unknown", staged: false, diff: "" };
    }
  }

  private async onTurnFinished(event: AgentEvent) {
    const match = this.store.findWorkflowNodeBySession(event.sessionId);
    if (!match || this.processing.has(event.sessionId)) return;
    this.processing.add(event.sessionId);
    try {
      const workflow = this.requireWorkflow(match.taskId);
      const node = workflow.nodes.find((item) => item.id === match.node.id);
      if (!node || node.status !== "running") return;
      if (event.type === "turn.failed") {
        this.store.updateWorkflowNode(match.taskId, node.id, {
          status: "failed",
          completedAt: isoNow(),
          output: { error: event.payload.error },
        });
        this.store.updateWorkflow(match.taskId, { status: "failed", currentNodeId: node.id });
        return;
      }

      const output = this.finalAgentMessage(event.sessionId);
      if (node.kind === "requirement_analysis") {
        const task = this.requireTask(match.taskId);
        const version = workflow.artifacts.filter((artifact) => artifact.kind === "requirement").length + 1;
        const generatedDir = path.join(task.workspacePath!, "generated");
        await fs.mkdir(generatedDir, { recursive: true });
        const documentPath = path.join(generatedDir, `requirements-v${version}.md`);
        await fs.writeFile(documentPath, output, "utf8");
        const artifact = this.store.addWorkflowArtifact(match.taskId, node.id, {
          kind: "requirement",
          title: `需求规格 v${version} · 待确认`,
          content: output,
          path: documentPath,
          metadata: {
            version,
            approved: false,
            sourceMaterials: task.materials.map((material) => ({ id: material.id, name: material.name, createdAt: material.createdAt })),
            sessionId: event.sessionId,
          },
        });
        this.store.addActivity(match.taskId, "requirement.generated", {
          artifactId: artifact.id,
          nodeId: node.id,
          version,
          title: artifact.title,
          path: documentPath,
          sourceMaterialCount: task.materials.length,
        });
        this.store.updateWorkflowNode(match.taskId, node.id, {
          status: "succeeded",
          completedAt: isoNow(),
          output: { version, path: documentPath, summary: output },
        });
      } else if (node.kind === "agent_review" || node.kind === "agent_acceptance") {
        const result = parseQualityResult(output);
        const passed = result.verdict === "PASS" || result.verdict === "PASS_WITH_WARNINGS";
        const automaticRework = result.verdict === "FAIL" && node.attempt <= MAX_AUTOMATIC_QUALITY_REWORKS;
        const commands = this.store.sessionEvents(event.sessionId)
          .filter((item) => item.type === "command.completed")
          .map((item) => item.payload.item)
          .slice(-20);
        this.store.addWorkflowArtifact(match.taskId, node.id, {
          kind: node.kind === "agent_review" ? "review" : "acceptance",
          title: node.kind === "agent_review" ? "Agent Code Review 报告" : "Agent 验收报告",
          content: output,
          metadata: {
            passed,
            verdict: result.verdict,
            summary: result.summary,
            findings: result.findings,
            commands,
            automaticRework,
            automaticReworkAttempt: automaticRework ? node.attempt : undefined,
            automaticReworkLimit: MAX_AUTOMATIC_QUALITY_REWORKS,
          },
        });
        this.store.updateWorkflowNode(match.taskId, node.id, {
          status: result.verdict === "INCONCLUSIVE" ? "waiting_user" : passed ? "succeeded" : "failed",
          completedAt: isoNow(),
          output: { passed, verdict: result.verdict, summary: result.summary, findings: result.findings, report: output },
        });
        if (result.verdict === "INCONCLUSIVE") {
          this.store.updateWorkflow(match.taskId, { status: "waiting_user", currentNodeId: node.id });
          this.store.updateTask(match.taskId, { status: "pending_review" });
          return;
        }
        if (!passed) {
          if (automaticRework) {
            const phase = node.kind === "agent_review" ? "代码审查" : "目标验收";
            const findings = result.findings.length
              ? result.findings.map((finding) => [
                  `- [${finding.id}] ${finding.title}`,
                  finding.requirementId ? `  需求：${finding.requirementId}` : "",
                  finding.acceptanceId ? `  验收项：${finding.acceptanceId}` : "",
                  finding.expected ? `  预期：${finding.expected}` : "",
                  finding.actual ? `  实际：${finding.actual}` : "",
                  finding.reproductionSteps.length ? `  复现：${finding.reproductionSteps.join(" → ")}` : "",
                  finding.evidence?.output ? `  证据：${finding.evidence.output}` : "",
                  finding.suggestedDirection ? `  建议方向：${finding.suggestedDirection}` : "",
                ].filter(Boolean).join("\n")).join("\n")
              : "验收 Agent 未返回结构化问题，请结合原始报告定位失败原因。";
            await this.requestChanges(
              match.taskId,
              `${phase}第 ${node.attempt} 次未通过，系统自动打回修改。\n\n结论：${result.summary}\n\n问题清单：\n${findings}\n\n原始报告：\n${output}`,
              { automatic: true, sourceNodeId: node.id },
            );
            return;
          }
          this.store.updateWorkflow(match.taskId, { status: "changes_requested", currentNodeId: node.id });
          this.store.updateTask(match.taskId, { status: "changes_requested" });
          return;
        }
      } else if (node.kind === "knowledge_review") {
        const repositories = await this.diff(match.taskId);
        const before = (node.output?.nonKnowledgeSnapshot ?? {}) as Record<string, string>;
        const after = nonKnowledgeSnapshot(repositories);
        const protectedFilesUnchanged = JSON.stringify(before) === JSON.stringify(after);
        const knowledgeFiles = repositories.flatMap((repository) => repository.files
          .filter((file) => isKnowledgePath(file.path))
          .map((file) => ({ repository: repository.path, path: file.path, status: file.status })));
        this.store.addWorkflowArtifact(match.taskId, node.id, {
          kind: "knowledge",
          title: protectedFilesUnchanged ? "需求知识审查报告" : "需求知识审查越界",
          content: output,
          metadata: {
            contextPath: node.output?.contextPath,
            knowledgeFiles,
            protectedFilesUnchanged,
            sessionId: event.sessionId,
          },
        });
        if (!protectedFilesUnchanged) {
          this.store.updateWorkflowNode(match.taskId, node.id, {
            status: "failed",
            completedAt: isoNow(),
            output: { ...node.output, summary: output, knowledgeFiles, protectedFilesUnchanged },
          });
          this.store.updateWorkflow(match.taskId, { status: "failed", currentNodeId: node.id });
          this.store.updateTask(match.taskId, { status: "failed" });
          return;
        }
        this.store.updateWorkflowNode(match.taskId, node.id, {
          status: "succeeded",
          completedAt: isoNow(),
          output: { ...node.output, summary: output, knowledgeFiles, protectedFilesUnchanged },
        });
      } else {
        this.store.updateWorkflowNode(match.taskId, node.id, {
          status: "succeeded",
          completedAt: isoNow(),
          output: { summary: output },
        });
      }
      await this.advance(match.taskId, node.id);
    } catch (error) {
      this.markWorkflowFailure(match.taskId, error);
    } finally {
      this.processing.delete(event.sessionId);
    }
  }

  private async advance(taskId: string, completedNodeId: string) {
    const workflow = this.requireWorkflow(taskId);
    const index = workflow.nodes.findIndex((node) => node.id === completedNodeId);
    const next = workflow.nodes[index + 1];
    if (!next) {
      this.store.updateWorkflow(taskId, { status: "completed" });
      this.store.updateTask(taskId, { status: "completed" });
      return;
    }
    this.store.updateWorkflow(taskId, { status: "running", currentNodeId: next.id });
    if (next.kind === "human_review") {
      this.store.updateWorkflowNode(taskId, next.id, {
        status: "waiting_user",
        attempt: next.attempt + 1,
        startedAt: isoNow(),
      });
      this.store.updateWorkflow(taskId, { status: "waiting_user", currentNodeId: next.id });
      this.store.updateTask(taskId, { status: "pending_review" });
      return;
    }
    if (next.kind === "human_requirement_approval") {
      this.store.updateWorkflowNode(taskId, next.id, {
        status: "waiting_user",
        attempt: next.attempt + 1,
        startedAt: isoNow(),
        completedAt: undefined,
      });
      this.store.updateWorkflow(taskId, { status: "waiting_user", currentNodeId: next.id });
      this.store.updateTask(taskId, { status: "pending_requirement_confirmation" });
      return;
    }
    if (next.kind === "commit") {
      await this.commit(taskId, next);
      return;
    }
    if (next.kind === "agent_review" || next.kind === "agent_acceptance") {
      await this.startQualityAgent(taskId, next);
      return;
    }
    if (next.kind === "knowledge_review") {
      await this.startKnowledgeAgent(taskId, next);
      return;
    }
    if (next.kind === "development") {
      const requirement = [...workflow.artifacts].reverse().find((artifact) => artifact.kind === "requirement" && artifact.metadata.approved === true);
      await this.startDevelopment(
        taskId,
        next,
        `需求规格已经人工确认。请严格依据 ${requirement?.path ?? "generated 目录中的最新需求规格"} 实施开发。逐条满足 FR 和 AC 编号，完成后运行相关测试并说明每条验收条件的验证结果。`,
      );
    }
  }

  private async startQualityAgent(taskId: string, node: WorkflowNodeRun, recovering = false) {
    const task = this.requireTask(taskId);
    const workflow = this.requireWorkflow(taskId);
    const isReview = node.kind === "agent_review";
    const approvedRequirement = [...workflow.artifacts].reverse().find((artifact) => artifact.kind === "requirement" && artifact.metadata.approved === true);
    const resultContract = `请在报告最后输出一个 JSON 代码块，严格使用以下结构：
{
  "verdict": "PASS | PASS_WITH_WARNINGS | FAIL | INCONCLUSIVE",
  "summary": "结论摘要",
  "findings": [{
    "id": "AF-001",
    "requirementId": "FR-001",
    "acceptanceId": "AC-001",
    "severity": "blocking | warning | info",
    "title": "问题标题",
    "expected": "预期结果",
    "actual": "实际结果",
    "reproductionSteps": ["复现步骤"],
    "evidence": { "command": "执行命令", "output": "关键输出", "file": "相关文件" },
    "suggestedDirection": "建议排查方向，不要直接修改代码"
  }]
}
只有全部阻塞性要求通过时才能 PASS；环境或权限导致无法验证时必须返回 INCONCLUSIVE，不能误判为代码失败。`;
    const prompt = isReview
      ? `你是独立 Code Reviewer。只读检查当前工作区，不得修改文件。依据已确认需求和 materials 中的原始材料审查正确性、回归风险、安全性、测试和可维护性。每个问题必须提供文件位置、影响、证据和建议排查方向。\n\n${resultContract}`
      : `你是独立验收 Agent。只读检查代码，不得修改业务文件；可以运行不会改变业务代码的测试和验证命令。逐条依据验收目标验证，并为失败项提供需求编号、复现步骤、预期与实际结果、命令输出、文件或页面证据。不要只返回通过或拒绝。\n\n已确认需求规格：\n${approvedRequirement?.path ?? "未生成，以 materials 中的需求材料为准"}\n\n验收目标：\n${workflow.acceptanceCriteria || "逐条依据已确认需求规格和需求材料验证功能确实完成"}\n\n${resultContract}`;
    this.store.updateWorkflowNode(taskId, node.id, {
      status: "running",
      attempt: node.attempt + (recovering ? 0 : 1),
      startedAt: recovering ? node.startedAt ?? isoNow() : isoNow(),
    });
    const session = this.orchestrator.start(task.id, {
      prompt: `${prompt}\n\n开发结果 Diff 可通过 git diff 查看。`,
      mode: isReview ? "review" : "acceptance",
    });
    this.store.updateWorkflowNode(taskId, node.id, { sessionId: session.id });
  }

  private async startKnowledgeAgent(taskId: string, node: WorkflowNodeRun, recovering = false) {
    const task = this.requireTask(taskId);
    const existingContextPath = typeof node.output?.contextPath === "string" ? node.output.contextPath : undefined;
    const prepared = recovering && existingContextPath
      ? {
          contextPath: existingContextPath,
          targets: Array.isArray(node.output?.targets) ? node.output.targets as string[] : [],
          snapshot: (node.output?.nonKnowledgeSnapshot ?? {}) as Record<string, string>,
        }
      : await this.prepareKnowledgeReview(taskId);
    this.store.updateWorkflow(taskId, { status: "running", currentNodeId: node.id });
    this.store.updateWorkflowNode(taskId, node.id, {
      status: "running",
      attempt: node.attempt + (recovering ? 0 : 1),
      startedAt: recovering ? node.startedAt ?? isoNow() : isoNow(),
      completedAt: undefined,
      output: {
        ...node.output,
        contextPath: prepared.contextPath,
        targets: prepared.targets,
        nonKnowledgeSnapshot: prepared.snapshot,
      },
    });
    this.store.updateTask(taskId, { status: "verifying" });
    const targetList = prepared.targets.map((target) => `- ${target}/knowledge`).join("\n");
    const prompt = `你是独立的需求知识审查 Agent，采用 LLM Wiki 的“原始证据 → 主题 Wiki → 维护规则”三层模型。

完整证据包：${prepared.contextPath}

允许写入的知识目录：
${targetList || "- 当前工作区/knowledge"}

必须逐一阅读证据包引用的原始材料和已确认需求，并检查当前 Git diff。把本次需求真正新增或修正的稳定知识合并进已有主题页面；不要为每个需求机械创建孤立总结。业务背景、规则、边界、架构决策、开发惯例和踩坑经验应分别归入适合的主题。

只允许修改上述 knowledge/ 目录。证据不足的内容标记为 candidate；相互冲突的来源必须保留冲突和来源，不得擅自裁决。每个修改页面都要保留来源、状态、适用范围和最后验证日期。完成后检查链接、重复页面和孤立页面，并在最终报告中列出读取证据、修改页面、未沉淀内容及原因。`;
    const session = this.orchestrator.start(task.id, { prompt, mode: "knowledge" });
    this.store.updateWorkflowNode(taskId, node.id, { sessionId: session.id });
  }

  private async prepareKnowledgeReview(taskId: string) {
    const task = this.requireTask(taskId);
    const workflow = this.requireWorkflow(taskId);
    const targets = (await this.gitTargets(task, true)).map((target) => target.path);
    await Promise.all(targets.map((target) => this.ensureKnowledgeScaffold(target)));
    const repositories = await this.diff(taskId);
    const relevantEvents = this.store.events(taskId).filter((event) =>
      event.type === "user.followup" || event.type === "interaction.resolved",
    );
    const evidenceArtifacts = workflow.artifacts.filter((artifact) =>
      ["requirement", "review", "acceptance", "feedback"].includes(artifact.kind),
    );
    let diffBudget = 1024 * 1024;
    const diffSections: string[] = [];
    for (const repository of repositories) {
      diffSections.push(`## 仓库 ${repository.path}`);
      for (const file of repository.files) {
        if (diffBudget <= 0) break;
        const excerpt = file.diff.slice(0, diffBudget);
        diffBudget -= excerpt.length;
        diffSections.push(`### ${file.status}: ${file.path}\n\n\`\`\`diff\n${excerpt}\n\`\`\``);
      }
    }
    const content = [
      "# 需求知识审查证据包",
      `- 任务 ID：${task.id}`,
      `- 任务标题：${task.title}`,
      `- 生成时间：${isoNow()}`,
      "",
      "## 原始任务说明",
      task.description || "（无额外任务描述）",
      "",
      "## 原始材料清单",
      ...(task.materials.length ? task.materials.map((material) =>
        `- materials/${material.name}（${material.kind}，${material.createdAt}）`,
      ) : ["- 无"]),
      "",
      "## 用户补充与交互确认",
      ...(relevantEvents.length ? relevantEvents.map((event) =>
        `### ${event.createdAt} · ${event.type}\n\n${JSON.stringify(event.payload, null, 2)}`,
      ) : ["- 无"]),
      "",
      "## 需求、反馈与验收产物",
      ...(evidenceArtifacts.length ? evidenceArtifacts.map((artifact) =>
        `### ${artifact.title}\n\n${(artifact.content ?? JSON.stringify(artifact.metadata, null, 2)).slice(0, 200_000)}`,
      ) : ["- 无"]),
      "",
      "## 开发结果 Git Diff",
      ...diffSections,
      diffBudget <= 0 ? "\n> Diff 总量超过 1 MiB，证据包已截断；请直接在仓库中运行 git diff 查看剩余内容。" : "",
      "",
    ].join("\n");
    const generatedDir = path.join(task.workspacePath!, "generated");
    await fs.mkdir(generatedDir, { recursive: true });
    const contextPath = path.join(generatedDir, "knowledge-review-context.md");
    await fs.writeFile(contextPath, content, "utf8");
    return { contextPath, targets, snapshot: nonKnowledgeSnapshot(repositories) };
  }

  private async ensureKnowledgeScaffold(target: string) {
    const knowledgeDir = path.join(target, "knowledge");
    await fs.mkdir(path.join(knowledgeDir, "wiki"), { recursive: true });
    const writeIfMissing = async (filePath: string, content: string) => {
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, content, "utf8");
      }
    };
    await writeIfMissing(path.join(knowledgeDir, "README.md"), `# 项目知识库

本目录采用 LLM Wiki 模型：主题化 Markdown 页面是正式知识，检索索引只是可重建的派生数据。

- \`wiki/\`：经过归纳的业务、架构与工程知识。
- \`index.md\`：主题导航和入口。
- \`AGENTS.md\`：Agent 维护约束。
`);
    await writeIfMissing(path.join(knowledgeDir, "index.md"), `# 知识导航

> 由需求知识审查 Agent 按主题维护。新增页面后必须从这里或其他主题页面建立链接。
`);
    await writeIfMissing(path.join(knowledgeDir, "AGENTS.md"), `# LLM Wiki 维护规则

- 主题页面是知识本体，不以数据库切片或逐需求总结代替。
- 优先更新已有主题；只有出现独立、可复用主题时才新增页面。
- 稳定结论必须有来源、适用范围、状态和最后验证日期。
- 未充分验证的结论标记为 candidate；冲突信息必须同时保留来源。
- 不得把临时实现细节、聊天过程或未经验证的推测写成正式规则。
- 新页面必须加入 index.md 或由其他页面链接，避免孤立页面。
`);
  }

  private async commit(taskId: string, node: WorkflowNodeRun) {
    const task = this.requireTask(taskId);
    const targets = await this.gitTargets(task, true);
    const commits: Array<{ path: string; commit?: string; skipped?: boolean }> = [];
    for (const target of targets) {
      const status = await this.gitStatus(target.path);
      if (!status) {
        commits.push({ path: target.path, skipped: true });
        continue;
      }
      await execFileAsync("git", ["-C", target.path, "add", "-A"], { timeout: 30_000 });
      await execFileAsync("git", ["-C", target.path, "commit", "-m", `AgentDesk: ${task.title}`], { timeout: 60_000 });
      const commit = (await execFileAsync("git", ["-C", target.path, "rev-parse", "HEAD"])).stdout.trim();
      commits.push({ path: target.path, commit });
    }
    this.store.addWorkflowArtifact(taskId, node.id, {
      kind: "commit",
      title: "本地 Git 提交",
      content: commits.map((item) => `${item.path}: ${item.commit ?? "无变更"}`).join("\n"),
      metadata: { commits },
    });
    this.store.updateWorkflowNode(taskId, node.id, {
      status: "succeeded",
      attempt: node.attempt + 1,
      startedAt: isoNow(),
      completedAt: isoNow(),
      output: { commits },
    });
    await this.advance(taskId, node.id);
  }

  private async createCheckpoint(task: Task, nodeId: string) {
    const targets = await this.gitTargets(task, true);
    const checkpoints: Array<{ path: string; commit: string }> = [];
    for (const target of targets) {
      const commit = (await execFileAsync("git", ["-C", target.path, "rev-parse", "HEAD"])).stdout.trim();
      checkpoints.push({ path: target.path, commit });
    }
    this.store.addWorkflowArtifact(task.id, nodeId, {
      kind: "checkpoint",
      title: "开发前 Git 检查点",
      content: checkpoints.map((item) => `${item.path}: ${item.commit}`).join("\n"),
      metadata: { targets: checkpoints },
    });
  }

  private async gitTargets(task: Task, initializeWorkspace: boolean) {
    const paths = task.repositories.map((repo) => repo.worktreePath ?? repo.sourcePath);
    if (paths.length) return paths.map((item) => ({ path: item }));
    if (!task.workspacePath) throw new Error("任务工作区不存在");
    if (initializeWorkspace) await this.ensureGit(task.workspacePath, task.title);
    return [{ path: task.workspacePath }];
  }

  private async ensureGit(cwd: string, title: string) {
    try {
      await fs.access(path.join(cwd, ".git"));
      return;
    } catch {
      // A task workspace may live inside AgentDesk's own repository. Creating the
      // local .git directory first prevents Git from accidentally using the parent repo.
      await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
      await execFileAsync("git", ["-C", cwd, "init"]);
      await execFileAsync("git", ["-C", cwd, "config", "user.name", "AgentDesk"]);
      await execFileAsync("git", ["-C", cwd, "config", "user.email", "agentdesk@local"]);
      await execFileAsync("git", ["-C", cwd, "add", "-A"]);
      await execFileAsync("git", ["-C", cwd, "commit", "-m", `AgentDesk baseline: ${title}`]);
    }
  }

  private async gitStatus(cwd: string) {
    return (await execFileAsync("git", ["-C", cwd, "status", "--porcelain=v1"])).stdout.trim();
  }

  private finalAgentMessage(sessionId: string) {
    const messages = this.store.sessionEvents(sessionId)
      .filter((event) => event.type === "message.completed")
      .map((event) => {
        const item = event.payload.item as Record<string, unknown> | undefined;
        return String(item?.text ?? event.payload.text ?? "");
      })
      .filter(Boolean);
    return messages.at(-1) ?? "Agent 未返回结构化报告。\n\nVERDICT: FAIL";
  }

  private markWorkflowFailure(taskId: string, error: unknown) {
    const workflow = this.store.getWorkflow(taskId);
    const nodeId = workflow?.currentNodeId ?? "workflow";
    const message = error instanceof Error ? error.message : String(error);
    if (workflow) {
      this.store.updateWorkflow(taskId, { status: "failed", currentNodeId: nodeId });
      const node = workflow.nodes.find((item) => item.id === nodeId);
      if (node) this.store.updateWorkflowNode(taskId, nodeId, { status: "failed", completedAt: isoNow(), output: { ...node.output, error: message } });
      this.store.addWorkflowArtifact(taskId, nodeId, {
        kind: "test",
        title: "工作流节点执行失败",
        content: message,
        metadata: {},
      });
    }
    this.store.updateTask(taskId, { status: "failed" });
  }

  private requireTask(taskId: string) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    return task;
  }

  private requireWorkflow(taskId: string) {
    const workflow = this.store.getWorkflow(taskId);
    if (!workflow) throw new Error("任务未配置工作流");
    return workflow;
  }
}
