import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter } from "./agents/types.js";
import { EventBus } from "./event-bus.js";
import { Orchestrator } from "./orchestrator.js";
import { Store } from "./store.js";
import { WorkflowEngine } from "./workflow-engine.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function approveGeneratedRequirements(
  engine: WorkflowEngine,
  store: Store,
  events: EventBus,
  taskId: string,
) {
  const requirementSession = store.getWorkflow(taskId)!.nodes
    .find((node) => node.kind === "requirement_analysis")!.sessionId!;
  events.publish(taskId, requirementSession, "message.completed", {
    item: {
      type: "agentMessage",
      text: "# Requirements\n\n## Functional requirements\n\nFR-001: Implement the requested behavior.\n\n## Acceptance criteria\n\nAC-001: FR-001 is verified by tests.",
    },
  });
  events.publish(taskId, requirementSession, "turn.completed", {
    turn: { status: "completed" },
  });
  await vi.waitFor(() => expect(store.getTask(taskId)?.status).toBe("pending_requirement_confirmation"));
  await engine.approve(taskId, "Requirements confirmed");
  return store.getWorkflow(taskId)!.nodes.find((node) => node.kind === "development")!.sessionId!;
}

async function completeKnowledgeReview(
  store: Store,
  events: EventBus,
  taskId: string,
) {
  await vi.waitFor(() => expect(store.getWorkflow(taskId)?.nodes.find((node) => node.kind === "knowledge_review")?.sessionId).toBeTruthy());
  const sessionId = store.getWorkflow(taskId)!.nodes.find((node) => node.kind === "knowledge_review")!.sessionId!;
  events.publish(taskId, sessionId, "message.completed", {
    item: { type: "agentMessage", text: "已核对完整证据链并更新主题知识；没有修改 knowledge/ 之外的文件。" },
  });
  events.publish(taskId, sessionId, "turn.completed", { turn: { status: "completed" } });
  return sessionId;
}

describe("WorkflowEngine", () => {
  it("generates and waits for approval of a requirement specification before development", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-requirements-"));
    tempDirs.push(dir);
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "task.yaml"), "title: requirements\n");
    const store = new Store(path.join(dir, "test.db"));
    const events = new EventBus(store);
    const start = vi.fn(async () => {});
    const adapter: AgentAdapter = {
      provider: "codex",
      detect: async () => ({ provider: "codex", installed: true, command: "codex" }),
      start, resume: async () => {}, steer: async () => {},
      resolve: async () => {}, interrupt: async () => {},
    };
    const orchestrator = new Orchestrator(store, events, [adapter]);
    const engine = new WorkflowEngine(store, events, orchestrator);
    const task = store.createTask({
      title: "requirements task",
      provider: "codex",
      requirement: "只实现加减法",
      repositories: [],
      workflow: { templateId: "requirements" },
    });
    store.updateTask(task.id, { workspacePath: workspace, status: "ready" });

    const started = await engine.start(task.id, "先明确计算器需求");
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      mode: "requirements",
      prompt: expect.stringMatching(/需求追踪矩阵[\s\S]*材料覆盖表/),
    }));
    const requirementSession = started.nodes.find((node) => node.kind === "requirement_analysis")!.sessionId!;
    expect(store.getTask(task.id)?.status).toBe("defining_requirements");
    expect(started.nodes.find((node) => node.kind === "development")?.status).toBe("pending");
    events.publish(task.id, requirementSession, "message.completed", {
      item: { type: "agentMessage", text: "# 需求规格\n\nFR-001：支持加法。\n\nAC-001：1+2=3。" },
    });
    events.publish(task.id, requirementSession, "turn.completed", { turn: { status: "completed" } });

    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("pending_requirement_confirmation"));
    const draft = store.getWorkflow(task.id)?.artifacts.find((artifact) => artifact.kind === "requirement");
    expect(draft).toMatchObject({ title: "需求规格 v1 · 待确认", metadata: { approved: false } });
    expect(store.getTask(task.id)?.activities.find((activity) => activity.type === "requirement.generated")).toMatchObject({
      payload: {
        artifactId: draft?.id,
        version: 1,
        title: "需求规格 v1 · 待确认",
        sourceMaterialCount: 1,
      },
    });
    expect(fs.readFileSync(path.join(workspace, "generated", "requirements-v1.md"), "utf8")).toContain("FR-001");

    await engine.approve(task.id, "需求理解正确");
    const approved = store.getWorkflow(task.id)!;
    expect(approved.artifacts.find((artifact) => artifact.kind === "requirement")?.metadata.approved).toBe(true);
    expect(approved.nodes.find((node) => node.kind === "development")?.status).toBe("running");
    expect(approved.nodes.find((node) => node.kind === "development")?.sessionId).not.toBe(requirementSession);
    store.close();
  }, 20_000);

  it("runs the fast workflow from development to a completed commit node", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-workflow-"));
    tempDirs.push(dir);
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "task.yaml"), "title: test\n");
    const store = new Store(path.join(dir, "test.db"));
    const events = new EventBus(store);
    const adapter: AgentAdapter = {
      provider: "codex",
      detect: async () => ({ provider: "codex", installed: true, command: "codex" }),
      start: async () => {},
      resume: async () => {},
      steer: async () => {},
      resolve: async () => {},
      interrupt: async () => {},
    };
    const orchestrator = new Orchestrator(store, events, [adapter]);
    const engine = new WorkflowEngine(store, events, orchestrator);
    const task = store.createTask({
      title: "fast task",
      provider: "codex",
      repositories: [],
      workflow: { templateId: "fast" },
    });
    store.updateTask(task.id, { workspacePath: workspace, status: "ready" });

    const started = await engine.start(task.id, "implement it");
    const development = started.nodes.find((node) => node.kind === "development")!;
    expect(development.status).toBe("running");
    expect(development.sessionId).toBeTruthy();

    fs.writeFileSync(path.join(workspace, "calculator.ts"), "export const add = (a: number, b: number) => a + b;\n");
    const [repositoryDiff] = await engine.diff(task.id);
    expect(repositoryDiff?.files).toMatchObject([
      { path: "calculator.ts", status: "added", staged: false },
    ]);
    expect(repositoryDiff?.files[0]?.diff).toContain("+export const add");
    expect(repositoryDiff?.additions).toBe(1);

    events.publish(task.id, development.sessionId!, "turn.completed", { turn: { status: "completed" } });
    await completeKnowledgeReview(store, events, task.id);
    await vi.waitFor(() => expect(store.getWorkflow(task.id)?.status).toBe("completed"), { timeout: 5_000 });
    expect(store.getWorkflow(task.id)?.nodes.map((node) => node.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(store.getWorkflow(task.id)?.artifacts.map((item) => item.kind)).toEqual([
      "checkpoint",
      "knowledge",
      "commit",
    ]);
    store.close();
  }, 20_000);

  it("uses an independent review session and waits for human approval", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-review-"));
    tempDirs.push(dir);
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "task.yaml"), "title: review\n");
    const store = new Store(path.join(dir, "test.db"));
    const events = new EventBus(store);
    const adapter: AgentAdapter = {
      provider: "codex",
      detect: async () => ({ provider: "codex", installed: true, command: "codex" }),
      start: async () => {}, resume: async () => {}, steer: async () => {},
      resolve: async () => {}, interrupt: async () => {},
    };
    const orchestrator = new Orchestrator(store, events, [adapter]);
    const engine = new WorkflowEngine(store, events, orchestrator);
    const task = store.createTask({
      title: "review task",
      provider: "codex",
      repositories: [],
      workflow: { templateId: "agent-review" },
    });
    store.updateTask(task.id, { workspacePath: workspace, status: "ready" });
    await engine.start(task.id, "implement it");
    const developmentSession = await approveGeneratedRequirements(engine, store, events, task.id);
    events.publish(task.id, developmentSession, "turn.completed", { turn: { status: "completed" } });

    await vi.waitFor(() => expect(store.getWorkflow(task.id)?.nodes.find((node) => node.kind === "agent_review")?.sessionId).toBeTruthy());
    const reviewSession = store.getWorkflow(task.id)!.nodes.find((node) => node.kind === "agent_review")!.sessionId!;
    expect(reviewSession).not.toBe(developmentSession);
    events.publish(task.id, reviewSession, "message.completed", {
      item: { type: "agentMessage", text: '审查完成。\n```json\n{"verdict":"PASS","summary":"没有阻塞问题","findings":[]}\n```' },
    });
    events.publish(task.id, reviewSession, "turn.completed", { turn: { status: "completed" } });

    const knowledgeSession = await completeKnowledgeReview(store, events, task.id);
    expect(knowledgeSession).not.toBe(developmentSession);
    expect(knowledgeSession).not.toBe(reviewSession);
    await vi.waitFor(() => expect(store.getTask(task.id)?.status).toBe("pending_review"), { timeout: 5_000 });
    expect(store.getWorkflow(task.id)?.artifacts.find((item) => item.kind === "review")?.metadata).toMatchObject({
      verdict: "PASS",
      summary: "没有阻塞问题",
      findings: [],
    });
    const knowledgeArtifact = store.getWorkflow(task.id)?.artifacts.find((item) => item.kind === "knowledge");
    expect(knowledgeArtifact).toMatchObject({
      metadata: { protectedFilesUnchanged: true },
    });
    expect(fs.readFileSync(path.join(workspace, "generated", "knowledge-review-context.md"), "utf8")).toContain("开发结果 Git Diff");
    await engine.approve(task.id, "looks good");
    expect(store.getWorkflow(task.id)?.status).toBe("completed");
    store.close();
  }, 20_000);

  it("blocks a knowledge reviewer that changes files outside knowledge", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-knowledge-boundary-"));
    tempDirs.push(dir);
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "task.yaml"), "title: knowledge boundary\n");
    const store = new Store(path.join(dir, "test.db"));
    const events = new EventBus(store);
    const adapter: AgentAdapter = {
      provider: "codex",
      detect: async () => ({ provider: "codex", installed: true, command: "codex" }),
      start: async () => {}, resume: async () => {}, steer: async () => {},
      resolve: async () => {}, interrupt: async () => {},
    };
    const engine = new WorkflowEngine(store, events, new Orchestrator(store, events, [adapter]));
    const task = store.createTask({
      title: "knowledge boundary task",
      provider: "codex",
      repositories: [],
      workflow: { templateId: "fast" },
    });
    store.updateTask(task.id, { workspacePath: workspace, status: "ready" });
    await engine.start(task.id, "implement it");
    const development = store.getWorkflow(task.id)!.nodes.find((node) => node.kind === "development")!;
    fs.writeFileSync(path.join(workspace, "calculator.ts"), "export const add = (a: number, b: number) => a + b;\n");
    events.publish(task.id, development.sessionId!, "turn.completed", { turn: { status: "completed" } });

    await vi.waitFor(() => expect(store.getWorkflow(task.id)?.nodes.find((node) => node.kind === "knowledge_review")?.sessionId).toBeTruthy());
    const knowledge = store.getWorkflow(task.id)!.nodes.find((node) => node.kind === "knowledge_review")!;
    fs.writeFileSync(path.join(workspace, "calculator.ts"), "export const add = (a: number, b: number) => a - b;\n");
    events.publish(task.id, knowledge.sessionId!, "message.completed", {
      item: { type: "agentMessage", text: "错误地修改了业务代码" },
    });
    events.publish(task.id, knowledge.sessionId!, "turn.completed", { turn: { status: "completed" } });

    await vi.waitFor(() => expect(store.getWorkflow(task.id)?.status).toBe("failed"));
    expect(store.getWorkflow(task.id)?.artifacts.find((artifact) => artifact.kind === "knowledge")).toMatchObject({
      title: "需求知识审查越界",
      metadata: { protectedFilesUnchanged: false },
    });
    expect(store.getWorkflow(task.id)?.nodes.find((node) => node.kind === "commit")?.status).toBe("pending");
    store.close();
  }, 20_000);

  it("automatically returns a failed quality report to the development agent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-auto-rework-"));
    tempDirs.push(dir);
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "task.yaml"), "title: auto rework\n");
    const store = new Store(path.join(dir, "test.db"));
    const events = new EventBus(store);
    const resume = vi.fn(async () => {});
    const adapter: AgentAdapter = {
      provider: "codex",
      detect: async () => ({ provider: "codex", installed: true, command: "codex" }),
      start: async () => {}, resume, steer: async () => {},
      resolve: async () => {}, interrupt: async () => {},
    };
    const orchestrator = new Orchestrator(store, events, [adapter]);
    const engine = new WorkflowEngine(store, events, orchestrator);
    const task = store.createTask({
      title: "auto rework task",
      provider: "codex",
      repositories: [],
      workflow: { templateId: "agent-review" },
    });
    store.updateTask(task.id, { workspacePath: workspace, status: "ready" });
    await engine.start(task.id, "implement it");
    await approveGeneratedRequirements(engine, store, events, task.id);
    const development = store.getWorkflow(task.id)!.nodes.find((node) => node.kind === "development")!;
    store.updateSession(development.sessionId!, { providerSessionId: "thread-development", status: "running" });
    events.publish(task.id, development.sessionId!, "turn.completed", { turn: { status: "completed" } });

    await vi.waitFor(() => expect(store.getWorkflow(task.id)?.nodes.find((node) => node.kind === "agent_review")?.sessionId).toBeTruthy());
    const reviewSession = store.getWorkflow(task.id)!.nodes.find((node) => node.kind === "agent_review")!.sessionId!;
    events.publish(task.id, reviewSession, "message.completed", {
      item: { type: "agentMessage", text: '```json\n{"verdict":"FAIL","summary":"减法结果错误","findings":[{"id":"AF-001","severity":"blocking","title":"减法错误","expected":"3-2=1","actual":"3-2=5","reproductionSteps":["运行减法用例"],"evidence":{"output":"expected 1, received 5"},"suggestedDirection":"检查运算符分支"}]}\n```' },
    });
    events.publish(task.id, reviewSession, "turn.completed", { turn: { status: "completed" } });

    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    const workflow = store.getWorkflow(task.id)!;
    expect(workflow.status).toBe("running");
    expect(workflow.currentNodeId).toBe(development.id);
    expect(store.getTask(task.id)?.status).toBe("running");
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: development.sessionId,
        prompt: expect.stringContaining("AF-001"),
      }),
      "thread-development",
    );
    expect(workflow.artifacts.find((item) => item.title.includes("自动打回"))?.metadata).toMatchObject({
      automatic: true,
      sourceNodeId: "agent-review",
    });
    store.close();
  }, 20_000);

  it("resumes an interrupted workflow from its provider session after restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-workflow-recovery-"));
    tempDirs.push(dir);
    const workspace = path.join(dir, "workspace");
    const databasePath = path.join(dir, "test.db");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "task.yaml"), "title: recovery\n");
    const originalStore = new Store(databasePath);
    const task = originalStore.createTask({
      title: "recover task",
      provider: "codex",
      repositories: [],
      workflow: { templateId: "fast" },
    });
    originalStore.updateTask(task.id, { workspacePath: workspace, status: "running" });
    const session = originalStore.createSession(task.id, "codex");
    originalStore.updateSession(session.id, { status: "running", providerSessionId: "thread-recover" });
    const development = originalStore.getWorkflow(task.id)!.nodes.find((node) => node.kind === "development")!;
    originalStore.updateWorkflowNode(task.id, development.id, { status: "running", sessionId: session.id, attempt: 1, startedAt: new Date().toISOString() });
    originalStore.updateWorkflow(task.id, { status: "running", currentNodeId: development.id });
    originalStore.addEvent(task.id, session.id, "turn.started", { prompt: "实现计算器并运行测试" });
    originalStore.close();

    const store = new Store(databasePath);
    const events = new EventBus(store);
    const resume = vi.fn(async () => {});
    const adapter: AgentAdapter = {
      provider: "codex",
      detect: async () => ({ provider: "codex", installed: true, command: "codex" }),
      start: async () => {}, resume, steer: async () => {},
      resolve: async () => {}, interrupt: async () => {},
    };
    const orchestrator = new Orchestrator(store, events, [adapter]);
    const engine = new WorkflowEngine(store, events, orchestrator);
    expect(await engine.recoverInterruptedWorkflows()).toBe(1);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());

    const recovered = store.getTask(task.id)!;
    expect(recovered.status).toBe("running");
    expect(recovered.workflow?.status).toBe("running");
    expect(recovered.workflow?.nodes.find((node) => node.id === development.id)).toMatchObject({
      status: "running",
      sessionId: session.id,
      output: { recoveryCount: 1 },
    });
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: session.id, prompt: expect.stringContaining("实现计算器并运行测试") }),
      "thread-recover",
    );
    expect(recovered.activities.at(-1)).toMatchObject({
      type: "workflow.recovered",
      payload: { strategy: "resume_provider_session" },
    });
    store.close();
  }, 20_000);

  it("replays a persisted terminal event before starting another agent turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-event-replay-"));
    tempDirs.push(dir);
    const workspace = path.join(dir, "workspace");
    const databasePath = path.join(dir, "test.db");
    fs.mkdirSync(workspace);
    const originalStore = new Store(databasePath);
    const task = originalStore.createTask({
      title: "replay task",
      provider: "codex",
      repositories: [],
      workflow: { templateId: "requirements" },
    });
    originalStore.updateTask(task.id, { workspacePath: workspace, status: "running" });
    const session = originalStore.createSession(task.id, "codex");
    originalStore.updateSession(session.id, { status: "running", providerSessionId: "thread-replay" });
    const requirement = originalStore.getWorkflow(task.id)!.nodes.find((node) => node.kind === "requirement_analysis")!;
    originalStore.updateWorkflowNode(task.id, requirement.id, { status: "running", sessionId: session.id, attempt: 1, startedAt: new Date().toISOString() });
    originalStore.updateWorkflow(task.id, { status: "running", currentNodeId: requirement.id });
    originalStore.addEvent(task.id, session.id, "turn.started", { prompt: "整理需求" });
    originalStore.addEvent(task.id, session.id, "message.completed", { item: { type: "agentMessage", text: "# 恢复后的需求规格\n\nFR-001" } });
    originalStore.addEvent(task.id, session.id, "turn.completed", { turn: { status: "completed" } });
    originalStore.close();

    const store = new Store(databasePath);
    const events = new EventBus(store);
    const adapter: AgentAdapter = {
      provider: "codex",
      detect: async () => ({ provider: "codex", installed: true, command: "codex" }),
      start: async () => {}, resume: async () => {}, steer: async () => {},
      resolve: async () => {}, interrupt: async () => {},
    };
    const engine = new WorkflowEngine(store, events, new Orchestrator(store, events, [adapter]));
    expect(await engine.recoverInterruptedWorkflows()).toBe(1);

    const recovered = store.getTask(task.id)!;
    expect(recovered.status).toBe("pending_requirement_confirmation");
    expect(recovered.workflow?.status).toBe("waiting_user");
    expect(recovered.workflow?.artifacts.find((artifact) => artifact.kind === "requirement")?.content).toContain("FR-001");
    expect(recovered.activities.at(-1)).toMatchObject({
      type: "workflow.recovered",
      payload: { strategy: "replay_terminal_event" },
    });
    store.close();
  }, 20_000);
});
