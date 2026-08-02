import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../event-bus.js";
import { Store } from "../store.js";
import { QwenCodeAdapter } from "./qwen-code-adapter.js";
import type { StartAgentInput } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("QwenCodeAdapter stream events", () => {
  it("stores the provider session and maps stream-json messages to the shared timeline", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-qwen-code-"));
    tempDirs.push(dir);
    const store = new Store(path.join(dir, "test.db"));
    const events = new EventBus(store);
    const task = store.createTask({ title: "Qwen task", provider: "qwen-code", repositories: [] });
    const session = store.createSession(task.id, "qwen-code");
    const adapter = new QwenCodeAdapter(store, events);
    const input: StartAgentInput = {
      taskId: task.id,
      sessionId: session.id,
      cwd: dir,
      prompt: "Implement it",
    };
    const handleMessage = (adapter as unknown as {
      handleMessage(input: StartAgentInput, raw: Record<string, unknown>): void;
    }).handleMessage.bind(adapter);

    handleMessage(input, {
      type: "stream_event",
      session_id: "qwen-session-1",
      event: { delta: { type: "text_delta", text: "working" } },
    });
    handleMessage(input, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-1", name: "write_file", input: { path: "a.ts" } }] },
    });
    handleMessage(input, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
    });
    handleMessage(input, {
      type: "result",
      subtype: "success",
      result: "done",
      duration_ms: 120,
    });

    expect(store.getTask(task.id)?.sessions[0]?.providerSessionId).toBe("qwen-session-1");
    expect(store.events(task.id).map((event) => event.type)).toEqual([
      "message.delta",
      "tool.started",
      "tool.completed",
      "message.completed",
    ]);
    store.close();
  });
});
