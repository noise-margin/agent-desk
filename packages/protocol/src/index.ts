export type AgentProvider = "codex" | "qoder" | "qwen-code";

export type TaskSourceType = "manual" | "aone" | "api" | "import";

export interface TaskSource {
  type: TaskSourceType;
  label: string;
  externalId?: string;
}

export interface TaskCollection {
  id: string;
  name: string;
  color?: string;
  createdAt: string;
}

export type TaskStatus =
  | "draft"
  | "preparing"
  | "defining_requirements"
  | "pending_requirement_confirmation"
  | "ready"
  | "running"
  | "waiting_user"
  | "pending_review"
  | "changes_requested"
  | "verifying"
  | "approved"
  | "discarded"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled";

export interface TaskRepositoryInput {
  sourcePath: string;
  baseBranch?: string;
}

export interface RegisteredRepository {
  id: string;
  name: string;
  sourcePath: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveRegisteredRepositoryInput {
  name?: string;
  sourcePath: string;
  defaultBranch?: string;
}

export interface TaskRepository extends TaskRepositoryInput {
  id: string;
  taskId: string;
  worktreePath?: string;
  taskBranch?: string;
  baseCommit?: string;
}

export interface Material {
  id: string;
  taskId: string;
  name: string;
  kind: "text" | "file";
  path?: string;
  content?: string;
  createdAt: string;
  deletedAt?: string;
}

export type TaskActivityType =
  | "material.added"
  | "material.removed"
  | "material.restored"
  | "repository.added"
  | "user.followup"
  | "workflow.configured"
  | "requirement.generated"
  | "review.approved"
  | "changes.requested"
  | "workflow.interrupted"
  | "workflow.recovered"
  | "workflow.recovery_failed"
  | "workflow.discarded";

export interface TaskActivity {
  id: number;
  taskId: string;
  type: TaskActivityType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type WorkflowNodeKind =
  | "requirement_analysis"
  | "human_requirement_approval"
  | "development"
  | "agent_review"
  | "agent_acceptance"
  | "knowledge_review"
  | "human_review"
  | "commit";

export type WorkflowNodeStatus =
  | "pending"
  | "running"
  | "waiting_user"
  | "succeeded"
  | "failed"
  | "changes_requested"
  | "interrupted"
  | "skipped";

export interface WorkflowNodeDefinition {
  id: string;
  kind: WorkflowNodeKind;
  name: string;
  prompt?: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNodeDefinition[];
}

export interface WorkflowNodeRun extends WorkflowNodeDefinition {
  status: WorkflowNodeStatus;
  attempt: number;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  output?: Record<string, unknown>;
}

export interface WorkflowArtifact {
  id: string;
  taskId: string;
  nodeId: string;
  kind: "requirement" | "review" | "acceptance" | "knowledge" | "test" | "diff" | "feedback" | "checkpoint" | "commit";
  title: string;
  content?: string;
  path?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowRun {
  id: string;
  taskId: string;
  templateId: string;
  name: string;
  status: "idle" | "running" | "waiting_user" | "changes_requested" | "interrupted" | "completed" | "failed";
  currentNodeId?: string;
  acceptanceCriteria?: string;
  nodes: WorkflowNodeRun[];
  artifacts: WorkflowArtifact[];
  createdAt: string;
  updatedAt: string;
}

export type CodeDiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unmerged" | "unknown";

export interface CodeDiffFile {
  path: string;
  oldPath?: string;
  status: CodeDiffFileStatus;
  staged: boolean;
  diff: string;
  binary?: boolean;
  truncated?: boolean;
}

export interface RepositoryDiff {
  path: string;
  files: CodeDiffFile[];
  additions: number;
  deletions: number;
}

export type AcceptanceVerdict = "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "INCONCLUSIVE";

export interface AcceptanceFinding {
  id: string;
  requirementId?: string;
  acceptanceId?: string;
  severity: "blocking" | "warning" | "info";
  title: string;
  expected?: string;
  actual?: string;
  reproductionSteps: string[];
  evidence?: {
    command?: string;
    output?: string;
    file?: string;
    path?: string;
  };
  suggestedDirection?: string;
}

export interface AcceptanceResult {
  verdict: AcceptanceVerdict;
  summary: string;
  findings: AcceptanceFinding[];
}

export interface AgentSession {
  id: string;
  taskId: string;
  provider: AgentProvider;
  providerSessionId?: string;
  status: "starting" | "running" | "waiting_user" | "interrupted" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export type InteractionType =
  | "user_question"
  | "command_approval"
  | "file_approval"
  | "permission_approval"
  | "elicitation";

export interface PendingInteraction {
  id: string;
  taskId: string;
  sessionId: string;
  agentRequestId: string;
  method: string;
  type: InteractionType;
  status: "pending" | "answered" | "declined" | "cancelled" | "stale";
  payload: unknown;
  presentation?: InteractionPresentation;
  createdAt: string;
  resolvedAt?: string;
}

export interface InteractionPresentation {
  category: "question" | "file_change" | "command" | "permission";
  title: string;
  description: string;
  risk: "low" | "medium" | "high";
  details: Array<{
    label: string;
    value: string;
    kind?: "file" | "command" | "scope" | "text";
  }>;
}

export interface InteractionResolutionPresentation {
  category: "answer" | "permission";
  outcome: "answered" | "approved" | "declined" | "cancelled";
  title: string;
  description: string;
  details: Array<{
    label: string;
    value: string;
  }>;
}

export type AgentEventType =
  | "user.followup"
  | "session.started"
  | "session.resumed"
  | "session.status"
  | "message.delta"
  | "message.completed"
  | "reasoning"
  | "plan.updated"
  | "command.started"
  | "command.output"
  | "command.completed"
  | "file.changed"
  | "tool.started"
  | "tool.completed"
  | "interaction.requested"
  | "interaction.resolved"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "system.notice";

export interface AgentEvent {
  id: number;
  taskId: string;
  sessionId: string;
  type: AgentEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentEventPage {
  events: AgentEvent[];
  hasMore: boolean;
  nextBefore?: number;
}

export type AgentEventPageMode = "timeline" | "raw";

export interface Task {
  id: string;
  title: string;
  description?: string;
  provider: AgentProvider;
  status: TaskStatus;
  workspacePath?: string;
  createdAt: string;
  updatedAt: string;
  source: TaskSource;
  tags: string[];
  collectionId?: string;
  collection?: TaskCollection;
  repositories: TaskRepository[];
  materials: Material[];
  sessions: AgentSession[];
  interactions: PendingInteraction[];
  activities: TaskActivity[];
  workflow?: WorkflowRun;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  provider: AgentProvider;
  requirement?: string;
  repositories: TaskRepositoryInput[];
  source?: TaskSource;
  tags?: string[];
  collectionId?: string;
  workflow?: {
    templateId: string;
    nodes?: WorkflowNodeDefinition[];
    acceptanceCriteria?: string;
  };
}

export interface StartRunInput {
  prompt: string;
  mode?: "requirements" | "development" | "review" | "acceptance" | "knowledge";
}

export interface FollowUpInput {
  message: string;
  persist?: boolean;
}

export interface ResolveInteractionInput {
  action: "accept" | "decline" | "cancel";
  answers?: Record<string, string[]>;
  content?: unknown;
  decision?: string;
}

export interface AgentInstallation {
  provider: AgentProvider;
  installed: boolean;
  command: string;
  version?: string;
  error?: string;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  agents: AgentInstallation[];
}
