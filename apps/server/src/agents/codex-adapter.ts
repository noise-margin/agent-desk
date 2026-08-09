import readline from "node:readline";
import type {
  AgentInstallation,
  InteractionType,
  ResolveInteractionInput,
} from "@agentdesk/protocol";
import { buildInteractionResolutionPresentation } from "../interaction-presentation.js";
import { config } from "../config.js";
import { EventBus } from "../event-bus.js";
import { detectCommand, spawn } from "../lib/process.js";
import { Store } from "../store.js";
import type { AgentAdapter, StartAgentInput } from "./types.js";

interface RpcRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface CodexRuntime {
  input: StartAgentInput;
  process: ReturnType<typeof spawn>;
  nextId: number;
  pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void }>;
  interactions: Map<string, number | string>;
  threadId?: string;
  turnId?: string;
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = "codex" as const;
  private readonly runtimes = new Map<string, CodexRuntime>();

  constructor(
    private readonly store: Store,
    private readonly events: EventBus,
  ) {}

  async detect(): Promise<AgentInstallation> {
    const result = await detectCommand(config.codexCommand, [
      ...config.codexBaseArgs,
      "--version",
    ]);
    return {
      provider: this.provider,
      command: [config.codexCommand, ...config.codexBaseArgs].join(" "),
      ...result,
    };
  }

  async start(input: StartAgentInput): Promise<void> {
    await this.connect(input);
  }

  async resume(input: StartAgentInput, providerSessionId: string): Promise<void> {
    this.store.updateSession(input.sessionId, { status: "starting" });
    const runtime = this.runtimes.get(input.sessionId);
    if (!runtime || runtime.threadId !== providerSessionId) {
      if (runtime) {
        runtime.process.kill();
        this.runtimes.delete(input.sessionId);
      }
      await this.connect(input, providerSessionId);
      return;
    }

    runtime.input = input;
    runtime.turnId = undefined;
    this.store.updateSession(input.sessionId, { status: "running" });
    this.events.publish(input.taskId, input.sessionId, "session.resumed", {
      provider: "codex",
      providerSessionId,
    });
    await this.startTurn(runtime, input.prompt);
  }

  private async connect(input: StartAgentInput, providerSessionId?: string): Promise<void> {
    const child = spawn(config.codexCommand, [...config.codexBaseArgs, "app-server"], {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const runtime: CodexRuntime = {
      input,
      process: child,
      nextId: 1,
      pending: new Map(),
      interactions: new Map(),
    };
    this.runtimes.set(input.sessionId, runtime);

    child.stderr?.on("data", (chunk) => {
      const message = String(chunk);
      if (!/"level":"(?:WARN|ERROR)"/.test(message)) return;
      this.events.publish(input.taskId, input.sessionId, "system.notice", {
        level: "warning",
        message,
      });
    });
    child.on("error", (error) => this.fail(runtime, error));
    child.on("exit", (code, signal) => {
      if (this.runtimes.get(input.sessionId) === runtime) {
        this.runtimes.delete(input.sessionId);
        const sessionStatus = this.store.getTask(input.taskId)?.sessions.find((session) => session.id === input.sessionId)?.status;
        if (code !== 0 && sessionStatus && ["starting", "running", "waiting_user"].includes(sessionStatus)) {
          this.fail(runtime, new Error(`Codex App Server exited (${code ?? signal})`));
        }
      }
    });

    const lines = readline.createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.handleMessage(runtime, JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        this.events.publish(input.taskId, input.sessionId, "system.notice", {
          level: "error",
          message: `无法解析 Codex 消息：${String(error)}`,
          raw: line,
        });
      }
    });

    await this.request(runtime, "initialize", {
      clientInfo: { name: "agentdesk", version: config.version },
      capabilities: { experimentalApi: true },
    });
    this.notify(runtime, "initialized", {});
    const started = (await this.request(
      runtime,
      providerSessionId ? "thread/resume" : "thread/start",
      providerSessionId ? { threadId: providerSessionId, cwd: input.cwd } : { cwd: input.cwd },
    )) as { thread?: { id?: string }; id?: string };
    const threadId = started.thread?.id ?? started.id ?? providerSessionId;
    if (!threadId) throw new Error("Codex 未返回 thread id");
    runtime.threadId = threadId;
    this.store.updateSession(input.sessionId, {
      providerSessionId: threadId,
      status: "running",
    });
    this.events.publish(
      input.taskId,
      input.sessionId,
      providerSessionId ? "session.resumed" : "session.started",
      {
      provider: "codex",
      providerSessionId: threadId,
      },
    );
    await this.startTurn(runtime, input.prompt);
  }

  private async startTurn(runtime: CodexRuntime, prompt: string) {
    if (!runtime.threadId) throw new Error("Codex thread is not ready");
    const turnStarted = (await this.request(runtime, "turn/start", {
      threadId: runtime.threadId,
      input: [{ type: "text", text: prompt }],
      cwd: runtime.input.cwd,
      approvalPolicy: "on-request",
      sandboxPolicy: {
        ...(["requirements", "review", "acceptance"].includes(runtime.input.mode ?? "")
          ? { type: "readOnly" }
          : {
              type: "workspaceWrite",
              writableRoots: [runtime.input.cwd],
              networkAccess: false,
            }),
      },
    })) as { turn?: { id?: string }; id?: string };
    runtime.turnId = turnStarted.turn?.id ?? turnStarted.id;
    if (!runtime.turnId) throw new Error("Codex did not return a turn id");
    const materials = this.store.getTask(runtime.input.taskId)?.materials ?? [];
    this.events.publish(runtime.input.taskId, runtime.input.sessionId, "turn.started", {
      turnId: runtime.turnId,
      prompt,
      materials: materials.map((material) => ({
        id: material.id,
        name: material.name,
        createdAt: material.createdAt,
      })),
    });
  }

  async resolve(interactionId: string, response: ResolveInteractionInput): Promise<void> {
    const interaction = this.store.getInteraction(interactionId);
    if (!interaction || interaction.status !== "pending") {
      throw new Error("交互请求不存在或已经处理");
    }
    const runtime = this.runtimes.get(interaction.sessionId);
    const rpcId = runtime?.interactions.get(interactionId);
    if (!runtime || rpcId === undefined) throw new Error("Codex 会话已结束，无法继续回答");

    let result: unknown;
    if (interaction.type === "user_question") {
      result = {
        answers: Object.fromEntries(
          Object.entries(response.answers ?? {}).map(([questionId, answers]) => [
            questionId,
            { answers },
          ]),
        ),
      };
    } else if (interaction.type === "elicitation") {
      result = {
        action: response.action,
        content: response.action === "accept" ? response.content ?? response.answers ?? null : null,
      };
    } else if (interaction.type === "permission_approval") {
      result = response.content ?? { permissions: [], scope: "turn" };
    } else {
      result = {
        decision:
          response.decision ??
          (response.action === "accept"
            ? "accept"
            : response.action === "cancel"
              ? "cancel"
              : "decline"),
      };
    }
    this.send(runtime, { id: rpcId, result });
    runtime.interactions.delete(interactionId);
    this.store.resolveInteraction(
      interactionId,
      response.action === "accept"
        ? "answered"
        : response.action === "cancel"
          ? "cancelled"
          : "declined",
    );
    this.store.updateSession(interaction.sessionId, { status: "running" });
    this.events.publish(interaction.taskId, interaction.sessionId, "interaction.resolved", {
      interactionId,
      action: response.action,
      resolution: buildInteractionResolutionPresentation({
        type: interaction.type,
        payload: interaction.payload as Record<string, unknown>,
        response,
      }),
    });
  }

  async steer(sessionId: string, message: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime?.threadId || !runtime.turnId) {
      throw new Error("Codex 当前没有可介入的运行中会话");
    }
    await this.request(runtime, "turn/steer", {
      threadId: runtime.threadId,
      input: [{ type: "text", text: message }],
      expectedTurnId: runtime.turnId,
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    if (runtime.threadId && runtime.turnId) {
      await this.request(runtime, "turn/interrupt", {
        threadId: runtime.threadId,
        turnId: runtime.turnId,
      }).catch(() => {});
    }
    runtime.process.kill();
    this.runtimes.delete(sessionId);
    this.store.updateSession(sessionId, { status: "cancelled" });
    this.store.updateTask(runtime.input.taskId, { status: "cancelled" });
    this.events.publish(runtime.input.taskId, sessionId, "session.status", {
      status: "cancelled",
    });
  }

  private request(runtime: CodexRuntime, method: string, params: Record<string, unknown>) {
    const id = runtime.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      runtime.pending.set(id, { resolve, reject });
      this.send(runtime, { id, method, params });
      setTimeout(() => {
        const pending = runtime.pending.get(id);
        if (pending) {
          runtime.pending.delete(id);
          pending.reject(new Error(`Codex request timed out: ${method}`));
        }
      }, 30_000).unref();
    });
  }

  private notify(runtime: CodexRuntime, method: string, params: Record<string, unknown>) {
    this.send(runtime, { method, params });
  }

  private send(runtime: CodexRuntime, message: Record<string, unknown>) {
    runtime.process.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private handleMessage(runtime: CodexRuntime, message: Record<string, unknown>) {
    const id = message.id as number | string | undefined;
    if (id !== undefined && !message.method) {
      const pending = runtime.pending.get(Number(id));
      if (pending) {
        runtime.pending.delete(Number(id));
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
      return;
    }

    const method = String(message.method ?? "");
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (id !== undefined) {
      this.handleServerRequest(runtime, { id, method, params });
      return;
    }
    this.handleNotification(runtime, method, params);
  }

  private handleServerRequest(runtime: CodexRuntime, request: RpcRequest) {
    const method = request.method;
    const type: InteractionType =
      method.includes("requestUserInput") || method === "tool/requestUserInput"
        ? "user_question"
        : method.includes("commandExecution")
          ? "command_approval"
          : method.includes("fileChange")
            ? "file_approval"
            : method.includes("permissions")
              ? "permission_approval"
              : method.includes("elicitation")
                ? "elicitation"
                : "permission_approval";
    const interaction = this.store.createInteraction({
      taskId: runtime.input.taskId,
      sessionId: runtime.input.sessionId,
      agentRequestId: String(request.id),
      method,
      type,
      payload: request.params ?? {},
    });
    runtime.interactions.set(interaction.id, request.id);
    this.store.updateSession(runtime.input.sessionId, { status: "waiting_user" });
    this.events.publish(runtime.input.taskId, runtime.input.sessionId, "interaction.requested", {
      interaction,
    });
  }

  private handleNotification(
    runtime: CodexRuntime,
    method: string,
    params: Record<string, unknown>,
  ) {
    if (method === "item/agentMessage/delta") {
      this.events.publish(runtime.input.taskId, runtime.input.sessionId, "message.delta", {
        text: params.delta ?? params.text ?? "",
      });
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      this.events.publish(runtime.input.taskId, runtime.input.sessionId, "command.output", {
        content: params.delta ?? "",
      });
      return;
    }
    if (method === "turn/diff/updated") {
      this.events.publish(runtime.input.taskId, runtime.input.sessionId, "file.changed", params);
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = (params.item ?? {}) as Record<string, unknown>;
      const itemType = String(item.type ?? "tool");
      const eventType =
        itemType === "commandExecution"
          ? method === "item/started"
            ? "command.started"
            : "command.completed"
          : itemType === "agentMessage"
            ? "message.completed"
            : method === "item/started"
              ? "tool.started"
              : "tool.completed";
      this.events.publish(runtime.input.taskId, runtime.input.sessionId, eventType, { item });
      return;
    }
    if (method === "serverRequest/resolved") {
      this.events.publish(runtime.input.taskId, runtime.input.sessionId, "interaction.resolved", params);
      return;
    }
    if (method === "turn/completed") {
      const turn = (params.turn ?? params) as Record<string, unknown>;
      const status = String(turn.status ?? "completed");
      const failed = status === "failed";
      this.store.updateSession(runtime.input.sessionId, {
        status: failed ? "failed" : "completed",
      });
      this.events.publish(
        runtime.input.taskId,
        runtime.input.sessionId,
        failed ? "turn.failed" : "turn.completed",
        { turn },
      );
      return;
    }
    if (method) {
      this.events.publish(runtime.input.taskId, runtime.input.sessionId, "system.notice", {
        method,
        params,
      });
    }
  }

  private fail(runtime: CodexRuntime, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.store.updateSession(runtime.input.sessionId, { status: "failed" });
    this.store.updateTask(runtime.input.taskId, { status: "failed" });
    this.events.publish(runtime.input.taskId, runtime.input.sessionId, "turn.failed", {
      error: message,
    });
  }
}
