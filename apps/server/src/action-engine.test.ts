import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionEngine } from "./action-engine.js";
import { EventBus } from "./event-bus.js";
import type { Orchestrator } from "./orchestrator.js";
import { Store } from "./store.js";
import type { KnowledgeRetrievalService } from "./knowledge-retrieval.js";

const tempDirs: string[] = [];

function setup(provider: "codex" | "qoder" = "codex") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-actions-"));
  tempDirs.push(dir);
  const store = new Store(path.join(dir, "test.db"));
  const events = new EventBus(store);
  const start = vi.fn((taskId: string) => store.createSession(taskId, provider));
  const interrupt = vi.fn(async (taskId: string) => {
    const task = store.getTask(taskId);
    const session = task?.sessions.find((item) => ["starting", "running", "waiting_user"].includes(item.status));
    if (session) store.updateSession(session.id, { status: "cancelled" });
  });
  const orchestrator = { start, interrupt } as unknown as Orchestrator;
  return { store, events, start, interrupt, engine: new ActionEngine(store, events, orchestrator) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ActionEngine", () => {
  it("offers plan or direct development without a workflow template", async () => {
    const { store, engine, start } = setup("qoder");
    const task = store.createTask({ title: "dynamic flow", provider: "qoder", repositories: [] });

    expect(engine.availableActions(task.id).map((action) => action.type)).toEqual(["generate_plan", "start_development"]);
    await engine.execute(task.id, { type: "generate_plan" });

    expect(start).toHaveBeenCalledWith(task.id, expect.objectContaining({ mode: "planning", prompt: expect.stringContaining("/plan") }));
    expect(store.getTask(task.id)?.actions.at(-1)).toMatchObject({ type: "generate_plan", status: "running" });
    expect(engine.availableActions(task.id)).toEqual([]);
    store.close();
  });

  it("only offers plan confirmation after planning and starts development immediately when accepted", async () => {
    const { store, engine, start } = setup();
    const task = store.createTask({ title: "accept and develop", provider: "codex", repositories: [] });
    const planning = store.createAction(task.id, "generate_plan");
    store.updateAction(planning.id, { status: "succeeded", completedAt: new Date().toISOString() });
    const plan = store.addArtifact(task.id, planning.id, {
      kind: "plan",
      title: "开发计划",
      content: "先实现核心逻辑，再补充测试。",
      metadata: { status: "draft" },
    });

    expect(engine.availableActions(task.id).map((action) => action.type)).toEqual(["revise_plan", "accept_plan"]);

    await engine.execute(task.id, { type: "accept_plan", artifactId: plan.id });

    const updated = store.getTask(task.id)!;
    expect(updated.artifacts.find((artifact) => artifact.id === plan.id)?.metadata.status).toBe("accepted");
    expect(updated.actions.slice(-2).map((action) => [action.type, action.status])).toEqual([
      ["accept_plan", "succeeded"],
      ["start_development", "running"],
    ]);
    expect(start).toHaveBeenLastCalledWith(task.id, expect.objectContaining({
      mode: "development",
      prompt: expect.stringContaining("先实现核心逻辑，再补充测试。"),
    }));
    expect(engine.availableActions(task.id)).toEqual([]);
    store.close();
  });

  it("offers review, acceptance, direct rework, checkpoint and final delivery after development", () => {
    const { store, engine } = setup();
    const task = store.createTask({ title: "review choices", provider: "codex", repositories: [] });
    const action = store.createAction(task.id, "start_development");
    store.updateAction(action.id, { status: "succeeded", completedAt: new Date().toISOString() });
    store.addArtifact(task.id, action.id, { kind: "development", title: "开发完成", content: "done", metadata: {} });

    expect(engine.availableActions(task.id).map((item) => item.type)).toEqual([
      "request_changes",
      "run_code_review",
      "run_acceptance",
      "checkpoint_and_continue",
      "deliver",
    ]);
    store.close();
  });

  it("marks the active action interrupted so another choice can be made", async () => {
    const { store, engine, interrupt } = setup();
    const task = store.createTask({ title: "interrupt", provider: "codex", repositories: [] });
    const action = store.createAction(task.id, "generate_plan");
    const session = store.createSession(task.id, "codex");
    store.updateSession(session.id, { status: "running" });
    store.updateAction(action.id, { status: "running", sessionId: session.id });

    await engine.interrupt(task.id);

    expect(interrupt).toHaveBeenCalledWith(task.id);
    expect(store.getTask(task.id)?.actions.at(-1)?.status).toBe("interrupted");
    expect(store.getTask(task.id)?.status).toBe("interrupted");
    expect(engine.availableActions(task.id).map((item) => item.type)).toEqual(["generate_plan", "start_development"]);
    store.close();
  });

  it("does not leave a pending action when the agent cannot start", async () => {
    const { store, events } = setup();
    const task = store.createTask({ title: "missing agent", provider: "codex", repositories: [] });
    const orchestrator = { start: () => { throw new Error("agent unavailable"); } } as unknown as Orchestrator;
    const engine = new ActionEngine(store, events, orchestrator);

    await expect(engine.execute(task.id, { type: "generate_plan" })).rejects.toThrow("agent unavailable");

    expect(store.getTask(task.id)?.actions.at(-1)?.status).toBe("failed");
    expect(engine.availableActions(task.id).map((item) => item.type)).toEqual(["generate_plan", "start_development"]);
    store.close();
  });

  it("runs a bounded retrieval action before coding when a knowledge repository is associated", async () => {
    const { store, events, start } = setup();
    const repository = store.createKnowledgeRepository({ name: "Product", sourcePath: "E:/knowledge/product", defaultBranch: "main" });
    const task = store.createTask({ title: "order lifecycle", provider: "codex", repositories: [], knowledgeRepositoryIds: [repository.id] });
    const retrieval = {
      collect: vi.fn(async () => ({ query: "order lifecycle", keywords: ["order"], candidates: [{
        knowledgeRepositoryId: repository.id, repositoryName: "Product", path: "wiki/order.md",
        absolutePath: "E:/knowledge/product/wiki/order.md", anchor: "Close order", excerpt: "Closed orders cannot be restored.", score: 10, matchedKeywords: ["order"],
      }] })),
    } as unknown as KnowledgeRetrievalService;
    const engine = new ActionEngine(store, events, { start, interrupt: vi.fn() } as unknown as Orchestrator, retrieval);

    await engine.execute(task.id, { type: "start_development" });

    expect(retrieval.collect).toHaveBeenCalledOnce();
    expect(store.getTask(task.id)?.actions.at(-1)).toMatchObject({ type: "retrieve_knowledge", status: "running" });
    expect(start).toHaveBeenLastCalledWith(task.id, expect.objectContaining({ mode: "review", prompt: expect.stringContaining("wiki/order.md") }));
    store.close();
  });
});
