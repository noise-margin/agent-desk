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
  | "ready"
  | "working"
  | "waiting_user"
  | "delivering"
  | "delivered"
  | "knowledge_pending"
  | "closed"
  | "archived"
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

export interface KnowledgeRepository {
  id: string;
  name: string;
  sourcePath: string;
  defaultBranch: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveKnowledgeRepositoryInput {
  name?: string;
  sourcePath: string;
  defaultBranch?: string;
  description?: string;
}

export interface TaskKnowledgeRepository {
  id: string;
  taskId: string;
  knowledgeRepositoryId: string;
  name: string;
  sourcePath: string;
  defaultBranch: string;
  description?: string;
  worktreePath?: string;
  taskBranch?: string;
  baseCommit?: string;
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
  | "acceptance.updated"
  | "repository.added"
  | "user.followup"
  | "action.started"
  | "action.completed"
  | "action.failed"
  | "action.interrupted"
  | "plan.accepted"
  | "changes.requested"
  | "knowledge.accepted"
  | "knowledge.rejected"
  | "task.archived"
  | "delivery.preflight_started"
  | "delivery.preflight_completed"
  | "delivery.commit_skipped"
  | "delivery.push_skipped"
  | "delivery.agent_started"
  | "delivery.remote_verifying"
  | "delivery.completed"
  | "delivery.needs_user";

export interface TaskActivity {
  id: number;
  taskId: string;
  type: TaskActivityType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type TaskAction =
  | "retrieve_knowledge"
  | "generate_plan"
  | "revise_plan"
  | "accept_plan"
  | "start_development"
  | "request_changes"
  | "run_code_review"
  | "run_acceptance"
  | "checkpoint_and_continue"
  | "deliver"
  | "generate_knowledge_proposal"
  | "revise_knowledge_proposal"
  | "accept_knowledge"
  | "reject_knowledge"
  | "archive";

export type ActionRunStatus =
  | "pending"
  | "running"
  | "waiting_user"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface ActionRun {
  id: string;
  taskId: string;
  type: TaskAction;
  status: ActionRunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  snapshotId?: string;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export type ActionArtifactKind = "plan" | "development" | "review" | "acceptance" | "delivery" | "knowledge" | "knowledge_retrieval" | "feedback" | "test";

export interface ActionArtifact {
  id: string;
  taskId: string;
  actionRunId: string;
  kind: ActionArtifactKind;
  title: string;
  content?: string;
  path?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CodeSnapshotRepository {
  repositoryId?: string;
  path: string;
  head: string;
  treeHash: string;
  diffHash: string;
}

export interface CodeSnapshot {
  id: string;
  taskId: string;
  repositories: CodeSnapshotRepository[];
  createdAt: string;
}

export interface AvailableAction {
  type: TaskAction;
  label: string;
  description: string;
  tone?: "primary" | "normal" | "danger";
  requiresInstruction?: boolean;
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
  knowledgeRepositories: TaskKnowledgeRepository[];
  materials: Material[];
  sessions: AgentSession[];
  interactions: PendingInteraction[];
  activities: TaskActivity[];
  actions: ActionRun[];
  artifacts: ActionArtifact[];
  snapshots: CodeSnapshot[];
  acceptanceCriteria?: string;
  deliveryTarget?: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  provider: AgentProvider;
  requirement?: string;
  repositories: TaskRepositoryInput[];
  knowledgeRepositoryIds?: string[];
  source?: TaskSource;
  tags?: string[];
  collectionId?: string;
  acceptanceCriteria?: string;
  deliveryTarget?: string;
}

export interface ExecuteActionInput {
  type: TaskAction;
  instruction?: string;
  feedback?: string;
  artifactId?: string;
}

export interface StartRunInput {
  prompt: string;
  mode?: "planning" | "requirements" | "development" | "review" | "acceptance" | "knowledge" | "delivery";
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
