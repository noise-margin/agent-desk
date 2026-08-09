import type {
  ActionArtifact,
  ActionRun,
  AgentEvent,
  AvailableAction,
  CodeDiffFile,
  CodeDiffFileStatus,
  ExecuteActionInput,
  Task,
  TaskAction,
} from "@agentdesk/protocol";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EventBus } from "./event-bus.js";
import { execFileAsync } from "./lib/process.js";
import { Orchestrator } from "./orchestrator.js";
import { Store } from "./store.js";

const now = () => new Date().toISOString();

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
    } else result.push({ code, path: filePath });
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

function gitStatusName(code: string): CodeDiffFileStatus {
  if (code === "??" || code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("U")) return "unmerged";
  if (code.includes("M") || code.includes("T")) return "modified";
  return "unknown";
}

function isReviewablePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  return !normalized.startsWith("materials/") && !normalized.startsWith("artifacts/")
    && !normalized.startsWith("logs/") && normalized !== "AGENTS.md" && normalized !== "task.yaml";
}

function isKnowledgePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized === "knowledge" || normalized.startsWith("knowledge/") || normalized.includes("/knowledge/");
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

const labels: Record<TaskAction, Omit<AvailableAction, "type">> = {
  generate_plan: { label: "生成开发计划", description: "让 Coding Agent 先分析需求并生成可确认的计划。" },
  revise_plan: { label: "要求更新计划", description: "根据你的意见修改当前计划。", requiresInstruction: true },
  accept_plan: { label: "采纳计划", description: "把当前计划作为后续开发上下文。", tone: "primary" },
  start_development: { label: "开始开发", description: "直接开发，或依据已经采纳的计划实施。", tone: "primary" },
  request_changes: { label: "直接打回修改", description: "不提交当前结果，恢复开发 Agent 修改。", requiresInstruction: true },
  run_code_review: { label: "Agent Code Review", description: "启动独立只读代码审查。" },
  run_acceptance: { label: "试运行并验收", description: "执行验证并展示满足验收目标的证据。" },
  checkpoint_and_continue: { label: "保存当前版本并继续", description: "先提交推送阶段成果，再增量修改。", requiresInstruction: true },
  deliver: { label: "提交并推送", description: "确认当前结果并完成最终代码交付。", tone: "primary" },
  generate_knowledge_proposal: { label: "生成知识提案", description: "基于完整过程生成知识库更新建议。" },
  revise_knowledge_proposal: { label: "修改知识提案", description: "根据意见重新生成知识更新建议。", requiresInstruction: true },
  accept_knowledge: { label: "采纳知识更新", description: "由 Agent 将已确认提案应用到知识库。", tone: "primary" },
  reject_knowledge: { label: "跳过知识更新", description: "保留提案记录，但不更新知识库。" },
  archive: { label: "归档需求", description: "关闭日常操作并保留完整历史。" },
};

export class ActionEngine {
  private readonly processing = new Set<string>();

  constructor(private readonly store: Store, private readonly events: EventBus, private readonly orchestrator: Orchestrator) {
    this.events.subscribeAll((event) => {
      if (event.type === "turn.completed" || event.type === "turn.failed") void this.onTurnFinished(event);
    });
  }

  availableActions(taskId: string): AvailableAction[] {
    const task = this.requireTask(taskId);
    const active = task.actions.find((action) => ["pending", "running"].includes(action.status));
    if (active || task.sessions.some((session) => ["starting", "running"].includes(session.status))) return [];
    let types: TaskAction[];
    if (task.status === "archived") types = [];
    else if (task.status === "closed") types = ["archive"];
    else if (task.status === "knowledge_pending") types = ["revise_knowledge_proposal", "accept_knowledge", "reject_knowledge"];
    else if (task.status === "delivered") types = ["generate_knowledge_proposal"];
    else {
      const hasDevelopment = task.artifacts.some((artifact) => artifact.kind === "development");
      const latestPlan = [...task.artifacts].reverse().find((artifact) => artifact.kind === "plan");
      if (!hasDevelopment) {
        types = latestPlan && latestPlan.metadata.status === "draft"
          ? ["revise_plan", "accept_plan", "start_development"]
          : ["generate_plan", "start_development"];
      } else {
        types = ["request_changes", "run_code_review", "run_acceptance", "checkpoint_and_continue", "deliver"];
      }
    }
    return types.map((type) => ({ type, ...labels[type] }));
  }

  async execute(taskId: string, input: ExecuteActionInput) {
    const allowed = this.availableActions(taskId).some((action) => action.type === input.type);
    if (!allowed) throw new Error(`当前状态不能执行动作：${input.type}`);
    if (["revise_plan", "request_changes", "checkpoint_and_continue", "revise_knowledge_proposal"].includes(input.type) && !(input.feedback ?? input.instruction)?.trim()) {
      throw new Error("请填写修改意见");
    }
    switch (input.type) {
      case "accept_plan": return this.acceptPlan(taskId, input.artifactId);
      case "reject_knowledge": return this.rejectKnowledge(taskId, input.artifactId);
      case "archive": return this.archive(taskId);
      case "generate_plan": return this.startPlan(taskId, input.instruction);
      case "revise_plan": return this.startPlan(taskId, input.feedback ?? input.instruction, true);
      case "start_development": return this.startDevelopment(taskId, input.instruction);
      case "request_changes": return this.startRework(taskId, input.feedback ?? input.instruction ?? "");
      case "run_code_review": return this.startQuality(taskId, "run_code_review", input.instruction);
      case "run_acceptance": return this.startQuality(taskId, "run_acceptance", input.instruction);
      case "checkpoint_and_continue": return this.startDelivery(taskId, "checkpoint_and_continue", input.feedback ?? input.instruction ?? "");
      case "deliver": return this.startDelivery(taskId, "deliver", input.instruction);
      case "generate_knowledge_proposal": return this.startKnowledgeProposal(taskId);
      case "revise_knowledge_proposal": return this.startKnowledgeProposal(taskId, input.feedback ?? input.instruction, true);
      case "accept_knowledge": return this.applyKnowledge(taskId, input.artifactId);
    }
  }

  async interrupt(taskId: string) {
    const task = this.requireTask(taskId);
    const action = [...task.actions].reverse().find((item) => ["pending", "running"].includes(item.status));
    await this.orchestrator.interrupt(taskId);
    if (action) {
      this.store.updateAction(action.id, { status: "interrupted", completedAt: now() });
      this.store.addActivity(taskId, "action.interrupted", { actionRunId: action.id, type: action.type, reason: "user" });
    }
    this.store.updateTask(taskId, { status: "interrupted" });
    return this.requireTask(taskId);
  }

  async diff(taskId: string) {
    const task = this.requireTask(taskId);
    const targets = await this.gitTargets(task, true);
    return Promise.all(targets.map(async (target) => {
      const repositoryBase = task.repositories.find((repo) => path.resolve(repo.worktreePath ?? repo.sourcePath) === path.resolve(target.path))?.baseCommit;
      const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const baseCommit = repositoryBase ?? (task.sessions.length > 0 ? emptyTree : undefined);
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
        const output = (await execFileAsync("git", ["-C", target.path, "diff", baseCommit ?? "HEAD", "--no-ext-diff", "--", entry.path], { timeout: 30_000 })).stdout;
        const limited = output.slice(0, 1024 * 1024);
        return { path: entry.path, oldPath: entry.oldPath, status: gitStatusName(entry.code), staged: workingPaths.has(entry.path) && entry.code[0] !== " " && entry.code[0] !== "?", diff: limited, binary: /Binary files .* differ|GIT binary patch/.test(output), truncated: output.length > limited.length };
      }));
      return { path: target.path, files, ...countDiffLines(files) };
    }));
  }

  private async startPlan(taskId: string, feedback?: string, revision = false) {
    const task = this.requireTask(taskId);
    const action = this.store.createAction(taskId, revision ? "revise_plan" : "generate_plan", { feedback });
    const latestPlan = [...task.artifacts].reverse().find((artifact) => artifact.kind === "plan");
    const providerInstruction = task.provider === "qoder" ? "/plan\n\n" : "";
    const prompt = `${providerInstruction}你负责为当前需求生成一份可供用户确认的开发计划。只分析，不修改代码或 Git 状态。计划必须包括影响范围、实施步骤、测试方案、风险与待确认事项。${revision ? `\n\n当前计划：\n${latestPlan?.content ?? ""}\n\n用户修改意见：\n${feedback}` : ""}`;
    return this.startAgent(action, prompt, "planning", "working");
  }

  private acceptPlan(taskId: string, artifactId?: string) {
    const task = this.requireTask(taskId);
    const artifact = artifactId ? task.artifacts.find((item) => item.id === artifactId) : [...task.artifacts].reverse().find((item) => item.kind === "plan");
    if (!artifact || artifact.kind !== "plan") throw new Error("没有可以采纳的计划");
    const action = this.store.createAction(taskId, "accept_plan", { artifactId: artifact.id });
    this.store.updateArtifact(artifact.id, { metadata: { ...artifact.metadata, status: "accepted", acceptedAt: now() } });
    this.completeAction(action, { artifactId: artifact.id });
    this.store.updateTask(taskId, { status: "ready" });
    this.store.addActivity(taskId, "plan.accepted", { artifactId: artifact.id });
    return this.requireTask(taskId);
  }

  private async startDevelopment(taskId: string, instruction?: string) {
    const task = this.requireTask(taskId);
    const acceptedPlan = [...task.artifacts].reverse().find((artifact) => artifact.kind === "plan" && artifact.metadata.status === "accepted");
    const action = this.store.createAction(taskId, "start_development", { instruction, planArtifactId: acceptedPlan?.id });
    const prompt = `请实现当前需求。${acceptedPlan ? `\n\n必须参考已经采纳的计划：\n${acceptedPlan.content}` : ""}\n\n本轮补充指令：\n${instruction ?? "按需求材料直接开发"}\n\n完成实现和相关测试后停止，不要提交或推送代码；等待用户选择下一步。`;
    return this.startAgent(action, prompt, "development", "working");
  }

  private async startRework(taskId: string, feedback: string) {
    const task = this.requireTask(taskId);
    const action = this.store.createAction(taskId, "request_changes", { feedback });
    this.store.addArtifact(taskId, action.id, { kind: "feedback", title: "人工修改意见", content: feedback, metadata: {} });
    this.store.addActivity(taskId, "changes.requested", { actionRunId: action.id, feedback });
    const previous = [...task.actions].reverse().find((item) => ["start_development", "request_changes"].includes(item.type) && item.sessionId);
    const prompt = `用户认为当前结果仍需修改。请逐项处理以下意见，重新运行相关测试。完成后停止，不要提交或推送代码。\n\n${feedback}`;
    return this.startAgent(action, prompt, "development", "working", previous?.sessionId);
  }

  private async startQuality(taskId: string, type: "run_code_review" | "run_acceptance", instruction?: string) {
    const task = this.requireTask(taskId);
    const snapshot = await this.createSnapshot(task);
    const action = this.store.createAction(taskId, type, { instruction });
    this.store.updateAction(action.id, { snapshotId: snapshot.id });
    const prompt = type === "run_code_review"
      ? `你是独立 Code Reviewer。只读检查当前代码，不得修改文件。检查正确性、回归风险、安全性、测试和可维护性，并提供文件位置和证据。${instruction ? `\n\n补充关注点：${instruction}` : ""}`
      : `你是独立验收 Agent。只读检查代码，可以运行不会修改业务文件的命令。逐项验证验收目标并展示可复现证据。\n\n交付目标：${task.deliveryTarget ?? "按需求材料实现目标"}\n验收标准：${task.acceptanceCriteria ?? "依据需求材料逐项验证"}${instruction ? `\n补充要求：${instruction}` : ""}`;
    return this.startAgent(action, prompt, type === "run_code_review" ? "review" : "acceptance", "working");
  }

  private async startDelivery(taskId: string, type: "checkpoint_and_continue" | "deliver", feedback?: string) {
    const task = this.requireTask(taskId);
    const action = this.store.createAction(taskId, type, { feedback, intent: type === "deliver" ? "final" : "checkpoint" });
    this.store.addActivity(taskId, "delivery.preflight_started", { actionRunId: action.id, intent: action.input.intent });
    let states: Awaited<ReturnType<ActionEngine["inspectDelivery"]>>;
    try {
      states = await this.inspectDelivery(task, true);
    } catch (error) {
      this.failAction(action, error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.store.updateAction(action.id, { output: { preflight: states } });
    const delivered = states.length > 0 && states.every((state) => state.clean && state.branchMatches && state.remoteContainsHead);
    this.store.addActivity(taskId, "delivery.preflight_completed", { actionRunId: action.id, repositories: states, action: delivered ? "skip_all" : states.every((state) => state.clean) ? "push_only" : "commit_and_push" });
    for (const state of states) {
      if (state.clean) this.store.addActivity(taskId, "delivery.commit_skipped", { actionRunId: action.id, path: state.path, commit: state.head, performedBy: "external" });
      if (state.clean && state.branchMatches && state.remoteContainsHead) this.store.addActivity(taskId, "delivery.push_skipped", { actionRunId: action.id, path: state.path, remote: state.remote, branch: state.expectedBranch, commit: state.head, performedBy: "external" });
    }
    if (delivered) return this.finishDelivery(action, states);
    const instructions = states.map((state) => `- ${state.path}\n  指定分支：${state.expectedBranch}\n  remote：${state.remote}\n  HEAD：${state.head}\n  工作区：${state.clean ? "已提交" : "需要提交"}\n  远程：${state.remoteContainsHead ? "已包含 HEAD" : "需要推送或处理差异"}`).join("\n");
    const prompt = `用户要求${type === "deliver" ? "最终交付" : "保存当前阶段版本"}。请自主完成以下仓库的提交和推送：\n${instructions}\n\n已经完成的步骤不要重复。不得 force push、删除远程引用、修改 remote URL、修改全局 Git 配置、绕过 hooks 或输出凭据。需要认证、权限、冲突取舍或改变业务内容时停止并说明。`;
    const previous = [...task.actions].reverse().find((item) => ["start_development", "request_changes"].includes(item.type) && item.sessionId);
    this.store.addActivity(taskId, "delivery.agent_started", { actionRunId: action.id, repositories: states });
    return this.startAgent(action, prompt, "delivery", "delivering", previous?.sessionId);
  }

  private async startKnowledgeProposal(taskId: string, feedback?: string, revision = false) {
    const task = this.requireTask(taskId);
    const previous = [...task.artifacts].reverse().find((artifact) => artifact.kind === "knowledge" && artifact.metadata.status === "draft");
    const action = this.store.createAction(taskId, revision ? "revise_knowledge_proposal" : "generate_knowledge_proposal", { feedback, previousArtifactId: previous?.id });
    const evidence = task.artifacts.map((artifact) => `## ${artifact.title}\n${artifact.content ?? JSON.stringify(artifact.metadata)}`).join("\n\n").slice(0, 800_000);
    const prompt = `你是独立的需求知识审查 Agent。只读分析全过程，不要修改任何文件或 Git 状态。基于需求材料、开发结果、审查验收证据和最终远程交付，生成一份知识库更新提案。明确应更新的旧页面、建议新增页面、来源、适用范围、状态以及建议内容。${revision ? `\n\n旧提案：\n${previous?.content ?? ""}\n\n用户意见：\n${feedback}` : ""}\n\n过程证据：\n${evidence}`;
    return this.startAgent(action, prompt, "review", "working");
  }

  private async applyKnowledge(taskId: string, artifactId?: string) {
    const task = this.requireTask(taskId);
    const proposal = artifactId ? task.artifacts.find((item) => item.id === artifactId) : [...task.artifacts].reverse().find((item) => item.kind === "knowledge" && item.metadata.status === "draft");
    if (!proposal || proposal.kind !== "knowledge") throw new Error("没有可以采纳的知识提案");
    const before = await this.nonKnowledgeFingerprint(taskId);
    const action = this.store.createAction(taskId, "accept_knowledge", { artifactId: proposal.id, nonKnowledgeBefore: before });
    this.store.updateArtifact(proposal.id, { metadata: { ...proposal.metadata, status: "accepted", acceptedAt: now() } });
    const prompt = `用户已经确认以下知识更新提案。请只修改各代码仓库的 knowledge/ 目录，把提案应用到主题化 Wiki。不得修改业务代码、测试、配置或 Git 状态。\n\n${proposal.content}`;
    return this.startAgent(action, prompt, "knowledge", "knowledge_pending");
  }

  private rejectKnowledge(taskId: string, artifactId?: string) {
    const task = this.requireTask(taskId);
    const proposal = artifactId ? task.artifacts.find((item) => item.id === artifactId) : [...task.artifacts].reverse().find((item) => item.kind === "knowledge" && item.metadata.status === "draft");
    if (!proposal) throw new Error("没有可以跳过的知识提案");
    const action = this.store.createAction(taskId, "reject_knowledge", { artifactId: proposal.id });
    this.store.updateArtifact(proposal.id, { metadata: { ...proposal.metadata, status: "rejected", rejectedAt: now() } });
    this.completeAction(action, { artifactId: proposal.id });
    this.store.updateTask(taskId, { status: "closed" });
    this.store.addActivity(taskId, "knowledge.rejected", { artifactId: proposal.id });
    return this.requireTask(taskId);
  }

  private archive(taskId: string) {
    const action = this.store.createAction(taskId, "archive", {});
    this.completeAction(action, {});
    this.store.updateTask(taskId, { status: "archived" });
    this.store.addActivity(taskId, "task.archived", {});
    return this.requireTask(taskId);
  }

  private startAgent(action: ActionRun, prompt: string, mode: "planning" | "development" | "review" | "acceptance" | "knowledge" | "delivery", taskStatus: Task["status"], resumeSessionId?: string) {
    let session;
    try {
      session = resumeSessionId
        ? this.orchestrator.resumeSession(action.taskId, resumeSessionId, prompt, mode)
        : this.orchestrator.start(action.taskId, { prompt, mode });
    } catch (error) {
      this.failAction(action, error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.store.updateAction(action.id, { status: "running", sessionId: session.id, startedAt: now() });
    this.store.updateTask(action.taskId, { status: taskStatus });
    this.store.addActivity(action.taskId, "action.started", { actionRunId: action.id, type: action.type, label: labels[action.type].label, sessionId: session.id });
    return this.requireTask(action.taskId);
  }

  private async onTurnFinished(event: AgentEvent) {
    const action = this.store.findActionBySession(event.sessionId);
    if (!action || action.status !== "running" || this.processing.has(action.id)) return;
    this.processing.add(action.id);
    try {
      if (event.type === "turn.failed") {
        this.failAction(action, String(event.payload.error ?? "Agent 执行失败"));
        return;
      }
      const output = this.finalAgentMessage(event.sessionId);
      if (["generate_plan", "revise_plan"].includes(action.type)) {
        const previous = [...this.requireTask(action.taskId).artifacts].reverse().find((artifact) => artifact.kind === "plan" && artifact.metadata.status === "draft");
        if (previous) this.store.updateArtifact(previous.id, { metadata: { ...previous.metadata, status: "superseded" } });
        this.store.addArtifact(action.taskId, action.id, { kind: "plan", title: action.type === "revise_plan" ? "更新后的开发计划" : "开发计划", content: output, metadata: { status: "draft" } });
        this.completeAction(action, { summary: output });
        this.store.updateTask(action.taskId, { status: "waiting_user" });
      } else if (["start_development", "request_changes"].includes(action.type)) {
        const snapshot = await this.createSnapshot(this.requireTask(action.taskId));
        this.store.addArtifact(action.taskId, action.id, { kind: "development", title: action.type === "request_changes" ? "修改完成" : "开发完成", content: output, metadata: { snapshotId: snapshot.id } });
        this.store.updateAction(action.id, { snapshotId: snapshot.id });
        this.completeAction(action, { summary: output, snapshotId: snapshot.id });
        this.store.updateTask(action.taskId, { status: "waiting_user" });
      } else if (action.type === "run_code_review" || action.type === "run_acceptance") {
        const verdict = this.parseVerdict(output);
        this.store.addArtifact(action.taskId, action.id, { kind: action.type === "run_code_review" ? "review" : "acceptance", title: action.type === "run_code_review" ? "Agent Code Review" : "试运行验收报告", content: output, metadata: { verdict, snapshotId: action.snapshotId } });
        this.completeAction(action, { verdict, summary: output });
        this.store.updateTask(action.taskId, { status: "waiting_user" });
      } else if (action.type === "checkpoint_and_continue" || action.type === "deliver") {
        await this.verifyDelivery(action);
      } else if (action.type === "generate_knowledge_proposal" || action.type === "revise_knowledge_proposal") {
        const task = this.requireTask(action.taskId);
        const previous = [...task.artifacts].reverse().find((artifact) => artifact.kind === "knowledge" && artifact.metadata.status === "draft");
        if (previous) this.store.updateArtifact(previous.id, { metadata: { ...previous.metadata, status: "superseded" } });
        this.store.addArtifact(action.taskId, action.id, { kind: "knowledge", title: "知识库更新提案", content: output, metadata: { status: "draft" } });
        this.completeAction(action, { summary: output });
        this.store.updateTask(action.taskId, { status: "knowledge_pending" });
      } else if (action.type === "accept_knowledge") {
        const after = await this.nonKnowledgeFingerprint(action.taskId);
        const before = action.input.nonKnowledgeBefore as Record<string, string>;
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          this.failAction(action, "知识更新 Agent 修改了 knowledge/ 之外的文件");
          return;
        }
        this.store.addArtifact(action.taskId, action.id, { kind: "knowledge", title: "知识库已更新", content: output, metadata: { status: "applied" } });
        this.completeAction(action, { summary: output });
        this.store.updateTask(action.taskId, { status: "closed" });
        this.store.addActivity(action.taskId, "knowledge.accepted", { actionRunId: action.id });
      }
    } catch (error) {
      this.failAction(action, error instanceof Error ? error.message : String(error));
    } finally {
      this.processing.delete(action.id);
    }
  }

  private async verifyDelivery(action: ActionRun) {
    const task = this.requireTask(action.taskId);
    this.store.addActivity(action.taskId, "delivery.remote_verifying", { actionRunId: action.id });
    const states = await this.inspectDelivery(task, false);
    const problems = states.flatMap((state) => {
      const result: string[] = [];
      if (!state.clean) result.push(`${state.path}: 仍有未提交变更`);
      if (!state.branchMatches) result.push(`${state.path}: 当前分支不是指定分支 ${state.expectedBranch}`);
      if (!state.remoteConfigured) result.push(`${state.path}: 未配置 remote ${state.remote}`);
      else if (!state.remoteSha) result.push(`${state.path}: 远程分支不存在或不可读取`);
      else if (!state.remoteContainsHead) result.push(`${state.path}: 远程分支不包含本地 HEAD ${state.head}`);
      return result;
    });
    if (problems.length) {
      this.store.updateAction(action.id, { status: "failed", completedAt: now(), output: { ...action.output, verification: states, problems } });
      this.store.updateTask(action.taskId, { status: "waiting_user" });
      this.store.addActivity(action.taskId, "delivery.needs_user", { actionRunId: action.id, problems, repositories: states });
      return;
    }
    await this.finishDelivery(action, states);
  }

  private async finishDelivery(action: ActionRun, states: Awaited<ReturnType<ActionEngine["inspectDelivery"]>>) {
    const commits = states.map((state) => ({ path: state.path, commit: state.head, remote: state.remote, branch: state.expectedBranch }));
    this.store.addArtifact(action.taskId, action.id, { kind: "delivery", title: action.type === "deliver" ? "最终代码交付" : "阶段版本已保存", content: commits.map((item) => `${item.path}: ${item.commit} -> ${item.remote}/${item.branch}`).join("\n"), metadata: { commits, intent: action.type === "deliver" ? "final" : "checkpoint", remoteVerified: true } });
    this.completeAction(action, { commits, remoteVerified: true });
    this.store.addActivity(action.taskId, "delivery.completed", { actionRunId: action.id, commits, intent: action.type === "deliver" ? "final" : "checkpoint" });
    if (action.type === "checkpoint_and_continue") {
      this.store.updateTask(action.taskId, { status: "waiting_user" });
      await this.startRework(action.taskId, String(action.input.feedback ?? "继续完善功能"));
    } else {
      this.store.updateTask(action.taskId, { status: "delivered" });
      await this.startKnowledgeProposal(action.taskId).catch(() => undefined);
    }
    return this.requireTask(action.taskId);
  }

  private completeAction(action: ActionRun, output: Record<string, unknown>) {
    this.store.updateAction(action.id, { status: "succeeded", completedAt: now(), output: { ...action.output, ...output } });
    this.store.addActivity(action.taskId, "action.completed", { actionRunId: action.id, type: action.type, label: labels[action.type].label });
  }

  private failAction(action: ActionRun, error: string) {
    this.store.updateAction(action.id, { status: "failed", completedAt: now(), output: { ...action.output, error } });
    const status: Task["status"] = action.type === "generate_knowledge_proposal"
      ? "delivered"
      : ["revise_knowledge_proposal", "accept_knowledge"].includes(action.type)
        ? "knowledge_pending"
        : ["run_code_review", "run_acceptance", "checkpoint_and_continue", "deliver"].includes(action.type)
          ? "waiting_user"
          : "failed";
    this.store.updateTask(action.taskId, { status });
    this.store.addActivity(action.taskId, "action.failed", { actionRunId: action.id, type: action.type, label: labels[action.type].label, error });
  }

  private async createSnapshot(task: Task) {
    const targets = await this.gitTargets(task, true);
    const repositories = [];
    for (const target of targets) {
      const repository = task.repositories.find((item) => path.resolve(item.worktreePath ?? item.sourcePath) === path.resolve(target.path));
      const head = (await execFileAsync("git", ["-C", target.path, "rev-parse", "HEAD"])).stdout.trim();
      const treeHash = (await execFileAsync("git", ["-C", target.path, "rev-parse", "HEAD^{tree}"])).stdout.trim();
      const status = (await execFileAsync("git", ["-C", target.path, "status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
      const diff = (await execFileAsync("git", ["-C", target.path, "diff", "--binary", "HEAD"])).stdout;
      repositories.push({ repositoryId: repository?.id, path: target.path, head, treeHash, diffHash: createHash("sha256").update(status).update(diff).digest("hex") });
    }
    return this.store.addSnapshot(task.id, repositories);
  }

  private async nonKnowledgeFingerprint(taskId: string) {
    const repositories = await this.diff(taskId);
    const entries = repositories.flatMap((repository) => repository.files.filter((file) => !isKnowledgePath(file.path)).map((file) => [`${path.resolve(repository.path)}::${file.path}`, createHash("sha256").update(JSON.stringify(file)).digest("hex")] as const));
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
  }

  private async inspectDelivery(task: Task, initializeWorkspace: boolean) {
    const targets = await this.gitTargets(task, initializeWorkspace);
    const states = [];
    for (const target of targets) {
      const repository = task.repositories.find((item) => path.resolve(item.worktreePath ?? item.sourcePath) === path.resolve(target.path));
      const head = (await execFileAsync("git", ["-C", target.path, "rev-parse", "HEAD"])).stdout.trim();
      const branch = (await execFileAsync("git", ["-C", target.path, "branch", "--show-current"])).stdout.trim();
      const expectedBranch = repository?.taskBranch ?? branch;
      const remote = "origin";
      let remoteConfigured = true;
      try { await execFileAsync("git", ["-C", target.path, "remote", "get-url", remote]); } catch { remoteConfigured = false; }
      let remoteSha: string | undefined;
      let remoteContainsHead = false;
      if (remoteConfigured && expectedBranch) {
        try {
          const output = await execFileAsync("git", ["-C", target.path, "ls-remote", "--heads", remote, `refs/heads/${expectedBranch}`], { timeout: 30_000 });
          remoteSha = output.stdout.trim().split(/\s+/)[0] || undefined;
          remoteContainsHead = remoteSha === head;
          if (remoteSha && !remoteContainsHead) {
            await execFileAsync("git", ["-C", target.path, "fetch", "--quiet", remote, `refs/heads/${expectedBranch}`], { timeout: 60_000 });
            try { await execFileAsync("git", ["-C", target.path, "merge-base", "--is-ancestor", head, "FETCH_HEAD"]); remoteContainsHead = true; } catch { remoteContainsHead = false; }
          }
        } catch { remoteSha = undefined; remoteContainsHead = false; }
      }
      states.push({ path: target.path, clean: !(await this.gitStatus(target.path)), head, branch, expectedBranch, branchMatches: Boolean(expectedBranch) && branch === expectedBranch, remote, remoteConfigured, remoteSha, remoteContainsHead });
    }
    return states;
  }

  private async untrackedDiff(root: string, relative: string): Promise<CodeDiffFile> {
    const absolute = path.resolve(root, relative);
    const resolvedRoot = path.resolve(root);
    if (absolute !== resolvedRoot && !absolute.startsWith(resolvedRoot + path.sep)) return { path: relative, status: "unknown", staged: false, diff: "" };
    try {
      const content = await fs.readFile(absolute);
      if (content.includes(0)) return { path: relative, status: "added", staged: false, diff: "", binary: true };
      const text = content.toString("utf8");
      const limited = text.slice(0, 512 * 1024);
      const lines = limited ? limited.replace(/\r?\n$/, "").split(/\r?\n/) : [];
      return { path: relative, status: "added", staged: false, diff: lines.length ? `--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}` : "", truncated: text.length > limited.length };
    } catch { return { path: relative, status: "unknown", staged: false, diff: "" }; }
  }

  private async gitTargets(task: Task, initializeWorkspace: boolean) {
    const paths = task.repositories.map((repo) => repo.worktreePath ?? repo.sourcePath);
    if (paths.length) return paths.map((item) => ({ path: item }));
    if (!task.workspacePath) throw new Error("任务工作区不存在");
    if (initializeWorkspace) await this.ensureGit(task.workspacePath, task.title);
    return [{ path: task.workspacePath }];
  }

  private async ensureGit(cwd: string, title: string) {
    try { await fs.access(path.join(cwd, ".git")); return; } catch { /* initialize below */ }
    await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
    await execFileAsync("git", ["-C", cwd, "init"]);
    await execFileAsync("git", ["-C", cwd, "config", "user.name", "AgentDesk"]);
    await execFileAsync("git", ["-C", cwd, "config", "user.email", "agentdesk@local"]);
    await execFileAsync("git", ["-C", cwd, "add", "-A"]);
    await execFileAsync("git", ["-C", cwd, "commit", "-m", `AgentDesk baseline: ${title}`]);
  }

  private async gitStatus(cwd: string) {
    return (await execFileAsync("git", ["-C", cwd, "status", "--porcelain=v1"])).stdout.trim();
  }

  private finalAgentMessage(sessionId: string) {
    return this.store.sessionEvents(sessionId).filter((event) => event.type === "message.completed").map((event) => {
      const item = event.payload.item as Record<string, unknown> | undefined;
      return String(item?.text ?? event.payload.text ?? "");
    }).filter(Boolean).at(-1) ?? "Agent 未返回报告。";
  }

  private parseVerdict(output: string) {
    return output.match(/\b(PASS_WITH_WARNINGS|PASS|FAIL|INCONCLUSIVE)\b/i)?.[1]?.toUpperCase() ?? "UNSPECIFIED";
  }

  private requireTask(taskId: string) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    return task;
  }
}
