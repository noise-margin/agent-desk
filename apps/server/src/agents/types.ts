import type {
  AgentInstallation,
  AgentProvider,
  ResolveInteractionInput,
} from "@agentdesk/protocol";

export interface StartAgentInput {
  taskId: string;
  sessionId: string;
  cwd: string;
  prompt: string;
  mode?: "requirements" | "development" | "review" | "acceptance" | "knowledge";
}

export interface AgentAdapter {
  readonly provider: AgentProvider;
  detect(): Promise<AgentInstallation>;
  start(input: StartAgentInput): Promise<void>;
  resume?(input: StartAgentInput, providerSessionId: string): Promise<void>;
  steer?(sessionId: string, message: string): Promise<void>;
  resolve(interactionId: string, response: ResolveInteractionInput): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
}
