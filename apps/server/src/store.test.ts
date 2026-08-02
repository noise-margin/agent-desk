import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./store.js";

const tempDirs: string[] = [];

function testStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-store-"));
  tempDirs.push(dir);
  return new Store(path.join(dir, "test.db"));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Store", () => {
  it("persists a task, repositories, material, session, events and interactions", () => {
    const store = testStore();
    const task = store.createTask({
      title: "退款链路改造",
      provider: "codex",
      requirement: "需要兼容旧接口",
      repositories: [{ sourcePath: "E:/code/order", baseBranch: "main" }],
    });

    expect(task.status).toBe("draft");
    expect(task.source).toEqual({ type: "manual", label: "直接创建", externalId: undefined });
    expect(task.repositories).toHaveLength(1);
    expect(task.materials[0]?.name).toBe("需求说明.md");
    expect(task.activities[0]).toMatchObject({
      type: "material.added",
      payload: { name: "需求说明.md" },
    });

    const originalMaterial = task.materials[0]!;
    expect(store.removeMaterial(originalMaterial.id)).toEqual(originalMaterial);
    store.addActivity(task.id, "material.removed", {
      materialId: originalMaterial.id,
      name: originalMaterial.name,
    });
    expect(store.getTask(task.id)?.materials).toHaveLength(0);
    expect(store.getMaterial(originalMaterial.id)?.deletedAt).toBeTruthy();
    expect(store.getTask(task.id)?.activities.map((item) => item.type)).toEqual([
      "material.added",
      "material.removed",
    ]);

    const session = store.createSession(task.id, "codex");
    const event = store.addEvent(task.id, session.id, "session.started", {
      provider: "codex",
    });
    expect(store.events(task.id)).toEqual([event]);

    const interaction = store.createInteraction({
      taskId: task.id,
      sessionId: session.id,
      agentRequestId: "rpc-1",
      method: "item/tool/requestUserInput",
      type: "user_question",
      payload: { questions: [{ id: "compat", question: "是否兼容？" }] },
    });
    expect(store.getTask(task.id)?.interactions[0]?.status).toBe("pending");
    expect(store.resolveInteraction(interaction.id, "answered")).toBe(true);
    expect(store.resolveInteraction(interaction.id, "answered")).toBe(false);

    const collection = store.createCollection({ name: "退款专项", color: "violet" });
    const organized = store.updateTaskOrganization(task.id, {
      tags: ["后端", "紧急", "后端"],
      collectionId: collection.id,
    });
    expect(organized.tags).toEqual(["后端", "紧急"]);
    expect(organized.collection).toEqual(collection);
    expect(store.listCollections()).toEqual([collection]);

    const registered = store.createRegisteredRepository({
      name: "Order Service",
      sourcePath: "E:/code/order",
      defaultBranch: "main",
    });
    expect(store.listRegisteredRepositories()).toEqual([registered]);
    expect(store.deleteRegisteredRepository(registered.id)).toBe(true);
    expect(store.listRegisteredRepositories()).toEqual([]);
    store.close();
  });

  it("paginates raw events and removes noisy deltas from the timeline view", () => {
    const store = testStore();
    const task = store.createTask({
      title: "分页测试",
      provider: "codex",
      repositories: [],
    });
    const session = store.createSession(task.id, "codex");
    store.addEvent(task.id, session.id, "session.started");
    store.addEvent(task.id, session.id, "message.delta", { text: "逐字输出" });
    store.addEvent(task.id, session.id, "message.completed", {
      item: { type: "agentMessage", text: "完整回复" },
    });
    store.addEvent(task.id, session.id, "command.completed", {
      item: { type: "commandExecution", command: "npm test", exitCode: 0 },
    });

    const timeline = store.eventPage(task.id, { limit: 10, mode: "timeline" });
    expect(timeline.events.map((event) => event.type)).toEqual([
      "session.started",
      "message.completed",
      "command.completed",
    ]);

    const latestRaw = store.eventPage(task.id, { limit: 2, mode: "raw" });
    expect(latestRaw.events).toHaveLength(2);
    expect(latestRaw.hasMore).toBe(true);
    const earlierRaw = store.eventPage(task.id, {
      before: latestRaw.nextBefore,
      limit: 2,
      mode: "raw",
    });
    expect(earlierRaw.events.map((event) => event.type)).toEqual([
      "session.started",
      "message.delta",
    ]);
    store.close();
  });

  it("marks active execution state as interrupted instead of failed after restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-store-restart-"));
    tempDirs.push(dir);
    const databasePath = path.join(dir, "test.db");
    const store = new Store(databasePath);
    const task = store.createTask({
      title: "restart recovery",
      provider: "codex",
      repositories: [],
      workflow: { templateId: "fast" },
    });
    const session = store.createSession(task.id, "codex");
    store.updateSession(session.id, { status: "waiting_user", providerSessionId: "thread-restart" });
    const development = store.getWorkflow(task.id)!.nodes.find((node) => node.kind === "development")!;
    store.updateWorkflowNode(task.id, development.id, { status: "running", sessionId: session.id, startedAt: new Date().toISOString() });
    store.updateWorkflow(task.id, { status: "running", currentNodeId: development.id });
    store.updateTask(task.id, { status: "waiting_user" });
    const interaction = store.createInteraction({
      taskId: task.id,
      sessionId: session.id,
      agentRequestId: "rpc-restart",
      method: "tool/requestUserInput",
      type: "user_question",
      payload: { question: "请选择实现方式" },
    });
    store.close();

    const reopened = new Store(databasePath);
    const recoveredTask = reopened.getTask(task.id)!;
    expect(recoveredTask.status).toBe("interrupted");
    expect(recoveredTask.sessions.find((item) => item.id === session.id)?.status).toBe("interrupted");
    expect(recoveredTask.interactions.find((item) => item.id === interaction.id)?.status).toBe("stale");
    expect(recoveredTask.workflow?.status).toBe("interrupted");
    expect(recoveredTask.workflow?.nodes.find((node) => node.id === development.id)?.status).toBe("interrupted");
    expect(recoveredTask.activities.at(-1)).toMatchObject({ type: "workflow.interrupted" });
    reopened.close();
  });
});
