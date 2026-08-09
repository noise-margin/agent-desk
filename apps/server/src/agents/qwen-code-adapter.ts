import type {
  AgentInstallation,
  ResolveInteractionInput,
} from "@agentdesk/protocol";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { config } from "../config.js";
import { EventBus } from "../event-bus.js";
import { detectCommand, spawn } from "../lib/process.js";
import { Store } from "../store.js";
import type { AgentAdapter, StartAgentInput } from "./types.js";

interface Runtime {
  input: StartAgentInput;
  child: ChildProcessWithoutNullStreams;
  interrupted: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function textBlocks(message: Record<string, unknown> | undefined) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.map(record).filter((block): block is Record<string, unknown> => Boolean(block));
}

export class QwenCodeAdapter implements AgentAdapter {
  readonly provider = "qwen-code" as const;
  private readonly runtimes = new Map<string, Runtime>();

  constructor(
    private readonly store: Store,
    private readonly events: EventBus,
  ) {}

  async detect(): Promise<AgentInstallation> {
    const result = await detectCommand(config.qwenCodeCommand, ["--version"], {
      shell: process.platform === "win32",
    });
    return { provider: this.provider, command: config.qwenCodeCommand, ...result };
  }

  async start(input: StartAgentInput): Promise<void> {
    await this.run(input);
  }

  async resume(input: StartAgentInput, providerSessionId: string): Promise<void> {
    await this.run(input, providerSessionId);
  }

  async resolve(_interactionId: string, _response: ResolveInteractionInput): Promise<void> {
    throw new Error("Qwen Code 当前使用无头自动审批模式，没有待处理的交互请求");
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.interrupted = true;
    runtime.child.kill("SIGINT");
    this.store.updateSession(sessionId, { status: "cancelled" });
    this.store.updateTask(runtime.input.taskId, { status: "cancelled" });
    this.events.publish(runtime.input.taskId, sessionId, "session.status", {
      status: "cancelled",
    });
  }

  private async run(input: StartAgentInput, providerSessionId?: string): Promise<void> {
    const args = [
      ...(providerSessionId ? ["--resume", providerSessionId] : []),
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--approval-mode",
      "auto",
    ];
    const child = spawn(config.qwenCodeCommand, args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    child.stdin.end(input.prompt);
    const runtime: Runtime = { input, child, interrupted: false };
    this.runtimes.set(input.sessionId, runtime);
    this.store.updateSession(input.sessionId, { status: "running" });
    this.events.publish(
      input.taskId,
      input.sessionId,
      providerSessionId ? "session.resumed" : "session.started",
      { provider: this.provider, providerSessionId },
    );
    const materials = this.store.getTask(input.taskId)?.materials ?? [];
    this.events.publish(input.taskId, input.sessionId, "turn.started", {
      prompt: input.prompt,
      materials: materials.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-12_000);
      this.events.publish(input.taskId, input.sessionId, "system.notice", {
        level: "info",
        message: chunk.trim(),
      });
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.handleMessage(input, JSON.parse(line) as Record<string, unknown>);
      } catch {
        this.events.publish(input.taskId, input.sessionId, "system.notice", {
          level: "warning",
          message: line,
        });
      }
    });

    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      if (runtime.interrupted) return;
      if (exit.code !== 0) {
        throw new Error(
          stderr.trim() || `Qwen Code 退出异常（code=${exit.code}, signal=${exit.signal ?? "none"}）`,
        );
      }
      this.store.updateSession(input.sessionId, { status: "completed" });
      this.events.publish(input.taskId, input.sessionId, "turn.completed", {});
    } catch (error) {
      if (runtime.interrupted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateSession(input.sessionId, { status: "failed" });
      this.events.publish(input.taskId, input.sessionId, "turn.failed", { error: message });
    } finally {
      this.runtimes.delete(input.sessionId);
    }
  }

  private handleMessage(input: StartAgentInput, raw: Record<string, unknown>) {
    const providerSessionId = typeof raw.session_id === "string" ? raw.session_id : undefined;
    if (providerSessionId) {
      this.store.updateSession(input.sessionId, { providerSessionId });
    }

    if (raw.type === "stream_event") {
      const event = record(raw.event);
      const delta = record(event?.delta);
      if (delta?.type === "text_delta") {
        this.events.publish(input.taskId, input.sessionId, "message.delta", {
          text: delta.text ?? "",
        });
      } else if (delta?.type === "thinking_delta") {
        this.events.publish(input.taskId, input.sessionId, "reasoning", {
          text: delta.thinking ?? "",
        });
      }
      return;
    }

    if (raw.type === "assistant") {
      for (const block of textBlocks(record(raw.message))) {
        if (block.type === "tool_use") {
          const name = String(block.name ?? "tool");
          this.events.publish(input.taskId, input.sessionId, "tool.started", {
            id: block.id,
            name,
            input: block.input,
          });
        }
      }
      return;
    }

    if (raw.type === "user") {
      for (const block of textBlocks(record(raw.message))) {
        if (block.type === "tool_result") {
          this.events.publish(input.taskId, input.sessionId, "tool.completed", {
            id: block.tool_use_id,
            content: block.content,
            isError: block.is_error,
          });
        }
      }
      return;
    }

    if (raw.type === "result") {
      this.events.publish(input.taskId, input.sessionId, "message.completed", {
        result: raw.result,
        subtype: raw.subtype,
        usage: raw.usage,
        durationMs: raw.duration_ms,
      });
      return;
    }

    if (raw.type === "system" && raw.subtype !== "session_start") {
      this.events.publish(input.taskId, input.sessionId, "system.notice", {
        level: raw.subtype === "permission_denied" ? "warning" : "info",
        message: raw.message ?? raw.subtype,
      });
    }
  }
}
