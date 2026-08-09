import type {
  AgentEvent,
  AgentEventPage,
  AgentEventPageMode,
  AvailableAction,
  CreateTaskInput,
  ExecuteActionInput,
  HealthResponse,
  Material,
  RegisteredRepository,
  ResolveInteractionInput,
  SaveRegisteredRepositoryInput,
  RepositoryDiff,
  Task,
  TaskCollection,
} from "@agentdesk/protocol";

const API = import.meta.env.VITE_API_BASE ?? "";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${url}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `请求失败：${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<HealthResponse>("/api/health"),
  availableActions: (taskId: string) => request<AvailableAction[]>(`/api/tasks/${taskId}/available-actions`),
  executeAction: (taskId: string, input: ExecuteActionInput) => request<Task>(`/api/tasks/${taskId}/actions`, { method: "POST", body: JSON.stringify(input) }),
  tasks: () => request<Task[]>("/api/tasks"),
  collections: () => request<TaskCollection[]>("/api/task-collections"),
  registeredRepositories: () => request<RegisteredRepository[]>("/api/registered-repositories"),
  createRegisteredRepository: (input: SaveRegisteredRepositoryInput) =>
    request<RegisteredRepository>("/api/registered-repositories", { method: "POST", body: JSON.stringify(input) }),
  deleteRegisteredRepository: (id: string) =>
    request<{ ok: true }>(`/api/registered-repositories/${id}`, { method: "DELETE" }),
  createCollection: (input: { name: string; color?: string }) =>
    request<TaskCollection>("/api/task-collections", { method: "POST", body: JSON.stringify(input) }),
  task: (id: string) => request<Task>(`/api/tasks/${id}`),
  updateOrganization: (id: string, input: { tags: string[]; collectionId?: string | null }) =>
    request<Task>(`/api/tasks/${id}/organization`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  createTask: (input: CreateTaskInput) =>
    request<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  upload: (taskId: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<Material>(`/api/tasks/${taskId}/materials`, { method: "POST", body });
  },
  materialContent: (materialId: string) =>
    request<{ material: Material; content: string; truncated: boolean }>(
      `/api/materials/${materialId}/content`,
    ),
  deleteMaterial: (materialId: string) =>
    request<{ ok: true }>(`/api/materials/${materialId}`, { method: "DELETE" }),
  openPath: (
    taskId: string,
    input: { target: "workspace" | "repository"; repositoryId?: string },
  ) =>
    request<{ ok: true }>(`/api/tasks/${taskId}/open-path`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  addTaskRepository: (taskId: string, input: { registeredRepositoryId?: string; sourcePath?: string; baseBranch?: string }) =>
    request<{ task: Task; repository: Task["repositories"][number]; agentNotified: boolean }>(`/api/tasks/${taskId}/repositories`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  prepare: (taskId: string) =>
    request<Task>(`/api/tasks/${taskId}/prepare`, { method: "POST" }),
  followUp: (taskId: string, message: string, persist = true) =>
    request<{ mode: "steer" | "new_turn"; sessionId?: string }>(
      `/api/tasks/${taskId}/follow-ups`,
      {
        method: "POST",
        body: JSON.stringify({ message, persist }),
      },
    ),
  eventPage: (
    taskId: string,
    options: { before?: number; limit?: number; mode?: AgentEventPageMode } = {},
  ) => {
    const search = new URLSearchParams();
    if (options.before) search.set("before", String(options.before));
    if (options.limit) search.set("limit", String(options.limit));
    if (options.mode) search.set("mode", options.mode);
    return request<AgentEventPage>(
      `/api/tasks/${taskId}/events-page?${search.toString()}`,
    );
  },
  interrupt: (taskId: string) =>
    request(`/api/tasks/${taskId}/interrupt`, { method: "POST" }),
  diff: (taskId: string) =>
    request<RepositoryDiff[]>(`/api/tasks/${taskId}/diff`),
  resolve: (interactionId: string, input: ResolveInteractionInput) =>
    request(`/api/interactions/${interactionId}/resolve`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  eventSource: (taskId: string, after: number) =>
    new EventSource(`${API}/api/tasks/${taskId}/events?after=${after}`),
};

export function subscribeTaskEvents(
  taskId: string,
  after: number,
  onEvent: (event: AgentEvent) => void,
) {
  const source = api.eventSource(taskId, after);
  source.addEventListener("agent-event", (message) => {
    onEvent(JSON.parse((message as MessageEvent).data) as AgentEvent);
  });
  return () => source.close();
}
