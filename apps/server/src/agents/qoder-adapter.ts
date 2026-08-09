import type {
  AgentInstallation,
  ResolveInteractionInput,
} from "@agentdesk/protocol";
import { buildInteractionResolutionPresentation } from "../interaction-presentation.js";
import { randomUUID } from "node:crypto";
import {
  createSdkMcpServer,
  qodercliAuth,
  query,
  tool,
} from "@qoder-ai/qoder-agent-sdk";
import { z } from "zod";
import { config } from "../config.js";
import { EventBus } from "../event-bus.js";
import { detectCommand } from "../lib/process.js";
import { Store } from "../store.js";
import { deferred, type Deferred } from "./pending.js";
import type { AgentAdapter, StartAgentInput } from "./types.js";

interface Runtime {
  input: StartAgentInput;
  query?: { interrupt?: () => Promise<void> | void };
}

interface PendingDecision {
  kind: "question" | "approval";
  deferred: Deferred<ResolveInteractionInput>;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
}

export class QoderAdapter implements AgentAdapter {
  readonly provider = "qoder" as const;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly pending = new Map<string, PendingDecision>();

  constructor(
    private readonly store: Store,
    private readonly events: EventBus,
  ) {}

  async detect(): Promise<AgentInstallation> {
    const result = await detectCommand(config.qoderCommand);
    return { provider: this.provider, command: config.qoderCommand, ...result };
  }

  async start(input: StartAgentInput): Promise<void> {
    const runtime: Runtime = { input };
    this.runtimes.set(input.sessionId, runtime);

    const askUser = tool(
      "ask_user",
      "Ask the user a blocking clarification question when the answer materially changes the implementation.",
      {
        question: z.string(),
        options: z.array(z.string()).optional(),
        defaultAnswer: z.string().optional(),
      },
      async (args) => {
        const interaction = this.store.createInteraction({
          taskId: input.taskId,
          sessionId: input.sessionId,
          agentRequestId: randomUUID(),
          method: "mcp__agentdesk__ask_user",
          type: "user_question",
          payload: args,
        });
        const wait = deferred<ResolveInteractionInput>();
        this.pending.set(interaction.id, { kind: "question", deferred: wait });
        this.markWaiting(input, interaction.id, interaction);
        const response = await wait.promise;
        const answer =
          Object.values(response.answers ?? {}).flat().join("\n") ||
          String(response.content ?? "") ||
          args.defaultAnswer ||
          "";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ answer, action: response.action }),
            },
          ],
          isError: response.action !== "accept",
        };
      },
    );
    const mcp = createSdkMcpServer({ name: "agentdesk", tools: [askUser] });

    const q = query({
      prompt: `${input.prompt}

当缺失信息会实质影响实现方案时，必须调用 mcp__agentdesk__ask_user，不要自行假设。`,
      options: {
        auth: qodercliAuth(),
        cwd: input.cwd,
        includePartialMessages: true,
        permissionMode: "default",
        allowedTools: ["Read", "Glob", "Grep", "mcp__agentdesk__ask_user"],
        mcpServers: { agentdesk: mcp },
        canUseTool: async (
          toolName: string,
          toolInput: Record<string, unknown>,
          options: {
            signal: AbortSignal;
            toolUseID: string;
            title?: string;
            description?: string;
            displayName?: string;
          },
        ) => {
          if (
            toolName === "Read" ||
            toolName === "Glob" ||
            toolName === "Grep" ||
            toolName === "mcp__agentdesk__ask_user"
          ) {
            return {
              behavior: "allow" as const,
              updatedInput: toolInput,
              toolUseID: options.toolUseID,
            };
          }
          const interaction = this.store.createInteraction({
            taskId: input.taskId,
            sessionId: input.sessionId,
            agentRequestId: options.toolUseID,
            method: toolName,
            type: "command_approval",
            payload: {
              toolName,
              input: toolInput,
              title: options.title ?? options.displayName,
              description: options.description,
            },
          });
          const wait = deferred<ResolveInteractionInput>();
          this.pending.set(interaction.id, {
            kind: "approval",
            deferred: wait,
            toolName,
            toolInput,
            toolUseId: options.toolUseID,
          });
          this.markWaiting(input, interaction.id, interaction);
          const abort = () =>
            wait.resolve({ action: "cancel", decision: "cancelled by runtime" });
          options.signal.addEventListener("abort", abort, { once: true });
          const response = await wait.promise;
          options.signal.removeEventListener("abort", abort);
          if (response.action === "accept") {
            return {
              behavior: "allow" as const,
              updatedInput: toolInput,
              toolUseID: options.toolUseID,
            };
          }
          return {
            behavior: "deny" as const,
            message: response.action === "cancel" ? "Cancelled by user." : "Rejected by user.",
            interrupt: response.action === "cancel",
            toolUseID: options.toolUseID,
          };
        },
      },
    });
    runtime.query = q as unknown as Runtime["query"];
    this.store.updateSession(input.sessionId, { status: "running" });
    this.events.publish(input.taskId, input.sessionId, "session.started", {
      provider: "qoder",
    });
    const materials = this.store.getTask(input.taskId)?.materials ?? [];
    this.events.publish(input.taskId, input.sessionId, "turn.started", {
      prompt: input.prompt,
      materials: materials.map((material) => ({
        id: material.id,
        name: material.name,
        createdAt: material.createdAt,
      })),
    });

    try {
      for await (const raw of q) this.handleMessage(input, raw as unknown as Record<string, unknown>);
      this.store.updateSession(input.sessionId, { status: "completed" });
      this.events.publish(input.taskId, input.sessionId, "turn.completed", {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateSession(input.sessionId, { status: "failed" });
      this.events.publish(input.taskId, input.sessionId, "turn.failed", { error: message });
    } finally {
      this.runtimes.delete(input.sessionId);
    }
  }

  async resolve(interactionId: string, response: ResolveInteractionInput): Promise<void> {
    const interaction = this.store.getInteraction(interactionId);
    const pending = this.pending.get(interactionId);
    if (!interaction || interaction.status !== "pending" || !pending) {
      throw new Error("Qoder 交互请求不存在、已结束或服务已重启");
    }
    if (
      !this.store.resolveInteraction(
        interactionId,
        response.action === "accept"
          ? "answered"
          : response.action === "cancel"
            ? "cancelled"
            : "declined",
      )
    ) {
      throw new Error("该交互已经被处理");
    }
    this.pending.delete(interactionId);
    pending.deferred.resolve(response);
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

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    await runtime?.query?.interrupt?.();
    if (runtime) {
      this.store.updateSession(sessionId, { status: "cancelled" });
      this.store.updateTask(runtime.input.taskId, { status: "cancelled" });
      this.events.publish(runtime.input.taskId, sessionId, "session.status", {
        status: "cancelled",
      });
    }
    this.runtimes.delete(sessionId);
  }

  private markWaiting(
    input: StartAgentInput,
    interactionId: string,
    interaction: unknown,
  ) {
    this.store.updateSession(input.sessionId, { status: "waiting_user" });
    this.events.publish(input.taskId, input.sessionId, "interaction.requested", {
      interactionId,
      interaction,
    });
  }

  private handleMessage(input: StartAgentInput, raw: Record<string, unknown>) {
    const sessionId = typeof raw.session_id === "string" ? raw.session_id : undefined;
    if (sessionId) {
      this.store.updateSession(input.sessionId, { providerSessionId: sessionId });
    }
    if (raw.type === "stream_event") {
      const event = raw.event as Record<string, unknown> | undefined;
      const delta = event?.delta as Record<string, unknown> | undefined;
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
      const message = raw.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "tool_use") {
          this.events.publish(input.taskId, input.sessionId, "tool.started", {
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
      return;
    }
    if (raw.type === "result") {
      this.events.publish(input.taskId, input.sessionId, "message.completed", {
        result: raw.result,
        subtype: raw.subtype,
      });
      return;
    }
    if (raw.type === "system" && raw.subtype === "permission_denied") {
      this.events.publish(input.taskId, input.sessionId, "system.notice", {
        level: "warning",
        message: raw.message,
        toolName: raw.tool_name,
      });
    }
  }
}
