import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, StartAgentInput } from "./agents/types.js";
import { EventBus } from "./event-bus.js";
import { Orchestrator } from "./orchestrator.js";
import { Store } from "./store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Orchestrator follow-up", () => {
  it("reuses a completed Codex session and its thread for the next turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-orchestrator-"));
    tempDirs.push(dir);
    const store = new Store(path.join(dir, "test.db"));
    const events = new EventBus(store);
    const resume = vi.fn(async (_input: StartAgentInput, _threadId: string) => {});
    const adapter: AgentAdapter = {
      provider: "codex",
      detect: async () => ({ provider: "codex", installed: true, command: "codex" }),
      start: async () => {},
      resume,
      steer: async () => {},
      resolve: async () => {},
      interrupt: async () => {},
    };
    const task = store.createTask({ title: "calculator", provider: "codex", repositories: [] });
    store.updateTask(task.id, { workspacePath: dir, status: "ready" });
    const session = store.createSession(task.id, "codex");
    store.updateSession(session.id, { providerSessionId: "thread-123", status: "completed" });

    const orchestrator = new Orchestrator(store, events, [adapter]);
    const result = await orchestrator.followUp(task.id, "Only support addition and subtraction");
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());

    expect(result).toMatchObject({
      mode: "new_turn",
      sessionId: session.id,
      providerSessionId: "thread-123",
      reusedSession: true,
    });
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: session.id, prompt: "Only support addition and subtraction" }),
      "thread-123",
    );
    expect(store.getTask(task.id)?.sessions).toHaveLength(1);
    store.close();
  });

  it("starts a contextual recovery session when the provider cannot resume", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-orchestrator-fallback-"));
    tempDirs.push(dir);
    const store = new Store(path.join(dir, "test.db"));
    const events = new EventBus(store);
    const start = vi.fn(async (_input: StartAgentInput) => {});
    const adapter: AgentAdapter = {
      provider: "qoder",
      detect: async () => ({ provider: "qoder", installed: true, command: "qodercli" }),
      start,
      resolve: async () => {},
      interrupt: async () => {},
    };
    const task = store.createTask({ title: "qoder recovery", provider: "qoder", repositories: [] });
    store.updateTask(task.id, { workspacePath: dir, status: "interrupted" });
    const previous = store.createSession(task.id, "qoder");
    store.updateSession(previous.id, { providerSessionId: "qoder-old-session", status: "interrupted" });
    const orchestrator = new Orchestrator(store, events, [adapter]);

    const recovered = orchestrator.resumeSession(task.id, previous.id, "检查 diff 后继续完成", "development");
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(recovered.id).not.toBe(previous.id);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: recovered.id,
      prompt: expect.stringContaining("检查 diff 后继续完成"),
    }));
    store.close();
  });
});
