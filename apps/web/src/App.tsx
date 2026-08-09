import {
  Activity,
  AlertTriangle,
  Bot,
  BookOpen,
  Braces,
  Check,
  CheckCircle2,
  ChevronRight,
  ChevronsUp,
  CircleStop,
  Clock3,
  Code2,
  FileCode2,
  FileText,
  Folder,
  FolderGit2,
  GitBranch,
  GitCompare,
  LoaderCircle,
  MessageSquareText,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sparkles,
  TerminalSquare,
  Tags,
  Trash2,
  Upload,
  X,
  XCircle,
  Workflow,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentEvent,
  AgentProvider,
  CodeDiffFile,
  CreateTaskInput,
  InteractionResolutionPresentation,
  PendingInteraction,
  Task,
  TaskAction,
  TaskActivity,
  TaskRepositoryInput,
} from "@agentdesk/protocol";
import { api, subscribeTaskEvents } from "./api";

const statusText: Record<Task["status"], string> = {
  draft: "草稿",
  preparing: "准备中",
  ready: "工作区就绪",
  working: "执行中",
  waiting_user: "等待选择",
  delivering: "交付中",
  delivered: "代码已交付",
  knowledge_pending: "待确认知识提案",
  closed: "已关闭",
  archived: "已归档",
  interrupted: "恢复中",
  failed: "失败",
  cancelled: "已中止",
};

const statusTone: Record<Task["status"], string> = {
  draft: "neutral",
  preparing: "info",
  ready: "info",
  working: "active",
  waiting_user: "warning",
  delivering: "active",
  delivered: "success",
  knowledge_pending: "warning",
  closed: "success",
  archived: "neutral",
  interrupted: "warning",
  failed: "danger",
  cancelled: "neutral",
};

const agentMeta: Record<AgentProvider, { name: string; runtime: string }> = {
  codex: { name: "Codex", runtime: "App Server" },
  qoder: { name: "Qoder", runtime: "Agent SDK" },
  "qwen-code": { name: "Qwen Code", runtime: "Stream JSON CLI" },
};

const defaultDevelopmentPrompt =
  "请先阅读需求材料并分析关联仓库，给出实现方案。确认条件完整后再开始修改代码，完成后运行相关测试。";

function taskStatusLabel(task: Task) {
  return statusText[task.status];
}

function taskStatusTone(task: Task) {
  return statusTone[task.status];
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function shortPath(value?: string) {
  if (!value) return "尚未准备";
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : value;
}

function readableError(value: unknown) {
  const text = String(value ?? "本轮运行失败");
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    return String(parsed.message ?? parsed.error ?? text);
  } catch {
    return text;
  }
}

export function App() {
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [eventsBefore, setEventsBefore] = useState<number>();
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [toast, setToast] = useState<string>();
  const [taskSearch, setTaskSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [collectionFilter, setCollectionFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");

  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
  const collectionsQuery = useQuery({ queryKey: ["task-collections"], queryFn: api.collections });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health });
  const taskQuery = useQuery({
    queryKey: ["task", selectedId],
    queryFn: () => api.task(selectedId!),
    enabled: Boolean(selectedId),
  });

  useEffect(() => {
    if (!selectedId && tasksQuery.data?.[0]) setSelectedId(tasksQuery.data[0].id);
  }, [selectedId, tasksQuery.data]);

  useEffect(() => {
    setEvents([]);
    setEventsBefore(undefined);
    setEventsHasMore(false);
    if (!selectedId) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    setEventsLoading(true);
    void api.eventPage(selectedId, { limit: 60, mode: "timeline" }).then((page) => {
      if (!active) return;
      setEvents(page.events);
      setEventsBefore(page.nextBefore);
      setEventsHasMore(page.hasMore);
      setEventsLoading(false);
      const latestId = page.events.at(-1)?.id ?? 0;
      unsubscribe = subscribeTaskEvents(selectedId, latestId, (event) => {
        if (isTimelineEvent(event)) {
          setEvents((current) => {
            if (current.some((item) => item.id === event.id)) return current;
            return [...current, event].sort((a, b) => a.id - b.id).slice(-300);
          });
        }
        void client.invalidateQueries({ queryKey: ["task", selectedId] });
        void client.invalidateQueries({ queryKey: ["tasks"] });
      });
    }).catch(() => {
      if (active) setEventsLoading(false);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [client, selectedId]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(undefined), 3_000);
  };

  const selected = taskQuery.data;
  const taskTags = useMemo(() => [...new Set((tasksQuery.data ?? []).flatMap((task) => task.tags))].sort(), [tasksQuery.data]);
  const taskSources = useMemo(() => {
    const result = new Map<string, string>();
    for (const task of tasksQuery.data ?? []) result.set(task.source.type, task.source.label);
    return [...result.entries()];
  }, [tasksQuery.data]);
  const filteredTasks = useMemo(() => (tasksQuery.data ?? []).filter((task) => {
    const query = taskSearch.trim().toLocaleLowerCase();
    return (!query || `${task.title} ${task.description ?? ""} ${task.tags.join(" ")}`.toLocaleLowerCase().includes(query))
      && (statusFilter === "all" || task.status === statusFilter)
      && (sourceFilter === "all" || task.source.type === sourceFilter)
      && (tagFilter === "all" || task.tags.includes(tagFilter))
      && (agentFilter === "all" || task.provider === agentFilter)
      && (collectionFilter === "all" || (collectionFilter === "none" ? !task.collectionId : task.collectionId === collectionFilter));
  }), [tasksQuery.data, taskSearch, statusFilter, sourceFilter, tagFilter, agentFilter, collectionFilter]);
  const taskGroups = useMemo(() => {
    const groups = new Map<string, { name: string; tasks: Task[] }>();
    for (const task of filteredTasks) {
      const key = task.collectionId ?? "none";
      const group = groups.get(key) ?? { name: task.collection?.name ?? "未收纳", tasks: [] };
      group.tasks.push(task);
      groups.set(key, group);
    }
    return [...groups.entries()];
  }, [filteredTasks]);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Sparkles size={18} /></div>
          <div>
            <strong>AgentDesk</strong>
            <span>Local coding cockpit</span>
          </div>
        </div>

        <button className="primary-button new-task" onClick={() => setNewTaskOpen(true)}>
          <Plus size={16} />
          新建开发任务
        </button>

        <div className="sidebar-section-title">
          <span>开发任务</span>
          <button
            className="icon-button"
            aria-label="刷新任务"
            onClick={() => void tasksQuery.refetch()}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="task-filters">
          <label className="task-search"><Search size={13} /><input value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} placeholder="搜索任务或标签" /></label>
          <div className="task-filter-grid">
            <select aria-label="按状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">全部状态</option>
              {Object.entries(statusText).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
            <select aria-label="按来源筛选" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
              <option value="all">全部来源</option>
              {taskSources.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
            <select aria-label="按标签筛选" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
              <option value="all">全部标签</option>
              {taskTags.map((tag) => <option value={tag} key={tag}>#{tag}</option>)}
            </select>
            <select aria-label="按编码 Agent 筛选" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}>
              <option value="all">全部 Agent</option>
              {(Object.entries(agentMeta) as [AgentProvider, (typeof agentMeta)[AgentProvider]][]).map(([value, meta]) => <option value={value} key={value}>{meta.name}</option>)}
            </select>
            <select aria-label="按收纳筛选" value={collectionFilter} onChange={(event) => setCollectionFilter(event.target.value)}>
              <option value="all">全部收纳</option><option value="none">未收纳</option>
              {collectionsQuery.data?.map((collection) => <option value={collection.id} key={collection.id}>{collection.name}</option>)}
            </select>
          </div>
        </div>
        <nav className="task-list">
          {tasksQuery.isLoading && <SidebarSkeleton />}
          {taskGroups.map(([groupId, group]) => (
            <section className="task-group" key={groupId}>
              <div className="task-group-title"><Folder size={12} /><span>{group.name}</span><b>{group.tasks.length}</b></div>
              {group.tasks.map((task) => (
                <button key={task.id} className={`task-item ${selectedId === task.id ? "selected" : ""} ${task.interactions.some((item) => item.status === "pending") ? "needs-input" : ""}`} onClick={() => setSelectedId(task.id)}>
                  <span className={`status-dot ${taskStatusTone(task)}`} />
                  <span className="task-copy">
                    <strong>{task.title}</strong>
                    <span>{task.source.label}<b>·</b>{taskStatusLabel(task)}</span>
                    <span className="task-tag-line">
                      <i className="agent-badge"><Code2 size={9} />Coding · {agentMeta[task.provider].name}</i>
                      {task.tags.slice(0, 2).map((tag) => <i key={tag}>#{tag}</i>)}
                    </span>
                  </span>
                  {task.interactions.filter((item) => item.status === "pending").length > 0
                    ? <span className="task-attention-badge" title="Agent 正在等待你处理">{task.interactions.filter((item) => item.status === "pending").length}</span>
                    : <ChevronRight size={15} />}
                </button>
              ))}
            </section>
          ))}
          {!tasksQuery.isLoading && !tasksQuery.data?.length && (
            <div className="empty-sidebar">
              <Code2 size={22} />
              <span>还没有开发任务</span>
            </div>
          )}
          {!tasksQuery.isLoading && Boolean(tasksQuery.data?.length) && !filteredTasks.length && <div className="empty-sidebar"><Search size={20} /><span>没有符合筛选条件的任务</span></div>}
        </nav>

        <div className="agent-health">
          <div className="sidebar-section-title">
            <span>本地 Agent</span>
            <button className="icon-button" aria-label="应用设置" title="应用设置" onClick={() => setSettingsOpen(true)}><Settings2 size={14} /></button>
          </div>
          {healthQuery.data?.agents.map((agent) => (
            <div className="agent-row" key={agent.provider}>
              <Bot size={15} />
              <span>{agentMeta[agent.provider].name}</span>
              <i className={agent.installed ? "online" : "offline"} />
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {selected ? (
          <TaskDetail
            task={selected}
            events={events}
            eventsHasMore={eventsHasMore}
            eventsLoading={eventsLoading}
            onLoadOlder={async () => {
              if (!eventsBefore || eventsLoading) return;
              setEventsLoading(true);
              try {
                const page = await api.eventPage(selected.id, {
                  before: eventsBefore,
                  limit: 60,
                  mode: "timeline",
                });
                setEvents((current) => {
                  const known = new Set(current.map((event) => event.id));
                  return [...page.events.filter((event) => !known.has(event.id)), ...current];
                });
                setEventsBefore(page.nextBefore);
                setEventsHasMore(page.hasMore);
              } finally {
                setEventsLoading(false);
              }
            }}
            onChanged={() => {
              void taskQuery.refetch();
              void tasksQuery.refetch();
            }}
            notify={notify}
          />
        ) : (
          <Welcome onCreate={() => setNewTaskOpen(true)} />
        )}
      </main>

      {newTaskOpen && (
        <NewTaskDialog
          onClose={() => setNewTaskOpen(false)}
          onCreated={(task) => {
            setNewTaskOpen(false);
            setSelectedId(task.id);
            void client.invalidateQueries({ queryKey: ["tasks"] });
            notify("任务已创建");
          }}
        />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} notify={notify} />}
      {toast && (
        <div className="toast">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}

function TaskDetail({
  task,
  events,
  eventsHasMore,
  eventsLoading,
  onLoadOlder,
  onChanged,
  notify,
}: {
  task: Task;
  events: AgentEvent[];
  eventsHasMore: boolean;
  eventsLoading: boolean;
  onLoadOlder(): Promise<void>;
  onChanged(): void;
  notify(message: string): void;
}) {
  const [prompt, setPrompt] = useState(defaultDevelopmentPrompt);
  const [tab, setTab] = useState<"timeline" | "workbench">("workbench");
  const [debugOpen, setDebugOpen] = useState(false);
  const [previewMaterialId, setPreviewMaterialId] = useState<string>();
  const [addRepositoryOpen, setAddRepositoryOpen] = useState(false);
  const [addKnowledgeOpen, setAddKnowledgeOpen] = useState(false);
  const pending = task.interactions.filter((item) => item.status === "pending");
  const busy = task.sessions.some((session) => ["starting", "running", "waiting_user"].includes(session.status));

  useEffect(() => {
    setPrompt(defaultDevelopmentPrompt);
    setTab("workbench");
  }, [task.id]);

  const followUp = useMutation({
    mutationFn: () => api.followUp(task.id, prompt, true),
    onSuccess: (result) => {
      notify(result.mode === "steer" ? "补充要求已介入当前运行" : "已开始下一轮");
      setPrompt("");
      onChanged();
    },
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const material = await api.upload(task.id, file);
      if (busy && task.provider === "codex") {
        await api.followUp(
          task.id,
          `用户刚刚补充了材料 materials/${material.name}，请立即阅读并将其纳入当前工作。`,
          false,
        );
      }
      return material;
    },
    onSuccess: () => {
      notify(busy ? "材料已补充并通知当前 Agent" : "材料已补充");
      onChanged();
    },
  });
  const deleteMaterial = useMutation({
    mutationFn: (materialId: string) => api.deleteMaterial(materialId),
    onSuccess: () => {
      setPreviewMaterialId(undefined);
      notify("材料已从当前需求中移除，历史记录仍会保留");
      onChanged();
    },
  });
  const interrupt = useMutation({
    mutationFn: () => api.interrupt(task.id),
    onSuccess: () => {
      notify("已请求中止 Agent");
      onChanged();
    },
  });
  const openPath = useMutation({
    mutationFn: (input: { target: "workspace" | "repository"; repositoryId?: string }) =>
      api.openPath(task.id, input),
    onSuccess: () => notify("已在文件资源管理器中打开"),
  });

  const latestSession = task.sessions.find((session) => ["starting", "running", "waiting_user", "interrupted"].includes(session.status))
    ?? task.sessions[0];
  const latestSessionAction = [...task.actions].reverse().find((action) => action.sessionId === latestSession?.id);
  return (
    <div className="task-detail">
      <header className="task-header">
        <div className="task-title-wrap">
          <div className="eyebrow">
            <span>CODING · {agentMeta[task.provider].name.toLocaleUpperCase()}</span>
            <span>/{task.id.slice(0, 8)}</span>
          </div>
          <div className="title-line">
            <h1>{task.title}</h1>
            <span className={`status-pill ${taskStatusTone(task)}`}>
              {(task.status === "working" || task.status === "delivering") && <span className="pulse" />}
              {taskStatusLabel(task)}
            </span>
          </div>
          <p>{task.description || "暂无补充说明"}</p>
        </div>
        <div className="header-actions">
          <button className="secondary-button debug-button" onClick={() => setDebugOpen(true)} title="仅用于排查 Agent 接入和运行异常">
            <Braces size={15} />调试信息
          </button>
          {busy && (
            <button
              className="secondary-button danger-button"
              onClick={() => interrupt.mutate()}
              disabled={interrupt.isPending}
            >
              <CircleStop size={16} /> 中止
            </button>
          )}
        </div>
      </header>

      {(followUp.error || upload.error || deleteMaterial.error || interrupt.error || openPath.error) && (
        <ErrorBanner
          error={followUp.error || upload.error || deleteMaterial.error || interrupt.error || openPath.error}
        />
      )}

      <section className="summary-grid">
        <Summary icon={<Bot size={17} />} label="运行 Agent" value={`${agentMeta[task.provider].name} ${agentMeta[task.provider].runtime}`} />
        <Summary icon={<FolderGit2 size={17} />} label="关联仓库" value={`${task.repositories.length} 个仓库`} />
        <Summary icon={<Clock3 size={17} />} label="最近更新" value={formatTime(task.updatedAt)} />
        <Summary icon={<Activity size={17} />} label="当前会话" value={latestSession ? latestSession.status : "尚未启动"} />
      </section>

      <div className="work-area">
        <section className="context-panel">
          <PanelTitle icon={<FileText size={16} />} title="任务上下文" />
          <TaskOrganizer task={task} onChanged={onChanged} notify={notify} />
          <ContextGroup title="需求材料" count={task.materials.length}>
            {task.materials.map((material) => (
              <div className="material-row" key={material.id}>
                <button
                  className="context-row context-link"
                  onClick={() => setPreviewMaterialId(material.id)}
                  title={`预览 ${material.name}`}
                >
                  <FileText size={14} />
                  <span>{material.name}</span>
                </button>
                <button
                  className="material-delete"
                  aria-label={`删除 ${material.name}`}
                  title="从当前需求中移除（历史记录保留）"
                  disabled={deleteMaterial.isPending}
                  onClick={() => {
                    if (window.confirm(`从当前需求中移除“${material.name}”？历史时间线仍会保留这次操作。`)) {
                      deleteMaterial.mutate(material.id);
                    }
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {!task.materials.length && <SmallEmpty>暂无需求材料</SmallEmpty>}
            <label className={`material-upload ${upload.isPending ? "disabled" : ""}`}>
              {upload.isPending ? <LoaderCircle className="spin" size={13} /> : <Upload size={13} />}
              补充文件
              <input
                type="file"
                disabled={upload.isPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload.mutate(file);
                  event.target.value = "";
                }}
              />
            </label>
            {busy && (
              <span className="context-help">
                运行中上传会立即通知 Codex 阅读新材料。
              </span>
            )}
          </ContextGroup>
          <ContextGroup title="代码仓库" count={task.repositories.length}>
            {task.repositories.map((repo) => (
              <button
                className="repo-context repo-link"
                key={repo.id}
                onClick={() => openPath.mutate({ target: "repository", repositoryId: repo.id })}
                title="打开代码仓库文件夹"
              >
                <div><FolderGit2 size={14} /><strong>{repo.sourcePath.split(/[\\/]/).at(-1)}</strong></div>
                <span>{shortPath(repo.worktreePath ?? repo.sourcePath)}</span>
                {repo.taskBranch && <code><GitBranch size={12} />{repo.taskBranch}</code>}
              </button>
            ))}
            {!task.repositories.length && <SmallEmpty>无关联仓库</SmallEmpty>}
            <button className="material-upload repository-add-button" onClick={() => setAddRepositoryOpen(true)}>
              <Plus size={13} />运行时添加仓库
            </button>
          </ContextGroup>
          <ContextGroup title="工作区">
            <button
              className="path-box path-link"
              disabled={!task.workspacePath || openPath.isPending}
              onClick={() => openPath.mutate({ target: "workspace" })}
              title="打开任务工作区文件夹"
            >
              {shortPath(task.workspacePath)}
            </button>
          </ContextGroup>
          <ContextGroup title="关联知识库" count={task.knowledgeRepositories.length}>
            {task.knowledgeRepositories.map((repository) => (
              <div className="repo-context" key={repository.id}>
                <div><BookOpen size={14} /><strong>{repository.name}</strong></div>
                <span>{shortPath(repository.worktreePath ?? repository.sourcePath)}</span>
                {repository.taskBranch && <code><GitBranch size={12} />{repository.taskBranch}</code>}
              </div>
            ))}
            {!task.knowledgeRepositories.length && <SmallEmpty>未关联；本任务不会检索或沉淀知识</SmallEmpty>}
            <button className="material-upload repository-add-button" disabled={busy} onClick={() => setAddKnowledgeOpen(true)}><Plus size={13} />关联知识库</button>
          </ContextGroup>
          {latestSession?.providerSessionId && (
            <ContextGroup title={`${agentMeta[latestSession.provider].name} Session · ${latestSessionAction?.type ?? "任务"}`}>
              <code className="session-id" title={latestSession.providerSessionId}>
                {latestSession.providerSessionId}
              </code>
              <span className="context-help">计划修订和开发返工会尽量复用原 Agent 会话。</span>
            </ContextGroup>
          )}
        </section>

        <section className="timeline-panel">
          <div className="tabs">
            <button className={tab === "timeline" ? "active" : ""} onClick={() => setTab("timeline")}>
              运行时间线
            </button>
            <button className={`${tab === "workbench" ? "active" : ""} ${pending.length > 0 && tab !== "workbench" ? "needs-attention" : ""}`} onClick={() => setTab("workbench")}>
              开发工作台{pending.length > 0 && <b className="tab-attention-count">{pending.length}</b>}
            </button>
          </div>
          {tab === "timeline" && (
            <Timeline
              events={events}
              activities={task.activities}
              interactions={task.interactions}
              sessions={task.sessions}
              onOpenWorkbench={() => setTab("workbench")}
              onPreviewMaterial={(materialId) => setPreviewMaterialId(materialId)}
              running={busy}
              hasMore={eventsHasMore}
              loading={eventsLoading}
              onLoadOlder={onLoadOlder}
            />
          )}
          {tab === "workbench" && (
            <div className="development-workbench">
              {pending.length > 0 && (
                <section className="workbench-attention-stack">
                  <header><span><AlertTriangle size={15} /><strong>需要你处理</strong></span><b>{pending.length}</b></header>
                  <p>Agent 正在等待回答或授权。完成下面的操作后，本轮工作会自动继续。</p>
                  {pending.map((interaction) => <InteractionCard key={interaction.id} interaction={interaction} onChanged={onChanged} />)}
                </section>
              )}
              {busy && (
                <div className={`prompt-pane workbench-composer ${busy ? "is-running" : "is-ready"}`}>
                  <div className="composer-heading">
                    <label htmlFor="run-prompt">补充当前 Agent 要求</label>
                    {busy && task.provider === "codex" ? <span>实时介入</span> : <span>立即可操作</span>}
                  </div>
                  <p className="composer-description">补充内容会发送给当前 Agent，不会启动新的动作。</p>
                  <textarea
                    id="run-prompt"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    rows={3}
                    placeholder={
                      busy
                        ? "例如：先不要做乘除法，只保留加减法；请优先补充测试。"
                        : "描述本轮要新增、修改或修复的内容，以及完成标准"
                    }
                  />
                  <div className="composer-actions">
                    <button
                      className="primary-button"
                      disabled={
                        followUp.isPending ||
                        !prompt.trim() ||
                        (busy && task.provider !== "codex")
                      }
                      onClick={() => {
                        followUp.mutate();
                      }}
                    >
                      {followUp.isPending ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : busy ? (
                        <Send size={16} />
                      ) : (
                        <Play size={16} />
                      )}
                      发送给当前 Agent
                    </button>
                  </div>
                  {busy && task.provider !== "codex" && (
                    <span className="form-hint">当前 Agent 暂不支持运行中介入，请等待本轮结束。</span>
                  )}
                </div>
              )}
              <ActionPanel task={task} busy={busy} onChanged={onChanged} notify={notify} />
            </div>
          )}
        </section>

      </div>
      {previewMaterialId && (
        <MaterialPreview
          materialId={previewMaterialId}
          onClose={() => setPreviewMaterialId(undefined)}
        />
      )}
      {addRepositoryOpen && (
        <AddTaskRepositoryDialog
          task={task}
          onClose={() => setAddRepositoryOpen(false)}
          onChanged={onChanged}
          notify={notify}
        />
      )}
      {addKnowledgeOpen && (
        <AddTaskKnowledgeDialog task={task} onClose={() => setAddKnowledgeOpen(false)} onChanged={onChanged} notify={notify} />
      )}
      {debugOpen && <DebugDialog taskId={task.id} onClose={() => setDebugOpen(false)} />}
    </div>
  );
}

function TaskOrganizer({ task, onChanged, notify }: { task: Task; onChanged(): void; notify(message: string): void }) {
  const client = useQueryClient();
  const collections = useQuery({ queryKey: ["task-collections"], queryFn: api.collections });
  const [tagsText, setTagsText] = useState(task.tags.join(", "));
  const [collectionId, setCollectionId] = useState(task.collectionId ?? "");
  const [newCollection, setNewCollection] = useState("");
  useEffect(() => {
    setTagsText(task.tags.join(", "));
    setCollectionId(task.collectionId ?? "");
  }, [task.id, task.tags, task.collectionId]);
  const save = useMutation({
    mutationFn: () => api.updateOrganization(task.id, {
      tags: tagsText.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      collectionId: collectionId || null,
    }),
    onSuccess: () => { notify("任务归纳已更新"); onChanged(); },
  });
  const createCollection = useMutation({
    mutationFn: () => api.createCollection({ name: newCollection }),
    onSuccess: (collection) => {
      setCollectionId(collection.id);
      setNewCollection("");
      void client.invalidateQueries({ queryKey: ["task-collections"] });
      notify("收纳已创建，点击保存即可加入");
    },
  });
  return (
    <ContextGroup title="任务归纳">
      <div className="source-badge"><span>来源</span><strong>{task.source.label}</strong>{task.source.externalId && <code>{task.source.externalId}</code>}</div>
      <label className="organizer-field"><span><Tags size={12} />标签</span><input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="例如：计算器, 前端（逗号分隔）" /></label>
      <label className="organizer-field"><span><Folder size={12} />收纳</span><select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}><option value="">未收纳</option>{collections.data?.map((collection) => <option value={collection.id} key={collection.id}>{collection.name}</option>)}</select></label>
      <div className="collection-create"><input value={newCollection} onChange={(event) => setNewCollection(event.target.value)} placeholder="新建收纳名称" /><button className="icon-button" aria-label="新建收纳" disabled={!newCollection.trim() || createCollection.isPending} onClick={() => createCollection.mutate()}><Plus size={13} /></button></div>
      <button className="secondary-button organizer-save" disabled={save.isPending} onClick={() => save.mutate()}><Check size={13} />保存归纳</button>
      {(save.error || createCollection.error) && <ErrorBanner error={save.error || createCollection.error} />}
    </ContextGroup>
  );
}

function ActionPanel({ task, busy, onChanged, notify }: { task: Task; busy: boolean; onChanged(): void; notify(message: string): void }) {
  const [instruction, setInstruction] = useState("");
  const available = useQuery({ queryKey: ["available-actions", task.id, task.updatedAt], queryFn: () => api.availableActions(task.id) });
  const diff = useQuery({ queryKey: ["task-diff", task.id], queryFn: () => api.diff(task.id), enabled: false });
  const execute = useMutation({
    mutationFn: (type: TaskAction) => api.executeAction(task.id, { type, instruction: instruction.trim() || undefined, feedback: instruction.trim() || undefined }),
    onSuccess: (_result, type) => {
      notify(`已启动：${actionLabels[type] ?? type}`);
      setInstruction("");
      void available.refetch();
      onChanged();
    },
  });
  const latestSnapshot = task.snapshots.at(-1);
  const needsInstruction = available.data?.some((action) => action.requiresInstruction);
  return <div className="action-panel">
    <header className="action-heading">
      <div><Workflow size={17} /><span><strong>下一步</strong><small>根据当前结果自由选择，不受固定模板约束</small></span></div>
      <button className="secondary-button" onClick={() => void diff.refetch()} disabled={diff.isFetching}>{diff.isFetching ? <LoaderCircle className="spin" size={14} /> : <GitCompare size={14} />}查看代码 Diff</button>
    </header>
    {(task.deliveryTarget || task.acceptanceCriteria) && <section className="acceptance-criteria">
      {task.deliveryTarget && <><strong>交付目标</strong><p>{task.deliveryTarget}</p></>}
      {task.acceptanceCriteria && <><strong>验收标准</strong><p>{task.acceptanceCriteria}</p></>}
    </section>}
    {needsInstruction && <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={3} placeholder="填写计划修改意见、打回原因或知识修订意见；直接开发等动作可留空" />}
    <div className="action-grid">
      {available.isLoading && <SmallEmpty>正在计算可执行动作…</SmallEmpty>}
      {available.data?.map((action) => <button disabled={busy || execute.isPending || Boolean(action.requiresInstruction && !instruction.trim())} key={action.type} onClick={() => execute.mutate(action.type)}>
        <strong>{action.label}</strong><span>{action.description}</span>
      </button>)}
    </div>
    {(available.error || execute.error) && <ErrorBanner error={available.error || execute.error} />}
    {latestSnapshot && <section className="requirement-document">
      <header><span><GitBranch size={14} /><strong>最近代码快照</strong></span><span>{formatTime(latestSnapshot.createdAt)}</span></header>
      <pre>{latestSnapshot.repositories.map((repo) => `${shortPath(repo.path)}\nHEAD ${repo.head}\nTree ${repo.treeHash}\nDiff ${repo.diffHash}`).join("\n\n")}</pre>
    </section>}
    <section className="evidence-workbench">
      <h3>产物与证据<span>{task.artifacts.length}</span></h3>
      {!task.artifacts.length && <SmallEmpty>计划、审查报告、验收证据、交付记录与知识建议会显示在这里。</SmallEmpty>}
      {[...task.artifacts].reverse().map((artifact) => <details className={`evidence-card ${artifact.kind}`} key={artifact.id}>
        <summary><FileText size={13} /><strong>{artifact.title}</strong><time>{formatTime(artifact.createdAt)}</time></summary>
        {artifact.content && <pre>{artifact.content}</pre>}
        {Object.keys(artifact.metadata).length > 0 && <details className="evidence-metadata"><summary>结构化信息</summary><pre>{JSON.stringify(artifact.metadata, null, 2)}</pre></details>}
      </details>)}
    </section>
    {(diff.data || diff.error) && <section className="diff-workbench">
      <h3>代码与知识变更</h3>{diff.error && <ErrorBanner error={diff.error} />}
      {diff.data?.map((repo) => <div className="repo-diff" key={repo.path}>
        <header><span><GitBranch size={13} /><strong>{shortPath(repo.path)}</strong></span><span>{repo.files.length} 个文件 <b className="diff-additions">+{repo.additions}</b><b className="diff-deletions">−{repo.deletions}</b></span></header>
        {!repo.files.length && <SmallEmpty>当前没有未提交的代码或知识变更。</SmallEmpty>}
        {repo.files.map((file, index) => <DiffFileCard file={file} key={`${file.path}-${index}`} defaultOpen={repo.files.length <= 5} />)}
      </div>)}
    </section>}
  </div>;
}

const actionLabels: Partial<Record<TaskAction, string>> = {
  generate_plan: "生成计划", revise_plan: "更新计划", accept_plan: "采纳计划", start_development: "开始开发",
  request_changes: "打回修改", run_code_review: "代码审查", run_acceptance: "试运行与验收",
  checkpoint_and_continue: "提交推送后继续修改", deliver: "提交并推送",
  generate_knowledge_proposal: "生成知识建议", revise_knowledge_proposal: "修订知识建议",
  accept_knowledge: "更新知识库", reject_knowledge: "不更新知识库", archive: "归档",
};

const diffStatusText: Record<CodeDiffFile["status"], string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  copied: "复制",
  unmerged: "存在冲突",
  unknown: "变更",
};

function DiffFileCard({ file, defaultOpen }: { file: CodeDiffFile; defaultOpen: boolean }) {
  const additions = file.diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = file.diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return (
    <details className="diff-file-card" open={defaultOpen}>
      <summary>
        <span className={`diff-status ${file.status}`}>{diffStatusText[file.status]}</span>
        <strong title={file.path}>{file.path}</strong>
        {file.oldPath && <span className="old-path">来自 {file.oldPath}</span>}
        {file.staged && <span className="staged-badge">已暂存</span>}
        <span className="file-diff-count"><b className="diff-additions">+{additions}</b><b className="diff-deletions">−{deletions}</b></span>
        <ChevronRight size={13} />
      </summary>
      {file.binary ? <div className="binary-diff"><FileCode2 size={18} /><span>二进制文件无法预览文本差异</span></div>
        : file.diff ? <UnifiedDiff diff={file.diff} />
          : <div className="binary-diff"><FileText size={18} /><span>没有可展示的文本差异</span></div>}
      {file.truncated && <div className="diff-truncated">文件内容较大，仅展示前一部分。</div>}
    </details>
  );
}

function UnifiedDiff({ diff }: { diff: string }) {
  let oldLine = 0;
  let newLine = 0;
  const rows = diff.split("\n").map((text, index) => {
    if (text.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
      oldLine = Number(match?.[1] ?? 0);
      newLine = Number(match?.[2] ?? 0);
      return { key: index, text, kind: "hunk", oldNumber: "", newNumber: "" };
    }
    if (text.startsWith("diff --git") || text.startsWith("index ") || text.startsWith("---") || text.startsWith("+++")) {
      return { key: index, text, kind: "meta", oldNumber: "", newNumber: "" };
    }
    if (text.startsWith("+")) return { key: index, text: text.slice(1), kind: "added", oldNumber: "", newNumber: String(newLine++) };
    if (text.startsWith("-")) return { key: index, text: text.slice(1), kind: "deleted", oldNumber: String(oldLine++), newNumber: "" };
    if (text.startsWith("\\")) return { key: index, text, kind: "meta", oldNumber: "", newNumber: "" };
    return { key: index, text: text.startsWith(" ") ? text.slice(1) : text, kind: "context", oldNumber: String(oldLine++), newNumber: String(newLine++) };
  });
  return <div className="unified-diff">{rows.map((row) => <div className={`diff-line ${row.kind}`} key={row.key}><span>{row.oldNumber}</span><span>{row.newNumber}</span><code>{row.text || " "}</code></div>)}</div>;
}

function MaterialPreview({ materialId, onClose }: { materialId: string; onClose(): void }) {
  const query = useQuery({
    queryKey: ["material-content", materialId],
    queryFn: () => api.materialContent(materialId),
  });
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog material-preview-dialog" role="dialog" aria-modal="true" aria-label="材料预览">
        <header>
          <div>
            <span className="dialog-icon"><FileText size={18} /></span>
            <div>
              <h2>{query.data?.material.name ?? "材料预览"}</h2>
              <p>只读预览，最多加载 256 KB</p>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>
        <div className="dialog-body material-preview-body">
          {query.isLoading && <div className="timeline-loading"><LoaderCircle className="spin" size={15} />正在读取材料</div>}
          {query.error && <ErrorBanner error={query.error} />}
          {query.data && <pre>{query.data.content || "（空文件）"}</pre>}
          {query.data?.truncated && <span className="preview-truncated">文件较大，仅展示前 256 KB。</span>}
        </div>
      </section>
    </div>
  );
}

function isTimelineEvent(event: AgentEvent) {
  if (
    [
      "user.followup",
      "session.started",
      "session.resumed",
      "session.status",
      "message.completed",
      "command.started",
      "command.completed",
      "file.changed",
      "interaction.requested",
      "interaction.resolved",
      "turn.started",
      "turn.completed",
      "turn.failed",
    ].includes(event.type)
  ) {
    return true;
  }
  const item = event.payload.item as Record<string, unknown> | undefined;
  return (
    event.type === "tool.completed" &&
    ["fileChange", "mcpToolCall", "webSearch"].includes(String(item?.type ?? ""))
  );
}

type TimelineRun = {
  key: string;
  events: AgentEvent[];
  createdAt: string;
  status: "running" | "completed" | "failed" | "interrupted" | "cancelled";
  materialSnapshot?: Array<{ id: string; name: string }>;
};

type TimelineItem =
  | { kind: "activity"; key: string; createdAt: string; activity: TaskActivity }
  | { kind: "event"; key: string; createdAt: string; event: AgentEvent }
  | { kind: "run"; key: string; createdAt: string; run: TimelineRun };

function buildTimelineItems(events: AgentEvent[], activities: TaskActivity[], sessions: Task["sessions"]): TimelineItem[] {
  const items: TimelineItem[] = activities.map((activity) => ({
    kind: "activity",
    key: `activity-${activity.id}`,
    createdAt: activity.createdAt,
    activity,
  }));
  let current: TimelineRun | undefined;
  const finishCurrent = () => {
    if (!current) return;
    if (current.status === "running") {
      const session = sessions.find((candidate) => candidate.id === current!.events[0]?.sessionId);
      if (session && ["completed", "failed", "cancelled", "interrupted"].includes(session.status)) {
        current.status = session.status as TimelineRun["status"];
      }
    }
    if (!current.events.some((event) => event.type === "turn.started")) {
      current.materialSnapshot = activities
        .filter((activity) => {
          if (activity.type !== "material.added" || activity.createdAt > current!.createdAt) return false;
          const materialId = String(activity.payload.materialId ?? "");
          return !activities.some(
            (candidate) =>
              candidate.type === "material.removed" &&
              String(candidate.payload.materialId ?? "") === materialId &&
              candidate.createdAt <= current!.createdAt,
          );
        })
        .map((activity) => ({
          id: String(activity.payload.materialId ?? ""),
          name: String(activity.payload.name ?? "需求材料"),
        }));
    }
    items.push({ kind: "run", key: current.key, createdAt: current.createdAt, run: current });
    current = undefined;
  };

  for (const event of events) {
    const startsSession = event.type === "session.started" || event.type === "session.resumed";
    const startsTurn = event.type === "turn.started";
    if (startsSession) {
      if (current?.status === "running") current.status = "interrupted";
      finishCurrent();
      current = {
        key: `run-${event.id}`,
        events: [event],
        createdAt: event.createdAt,
        status: "running",
      };
      continue;
    }
    if (startsTurn) {
      if (!current || current.events.some((item) => item.type === "turn.started")) {
        if (current?.status === "running") current.status = "interrupted";
        finishCurrent();
        current = {
          key: `run-${event.id}`,
          events: [],
          createdAt: event.createdAt,
          status: "running",
        };
      }
      current.events.push(event);
      continue;
    }
    if (current) {
      current.events.push(event);
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        current.status = event.type === "turn.completed" ? "completed" : "failed";
        finishCurrent();
      }
      continue;
    }
    if (event.type === "user.followup") continue;
    current = {
      key: `run-${event.id}`,
      events: [event],
      createdAt: event.createdAt,
      status: event.type === "turn.completed" ? "completed" : event.type === "turn.failed" ? "failed" : "running",
    };
    if (current.status !== "running") finishCurrent();
  }
  finishCurrent();
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function Timeline({
  events,
  activities,
  interactions,
  sessions,
  onOpenWorkbench,
  running,
  hasMore,
  loading,
  onLoadOlder,
  onPreviewMaterial,
}: {
  events: AgentEvent[];
  activities: TaskActivity[];
  interactions: PendingInteraction[];
  sessions: Task["sessions"];
  onOpenWorkbench(): void;
  running: boolean;
  hasMore: boolean;
  loading: boolean;
  onLoadOlder(): Promise<void>;
  onPreviewMaterial(materialId: string): void;
}) {
  const items = buildTimelineItems(events, activities, sessions);
  const pendingInteractions = interactions.filter((interaction) => interaction.status === "pending");
  const [collapseAllVersion, setCollapseAllVersion] = useState(0);
  const runCount = items.filter((item) => item.kind === "run").length;
  if (!items.length && !loading) {
    return (
      <div className="timeline-empty">
        <Sparkles size={28} />
        <strong>准备好开始一次开发任务</strong>
        <span>补充需求材料、准备工作区或启动 Agent 后，活动会出现在这里。</span>
      </div>
    );
  }
  return (
    <div className="timeline activity-timeline">
      <div className="timeline-toolbar">
        <span>{runCount} 轮 Agent 工作</span>
        <button
          type="button"
          disabled={runCount === 0}
          onClick={() => setCollapseAllVersion((version) => version + 1)}
        >
          <ChevronsUp size={13} />
          全部折叠
        </button>
      </div>
      {pendingInteractions.length > 0 && <section className="timeline-attention-stack">
        <header><span><AlertTriangle size={14} /><strong>Agent 正在等待你处理</strong></span><b>{pendingInteractions.length}</b></header>
        <p>时间线仅记录待处理事项。请前往开发工作台回答问题或处理授权。</p>
        <div className="timeline-pending-list">
          {pendingInteractions.map((interaction) => <InteractionTimelineSummary key={interaction.id} interaction={interaction} />)}
        </div>
        <button className="secondary-button" onClick={onOpenWorkbench}>前往开发工作台处理</button>
      </section>}
      {running && !items.some((item) => item.kind === "run" && item.run.status === "running") && (
        <div className="thinking-row"><LoaderCircle className="spin" size={15} />Agent 正在启动</div>
      )}
      {items.map((item) => {
        if (item.kind === "activity") return <ActivityTimelineEvent key={item.key} activity={item.activity} onPreviewMaterial={onPreviewMaterial} />;
        if (item.kind === "run") return <AgentRunCard key={item.key} run={item.run} interactions={interactions} collapseAllVersion={collapseAllVersion} onPreviewMaterial={onPreviewMaterial} />;
        return <TimelineEvent key={item.key} event={item.event} />;
      })}
      {hasMore && (
        <button className="load-more-button load-older-bottom" disabled={loading} onClick={() => void onLoadOlder()}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <Clock3 size={14} />}
          加载更早记录
        </button>
      )}
    </div>
  );
}

function ActivityTimelineEvent({ activity, onPreviewMaterial }: { activity: TaskActivity; onPreviewMaterial(materialId: string): void }) {
  const name = String(activity.payload.name ?? activity.payload.persistedAs ?? "需求说明");
  const config = activity.type === "action.started"
    ? { icon: <Workflow size={14} />, title: `开始：${String(activity.payload.label ?? activity.payload.type ?? "动作")}`, text: String(activity.payload.instruction ?? ""), tone: "agent" }
    : activity.type === "action.completed"
      ? { icon: <CheckCircle2 size={14} />, title: `完成：${String(activity.payload.label ?? activity.payload.type ?? "动作")}`, text: String(activity.payload.summary ?? ""), tone: "success" }
    : activity.type === "action.failed"
      ? { icon: <XCircle size={14} />, title: `失败：${String(activity.payload.label ?? activity.payload.type ?? "动作")}`, text: String(activity.payload.error ?? "请查看运行记录"), tone: "danger" }
    : activity.type === "action.interrupted"
      ? { icon: <CircleStop size={14} />, title: "动作已中断", text: "执行现场已保留，可重新选择下一步", tone: "warning" }
    : activity.type === "plan.accepted"
      ? { icon: <CheckCircle2 size={14} />, title: "计划已采纳", text: "现在可以开始开发，也可以继续调整计划", tone: "success" }
    : activity.type === "knowledge.accepted"
      ? { icon: <CheckCircle2 size={14} />, title: "知识库已更新", text: String(activity.payload.summary ?? "知识建议已经应用"), tone: "success" }
    : activity.type === "knowledge.rejected"
      ? { icon: <XCircle size={14} />, title: "知识建议未采纳", text: String(activity.payload.reason ?? "本次不更新知识库"), tone: "warning" }
    : activity.type === "task.archived"
      ? { icon: <CheckCircle2 size={14} />, title: "任务已归档", text: "开发、交付和知识处理均已结束", tone: "success" }
    : activity.type === "delivery.preflight_started"
      ? { icon: <GitBranch size={14} />, title: "开始交付预检", text: "正在检查代码是否已经提交并推送", tone: "agent" }
    : activity.type === "delivery.preflight_completed"
      ? { icon: <GitCompare size={14} />, title: "交付预检完成", text: activity.payload.action === "skip_all" ? "代码已在工作流外完成提交与推送" : activity.payload.action === "push_only" ? "检测到已有提交，只需继续推送" : "需要由开发 Agent 完成提交与推送", tone: activity.payload.action === "skip_all" ? "success" : "agent" }
    : activity.type === "delivery.commit_skipped"
      ? { icon: <CheckCircle2 size={14} />, title: "跳过创建提交", text: `检测到已有提交 ${String(activity.payload.commit ?? "")}`, tone: "success" }
    : activity.type === "delivery.push_skipped"
      ? { icon: <CheckCircle2 size={14} />, title: "跳过推送", text: `${String(activity.payload.remote ?? "origin")}/${String(activity.payload.branch ?? "")} 已包含 ${String(activity.payload.commit ?? "")}`, tone: "success" }
    : activity.type === "delivery.agent_started"
      ? { icon: <Send size={14} />, title: "开发 Agent 开始交付", text: "Agent 将自主处理提交、推送和普通 Git 问题", tone: "agent" }
    : activity.type === "delivery.remote_verifying"
      ? { icon: <GitCompare size={14} />, title: "正在确认远程分支", text: "检查远程 SHA、目标分支和未提交改动", tone: "agent" }
    : activity.type === "delivery.completed"
      ? { icon: <CheckCircle2 size={14} />, title: "代码交付完成", text: activity.payload.skipped ? "提交与推送此前已经完成，本次已自动跳过" : "本地提交与远程分支已经确认一致", tone: "success" }
    : activity.type === "delivery.needs_user"
      ? { icon: <CircleStop size={14} />, title: "代码交付已暂停", text: Array.isArray(activity.payload.problems) ? activity.payload.problems.map(String).join("\n") : "需要用户处理 Git 认证、权限、冲突或分支问题", tone: "warning" }
      : activity.type === "changes.requested"
        ? { icon: <RefreshCw size={14} />, title: activity.payload.automatic ? "验收未通过，已自动打回" : "审核打回修改", text: activity.payload.automatic ? String(activity.payload.feedback ?? "已自动要求修改").split("\n")[0] : String(activity.payload.feedback ?? "已要求修改"), tone: "warning" }
        : activity.type === "repository.added"
            ? { icon: <FolderGit2 size={14} />, title: "关联新的代码仓库", text: `${String(activity.payload.sourcePath ?? "")}${activity.payload.taskBranch ? `\n任务分支：${String(activity.payload.taskBranch)}` : ""}`, tone: "file" }
          : activity.type === "material.removed"
    ? { icon: <Trash2 size={14} />, title: "移除需求材料", text: name, tone: "danger" }
    : activity.type === "material.added"
      ? { icon: <Upload size={14} />, title: "补充需求材料", text: name, tone: "file" }
      : activity.type === "material.restored"
        ? { icon: <RefreshCw size={14} />, title: "恢复需求材料", text: name, tone: "file" }
        : { icon: <Send size={14} />, title: "追加开发要求", text: String(activity.payload.text ?? ""), tone: "agent" };
  return (
    <article className={`timeline-event workspace-activity ${config.tone}`}>
      <div className="event-rail"><span>{config.icon}</span></div>
      <div className="event-body">
        <header><strong>{config.title}</strong><time>{formatTime(activity.createdAt)}</time></header>
        {activity.payload.materialId ? (
          <button className="activity-material-link" onClick={() => onPreviewMaterial(String(activity.payload.materialId))}>
            {config.text}
          </button>
        ) : (
          <p className="event-summary">{config.text}</p>
        )}
      </div>
    </article>
  );
}

function AgentRunCard({
  run,
  interactions,
  collapseAllVersion,
  onPreviewMaterial,
}: {
  run: TimelineRun;
  interactions: PendingInteraction[];
  collapseAllVersion: number;
  onPreviewMaterial(materialId: string): void;
}) {
  const requestedInteractionIds = new Set(run.events
    .filter((event) => event.type === "interaction.requested")
    .map((event) => {
      const interaction = event.payload.interaction as Record<string, unknown> | undefined;
      return String(event.payload.interactionId ?? interaction?.id ?? "");
    })
    .filter(Boolean));
  const pendingInteractions = interactions.filter(
    (interaction) => interaction.status === "pending" && requestedInteractionIds.has(interaction.id),
  ).length;
  const [expanded, setExpanded] = useState(run.status === "running" || pendingInteractions > 0);
  useEffect(() => {
    if (collapseAllVersion > 0) setExpanded(false);
  }, [collapseAllVersion]);
  const started = run.events.find((event) => event.type === "turn.started");
  const materials = (started?.payload.materials ?? run.materialSnapshot ?? []) as Array<{ id: string; name: string }>;
  const commands = run.events.filter((event) => event.type === "command.completed").length;
  const changes = run.events.filter((event) => event.type === "file.changed" || event.type === "tool.completed").length;
  const failed = run.status === "failed";
  const interrupted = run.status === "interrupted" || run.status === "cancelled";
  const prompt = String(started?.payload.prompt ?? "");
  const detailEvents = run.events
    .filter((event) => !["session.started", "session.resumed", "turn.started"].includes(event.type))
    .reduce<AgentEvent[]>((result, event) => {
      const item = event.payload.item as Record<string, unknown> | undefined;
      if (event.type === "message.completed" && !String(item?.text ?? "").trim()) return result;
      if (event.type === "interaction.resolved" && !event.payload.action && !event.payload.resolution) return result;
      result.push(event);
      return result;
    }, []);
  return (
    <section className={`agent-run-card ${pendingInteractions ? "needs-attention" : failed ? "failed" : interrupted ? "interrupted" : run.status === "completed" ? "completed" : "running"}`}>
      <button className="agent-run-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="run-status-icon">
          {pendingInteractions ? <MessageSquareText size={15} /> : failed ? <XCircle size={15} /> : interrupted ? <CircleStop size={15} /> : run.status === "completed" ? <CheckCircle2 size={15} /> : <LoaderCircle className="spin" size={15} />}
        </span>
        <span className="run-summary-copy">
          <strong>{pendingInteractions ? "Agent 等待你处理" : failed ? "Agent 本轮失败" : interrupted ? "Agent 本轮已中断" : run.status === "completed" ? "Agent 本轮已完成" : "Agent 正在工作"}</strong>
          <small>
            {materials.length ? `使用材料：${materials.map((item) => item.name).join("、")}` : "本轮未使用需求材料"}
          </small>
        </span>
        <span className="run-metrics">{pendingInteractions ? `${pendingInteractions} 个待处理 · ` : ""}{commands} 个命令 · {changes} 次文件变更</span>
        <time>{formatTime(run.createdAt)}</time>
        <ChevronRight className={expanded ? "expanded" : ""} size={15} />
      </button>
      {expanded && (
        <div className="agent-run-details">
          {pendingInteractions > 0 && <div className="run-attention"><MessageSquareText size={14} /><span><strong>本轮正在等待你的回答或授权</strong><small>请前往开发工作台处理；时间线仅保留过程记录。</small></span></div>}
          {prompt && <div className="run-prompt"><strong>本轮指令</strong><p>{prompt}</p></div>}
          {materials.length > 0 && (
            <div className="run-materials">
              <strong>本轮材料快照</strong>
              <div>{materials.map((material) => (
                <button key={material.id} onClick={() => onPreviewMaterial(material.id)}><FileText size={11} />{material.name}</button>
              ))}</div>
            </div>
          )}
          {detailEvents.map((event) => <TimelineEvent key={event.id} event={event} />)}
        </div>
      )}
    </section>
  );
}

function LegacyTimeline({
  events,
  running,
  hasMore,
  loading,
  onLoadOlder,
}: {
  events: AgentEvent[];
  running: boolean;
  hasMore: boolean;
  loading: boolean;
  onLoadOlder(): Promise<void>;
}) {
  const visibleEvents = events.reduce<AgentEvent[]>((result, event) => {
    const item = event.payload.item as Record<string, unknown> | undefined;
    if (event.type === "message.completed" && !String(item?.text ?? "").trim()) {
      return result;
    }
    if (event.type === "interaction.resolved" && !event.payload.action && !event.payload.resolution) {
      return result;
    }
    const previous = result.at(-1);
    if (event.type === "command.completed" && previous?.type === "command.started") {
      const previousItem = previous.payload.item as Record<string, unknown> | undefined;
      if (previousItem?.id === item?.id) result.pop();
    }
    result.push(event);
    return result;
  }, []);

  if (!visibleEvents.length && !loading) {
    return (
      <div className="timeline-empty">
        <Sparkles size={28} />
        <strong>准备好开始一次开发任务</strong>
        <span>准备工作区后，在“开发工作台”中启动 Agent</span>
      </div>
    );
  }
  return (
    <div className="timeline">
      {hasMore && (
        <button
          className="load-more-button"
          disabled={loading}
          onClick={() => void onLoadOlder()}
        >
          {loading ? <LoaderCircle className="spin" size={14} /> : <Clock3 size={14} />}
          加载更早记录
        </button>
      )}
      {loading && !events.length && (
        <div className="timeline-loading">
          <LoaderCircle className="spin" size={16} /> 正在加载时间线
        </div>
      )}
      {visibleEvents.map((event) => <TimelineEvent key={event.id} event={event} />)}
      {running && (
        <div className="thinking-row">
          <LoaderCircle className="spin" size={15} />
          Agent 正在工作
        </div>
      )}
    </div>
  );
}

function TimelineEvent({ event }: { event: AgentEvent }) {
  const data = event.payload;
  const item = data.item as Record<string, unknown> | undefined;
  const interaction = data.interaction as Record<string, unknown> | undefined;
  const interactionPayload = interaction?.payload as Record<string, unknown> | undefined;
  const resolution = data.resolution as InteractionResolutionPresentation | undefined;
  const resolutionAccepted = resolution
    ? ["answered", "approved"].includes(resolution.outcome)
    : data.action === "accept";
  const config = (() => {
    if (event.type === "user.followup") return { icon: <Send size={15} />, title: "你追加了要求", tone: "agent" };
    if (event.type.startsWith("message")) return { icon: <Sparkles size={15} />, title: "Agent 回复", tone: "agent" };
    if (event.type.startsWith("command")) return { icon: <TerminalSquare size={15} />, title: "命令", tone: "command" };
    if (event.type.startsWith("file") || item?.type === "fileChange") return { icon: <FileCode2 size={15} />, title: "文件变更", tone: "file" };
    if (event.type === "interaction.resolved") return resolutionAccepted
      ? { icon: <CheckCircle2 size={15} />, title: resolution?.title ?? "你已提交处理结果", tone: "success" }
      : { icon: <XCircle size={15} />, title: resolution?.title ?? (data.action === "cancel" ? "你取消了处理" : "你已拒绝本次请求"), tone: "danger" };
    if (event.type === "interaction.requested") return { icon: <MessageSquareText size={15} />, title: "Agent 请求你处理", tone: "warning" };
    if (event.type.includes("failed")) return { icon: <XCircle size={15} />, title: "运行失败", tone: "danger" };
    if (event.type.includes("completed")) return { icon: <CheckCircle2 size={15} />, title: "完成", tone: "success" };
    return { icon: <Activity size={15} />, title: "运行状态", tone: "neutral" };
  })();
  const command = String(item?.command ?? "");
  const readableCommand =
    command.length > 180 ? `${command.slice(0, 177)}…` : command;
  const changes = Array.isArray(item?.changes)
    ? (item.changes as Array<Record<string, unknown>>)
    : [];
  const content = (() => {
    if (event.type === "user.followup") return String(data.text ?? "已追加新的要求");
    if (event.type === "message.completed") {
      return String(item?.text ?? data.text ?? "Agent 已回复");
    }
    if (event.type === "command.started") {
      return readableCommand ? `开始执行：${readableCommand}` : "开始执行命令";
    }
    if (event.type === "command.completed") {
      const exitCode = item?.exitCode;
      const result = exitCode === 0 ? "执行成功" : `执行结束（退出码 ${String(exitCode ?? "未知")}）`;
      return readableCommand ? `${result}\n${readableCommand}` : result;
    }
    if (event.type === "tool.completed" && item?.type === "fileChange") {
      if (!changes.length) return "文件修改已完成";
      return changes
        .slice(0, 8)
        .map((change) => {
          const path = String(change.path ?? "未知文件").replaceAll("\\", "/");
          const kind = change.kind as Record<string, unknown> | undefined;
          const action = kind?.type === "add" ? "新增" : kind?.type === "delete" ? "删除" : "修改";
          return `${action} ${path.split("/").at(-1)}`;
        })
        .join("\n");
    }
    if (event.type === "interaction.requested") {
      const reason = interactionPayload?.reason ?? interactionPayload?.question;
      return reason ? String(reason) : "Agent 需要你的确认或补充信息";
    }
    if (event.type === "interaction.resolved") return resolution?.description ?? (resolutionAccepted
      ? "你已允许或回答本次请求，Agent 将继续工作。"
      : "你的拒绝结果已发送给 Agent。");
    if (event.type === "turn.failed") return readableError(data.error);
    return humanEvent(event.type);
  })();
  return (
    <article className={`timeline-event ${config.tone}`}>
      <div className="event-rail"><span>{config.icon}</span></div>
      <div className="event-body">
        <header><strong>{config.title}</strong><time>{formatTime(event.createdAt)}</time></header>
        <p className="event-summary">{content}</p>
        {event.type === "interaction.resolved" && resolution?.details.length ? (
          <dl className="interaction-resolution-details">
            {resolution.details.map((detail, index) => (
              <div key={`${detail.label}-${index}`}>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </article>
  );
}

function humanEvent(type: AgentEvent["type"]) {
  const map: Partial<Record<AgentEvent["type"], string>> = {
    "session.resumed": "已恢复原有 Codex Thread，并开始新一轮",
    "session.started": "Agent 会话已启动",
    "turn.completed": "本轮任务已完成",
    "interaction.requested": "Agent 正在等待你的处理",
    "interaction.resolved": "交互请求已处理，Agent 将继续运行",
    "tool.started": "工具调用开始",
    "tool.completed": "工具调用完成",
    "user.followup": "已追加新的要求",
  };
  return map[type] ?? type;
}

function DebugDialog({ taskId, onClose }: { taskId: string; onClose(): void }) {
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog debug-dialog" role="dialog" aria-modal="true" aria-label="调试信息">
        <header>
          <div><span className="dialog-icon"><Braces size={18} /></span><div><h2>调试信息</h2><p>仅用于排查 Agent 接入、会话和协议问题，正常开发无需关注</p></div></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭调试信息"><X size={17} /></button>
        </header>
        <RawEvents taskId={taskId} />
      </section>
    </div>
  );
}

function RawEvents({ taskId }: { taskId: string }) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [before, setBefore] = useState<number>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("all");
  const [showNoise, setShowNoise] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async (cursor?: number) => {
    setLoading(true);
    try {
      const page = await api.eventPage(taskId, {
        before: cursor,
        limit: 30,
        mode: "raw",
      });
      setEvents((current) => (cursor ? [...page.events, ...current] : page.events));
      setBefore(page.nextBefore);
      setHasMore(page.hasMore);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setEvents([]);
    setBefore(undefined);
    setHasMore(false);
    void load();
  }, [taskId]);

  const noisyTypes = new Set<AgentEvent["type"]>(["message.delta", "command.output", "reasoning"]);
  const eventTypes = [...new Set(events.map((event) => event.type))].sort();
  const visibleEvents = events.filter((event) =>
    (showNoise || !noisyTypes.has(event.type)) && (typeFilter === "all" || event.type === typeFilter),
  );

  return (
    <div className="raw-events-list">
      <div className="raw-events-note">
        这里是 Agent CLI 的底层协议日志，不代表需要处理的任务。每次加载 30 条，默认隐藏流式片段等高频噪声。
      </div>
      <div className="debug-controls">
        <select aria-label="按事件类型筛选" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">全部诊断事件</option>{eventTypes.map((type) => <option value={type} key={type}>{type}</option>)}</select>
        <label><input type="checkbox" checked={showNoise} onChange={(event) => setShowNoise(event.target.checked)} />显示高频协议事件</label>
        <button className="secondary-button" onClick={async () => {
          await navigator.clipboard.writeText(JSON.stringify({ taskId, exportedAt: new Date().toISOString(), events }, null, 2));
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2_000);
        }}><Braces size={13} />{copied ? "已复制" : "复制诊断信息"}</button>
      </div>
      {hasMore && (
        <button
          className="load-more-button"
          disabled={loading}
          onClick={() => void load(before)}
        >
          {loading ? <LoaderCircle className="spin" size={14} /> : <Clock3 size={14} />}
          加载更早事件
        </button>
      )}
      {visibleEvents.map((event) => <RawEvent key={event.id} event={event} />)}
      {!visibleEvents.length && !loading && <SmallEmpty>当前筛选条件下没有诊断事件</SmallEmpty>}
      {loading && !events.length && (
        <div className="timeline-loading">
          <LoaderCircle className="spin" size={16} /> 正在加载事件
        </div>
      )}
    </div>
  );
}

function RawEvent({ event }: { event: AgentEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="raw-event" onToggle={(toggle) => setOpen(toggle.currentTarget.open)}>
      <summary>
        <code>#{event.id}</code>
        <strong>{event.type}</strong>
        <time>{formatTime(event.createdAt)}</time>
      </summary>
      {open && <pre>{JSON.stringify(event, null, 2)}</pre>}
    </details>
  );
}

function InteractionCard({
  interaction,
  onChanged,
}: {
  interaction: PendingInteraction;
  onChanged(): void;
}) {
  const payload = interaction.payload as Record<string, unknown>;
  const questions = Array.isArray(payload.questions)
    ? (payload.questions as Record<string, unknown>[])
    : interaction.type === "user_question"
      ? [{ id: "answer", question: payload.question, options: payload.options }]
      : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: (action: "accept" | "decline" | "cancel") =>
      api.resolve(interaction.id, {
        action,
        answers: Object.fromEntries(
          Object.entries(answers).map(([key, value]) => [key, [value]]),
        ),
        content: answers,
      }),
    onSuccess: onChanged,
  });

  if (interaction.type === "user_question") {
    return (
      <div className="interaction-card">
        <div className="interaction-kind"><MessageSquareText size={14} />Agent 提问</div>
        {questions.map((question, index) => {
          const id = String(question.id ?? index);
          const options = Array.isArray(question.options)
            ? (question.options as Array<string | Record<string, unknown>>)
            : [];
          return (
            <div className="question" key={id}>
              <strong>{String(question.question ?? question.header ?? "请补充信息")}</strong>
              {options.length > 0 && (
                <div className="option-list">
                  {options.map((option, optionIndex) => {
                    const value =
                      typeof option === "string"
                        ? option
                        : String(option.label ?? option.value ?? optionIndex);
                    return (
                      <label key={value}>
                        <input
                          type="radio"
                          name={`${interaction.id}-${id}`}
                          value={value}
                          checked={answers[id] === value}
                          onChange={() => setAnswers((current) => ({ ...current, [id]: value }))}
                        />
                        <span>{value}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <textarea
                rows={2}
                placeholder="输入你的回答…"
                value={answers[id] ?? ""}
                onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))}
              />
            </div>
          );
        })}
        <div className="interaction-actions">
          <button className="primary-button" onClick={() => mutation.mutate("accept")} disabled={mutation.isPending}>
            <Send size={14} />提交回答
          </button>
          <button className="ghost-button" onClick={() => mutation.mutate("cancel")}>取消任务</button>
        </div>
        {mutation.error && <span className="inline-error">{mutation.error.message}</span>}
      </div>
    );
  }

  return (
    <div className="interaction-card approval">
      <div className="interaction-kind"><AlertTriangle size={14} />{interaction.presentation?.category === "file_change" ? "文件修改授权" : interaction.presentation?.category === "command" ? "命令执行授权" : "权限申请"}</div>
      <div className="permission-heading">
        <strong>{interaction.presentation?.title ?? String(payload.title ?? payload.toolName ?? "Agent 请求额外权限")}</strong>
        <span className={`risk-badge ${interaction.presentation?.risk ?? "medium"}`}>{interaction.presentation?.risk === "high" ? "高风险" : interaction.presentation?.risk === "low" ? "低风险" : "需确认"}</span>
      </div>
      <p>{interaction.presentation?.description ?? String(payload.description ?? "Agent 需要额外权限才能继续当前步骤。")}</p>
      {interaction.presentation && interaction.presentation.details.length > 0 && (
        <dl className="permission-details">
          {interaction.presentation.details.map((detail, index) => (
            <div className={detail.kind ?? "text"} key={`${detail.label}-${index}`}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="interaction-actions">
        <button className="primary-button" onClick={() => mutation.mutate("accept")} disabled={mutation.isPending}>
          <Check size={14} />{interaction.presentation?.category === "file_change" ? "允许本次修改" : interaction.presentation?.category === "command" ? "允许运行一次" : "允许一次"}
        </button>
        <button className="secondary-button" onClick={() => mutation.mutate("decline")}>
          <X size={14} />拒绝
        </button>
      </div>
      <details className="permission-technical-details">
        <summary>查看技术详情</summary>
        <pre>{JSON.stringify({ method: interaction.method, payload }, null, 2)}</pre>
      </details>
      {mutation.error && <span className="inline-error">{mutation.error.message}</span>}
    </div>
  );
}

function InteractionTimelineSummary({ interaction }: { interaction: PendingInteraction }) {
  const payload = interaction.payload as Record<string, unknown>;
  const questions = Array.isArray(payload.questions) ? payload.questions as Record<string, unknown>[] : [];
  const title = interaction.type === "user_question"
    ? String(questions[0]?.question ?? payload.question ?? "Agent 需要补充信息")
    : interaction.presentation?.title ?? String(payload.title ?? payload.toolName ?? "Agent 申请执行权限");
  return (
    <article className="timeline-pending-summary">
      {interaction.type === "user_question" ? <MessageSquareText size={13} /> : <AlertTriangle size={13} />}
      <span><strong>{interaction.type === "user_question" ? "Agent 提问" : "权限申请"}</strong><small>{title}</small></span>
    </article>
  );
}

function AddTaskRepositoryDialog({
  task,
  onClose,
  onChanged,
  notify,
}: {
  task: Task;
  onClose(): void;
  onChanged(): void;
  notify(message: string): void;
}) {
  const registered = useQuery({ queryKey: ["registered-repositories"], queryFn: api.registeredRepositories });
  const [selectedId, setSelectedId] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const existingPaths = new Set(task.repositories.map((repository) => repository.sourcePath.toLocaleLowerCase()));
  const available = (registered.data ?? []).filter((repository) => !existingPaths.has(repository.sourcePath.toLocaleLowerCase()));
  const add = useMutation({
    mutationFn: () => api.addTaskRepository(task.id, selectedId
      ? { registeredRepositoryId: selectedId }
      : { sourcePath, baseBranch: baseBranch.trim() || undefined }),
    onSuccess: (result) => {
      onChanged();
      onClose();
      notify(result.agentNotified
        ? "仓库 worktree 已创建，并已通知当前 Agent"
        : result.repository.worktreePath
          ? "仓库 worktree 已创建"
          : "仓库已关联，将在工作区准备时创建 worktree");
    },
  });
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="dialog add-repository-dialog" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
        <header>
          <div><span className="dialog-icon"><FolderGit2 size={18} /></span><div><h2>添加代码仓库</h2><p>已存在工作区时会立即创建任务分支和 Git worktree</p></div></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="dialog-body">
          <div className="field">
            <div className="field-heading"><span>从仓库库选择</span></div>
            <div className="repository-picker runtime-repository-picker">
              {available.map((repository) => (
                <label className={selectedId === repository.id ? "selected" : ""} key={repository.id}>
                  <input type="radio" name="runtime-repository" checked={selectedId === repository.id} onChange={() => { setSelectedId(repository.id); setSourcePath(""); }} />
                  <FolderGit2 size={15} />
                  <span><strong>{repository.name}</strong><small title={repository.sourcePath}>{repository.sourcePath}</small></span>
                  <code>{repository.defaultBranch}</code>
                  {selectedId === repository.id && <Check size={14} />}
                </label>
              ))}
              {!registered.isLoading && !available.length && <SmallEmpty>没有其他可选的已登记仓库</SmallEmpty>}
            </div>
          </div>
          <div className="repository-choice-divider"><span>或临时填写路径</span></div>
          <div className="dialog-two-columns">
            <label className="field"><span>本地 Git 仓库路径</span><input value={sourcePath} onChange={(event) => { setSourcePath(event.target.value); setSelectedId(""); }} placeholder="E:\\code\\service" /></label>
            <label className="field"><span>基准分支</span><input value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} placeholder="默认使用当前分支" disabled={Boolean(selectedId)} /></label>
          </div>
          <p className="repository-runtime-note">不会修改源仓库当前分支。任务分支和代码修改都位于该任务的独立 worktree 中。</p>
          {add.error && <ErrorBanner error={add.error} />}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={add.isPending || (!selectedId && !sourcePath.trim())}>{add.isPending ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}添加并创建 worktree</button>
        </footer>
      </form>
    </div>
  );
}

function AddTaskKnowledgeDialog({ task, onClose, onChanged, notify }: { task: Task; onClose(): void; onChanged(): void; notify(message: string): void }) {
  const repositories = useQuery({ queryKey: ["knowledge-repositories"], queryFn: api.knowledgeRepositories });
  const [selectedId, setSelectedId] = useState("");
  const linked = new Set(task.knowledgeRepositories.map((item) => item.knowledgeRepositoryId));
  const available = (repositories.data ?? []).filter((item) => !linked.has(item.id));
  const add = useMutation({
    mutationFn: () => api.addTaskKnowledgeRepository(task.id, selectedId),
    onSuccess: () => { onChanged(); onClose(); notify("知识库已关联并创建任务 worktree"); },
  });
  return <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="dialog add-repository-dialog" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
      <header><div><span className="dialog-icon"><BookOpen size={18} /></span><div><h2>关联知识库</h2><p>为当前任务创建隔离的知识分支和 Git worktree</p></div></div><button type="button" className="icon-button" onClick={onClose}><X size={18} /></button></header>
      <div className="dialog-body"><div className="repository-picker runtime-repository-picker">
        {available.map((repository) => <label className={selectedId === repository.id ? "selected" : ""} key={repository.id}>
          <input type="radio" checked={selectedId === repository.id} onChange={() => setSelectedId(repository.id)} />
          <BookOpen size={15} /><span><strong>{repository.name}</strong><small>{repository.description || repository.sourcePath}</small></span><code>{repository.defaultBranch}</code>{selectedId === repository.id && <Check size={14} />}
        </label>)}
        {!repositories.isLoading && !available.length && <SmallEmpty>没有其他可关联的知识库</SmallEmpty>}
      </div>{add.error && <ErrorBanner error={add.error} />}</div>
      <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!selectedId || add.isPending}>{add.isPending ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}关联</button></footer>
    </form>
  </div>;
}

function SettingsDialog({ onClose, notify }: { onClose(): void; notify(message: string): void }) {
  const client = useQueryClient();
  const repositories = useQuery({ queryKey: ["registered-repositories"], queryFn: api.registeredRepositories });
  const knowledgeRepositories = useQuery({ queryKey: ["knowledge-repositories"], queryFn: api.knowledgeRepositories });
  const [name, setName] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [knowledgeName, setKnowledgeName] = useState("");
  const [knowledgePath, setKnowledgePath] = useState("");
  const [knowledgeBranch, setKnowledgeBranch] = useState("");
  const [knowledgeDescription, setKnowledgeDescription] = useState("");
  const create = useMutation({
    mutationFn: api.createRegisteredRepository,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["registered-repositories"] });
      setName("");
      setSourcePath("");
      setDefaultBranch("");
      notify("仓库已登记");
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteRegisteredRepository,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["registered-repositories"] });
      notify("已从仓库库移除，不会删除本地代码");
    },
  });
  const createKnowledge = useMutation({
    mutationFn: api.createKnowledgeRepository,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["knowledge-repositories"] });
      setKnowledgeName(""); setKnowledgePath(""); setKnowledgeBranch(""); setKnowledgeDescription("");
      notify("知识库已登记");
    },
  });
  const removeKnowledge = useMutation({
    mutationFn: api.deleteKnowledgeRepository,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["knowledge-repositories"] });
      notify("知识库已从应用设置移除，不会删除本地仓库");
    },
  });
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog repository-settings-dialog" role="dialog" aria-modal="true" aria-label="应用设置">
        <header>
          <div><span className="dialog-icon"><Settings2 size={18} /></span><div><h2>应用设置</h2><p>登记常用本地仓库，创建任务时可直接选择</p></div></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="dialog-body">
          <section className="settings-section">
            <div className="settings-section-heading"><div><strong>本地仓库库</strong><span>AgentDesk 只保存路径；任务启动时才会创建新分支和 worktree。</span></div><b>{repositories.data?.length ?? 0}</b></div>
            <form className="repository-register-form" onSubmit={(event) => {
              event.preventDefault();
              create.mutate({ name: name.trim() || undefined, sourcePath, defaultBranch: defaultBranch.trim() || undefined });
            }}>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="显示名称（可选）" />
              <input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="本地 Git 仓库路径，例如 E:\\code\\order-service" required />
              <input value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} placeholder="基准分支（默认当前分支）" />
              <button className="primary-button" disabled={create.isPending || !sourcePath.trim()}>{create.isPending ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}登记仓库</button>
            </form>
            {create.error && <ErrorBanner error={create.error} />}
            <div className="registered-repository-list">
              {repositories.data?.map((repository) => (
                <article key={repository.id}>
                  <span><FolderGit2 size={16} /></span>
                  <div><strong>{repository.name}</strong><code title={repository.sourcePath}>{repository.sourcePath}</code><small><GitBranch size={11} />{repository.defaultBranch}</small></div>
                  <button className="icon-button" aria-label={`移除仓库 ${repository.name}`} disabled={remove.isPending} onClick={() => {
                    if (window.confirm(`从仓库库移除“${repository.name}”？不会删除本地仓库或已有 worktree。`)) remove.mutate(repository.id);
                  }}><Trash2 size={15} /></button>
                </article>
              ))}
              {!repositories.isLoading && !repositories.data?.length && <SmallEmpty>还没有登记仓库</SmallEmpty>}
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-section-heading"><div><strong>本地知识库</strong><span>独立 Git 仓库；任务可选择多个，并为每个任务创建隔离 worktree。</span></div><b>{knowledgeRepositories.data?.length ?? 0}</b></div>
            <form className="repository-register-form" onSubmit={(event) => {
              event.preventDefault();
              createKnowledge.mutate({ name: knowledgeName.trim() || undefined, sourcePath: knowledgePath, defaultBranch: knowledgeBranch.trim() || undefined, description: knowledgeDescription.trim() || undefined });
            }}>
              <input value={knowledgeName} onChange={(event) => setKnowledgeName(event.target.value)} placeholder="知识库名称（可选）" />
              <input value={knowledgePath} onChange={(event) => setKnowledgePath(event.target.value)} placeholder="本地知识库 Git 路径" required />
              <input value={knowledgeBranch} onChange={(event) => setKnowledgeBranch(event.target.value)} placeholder="主干分支（默认当前分支）" />
              <input value={knowledgeDescription} onChange={(event) => setKnowledgeDescription(event.target.value)} placeholder="适用范围说明（可选）" />
              <button className="primary-button" disabled={createKnowledge.isPending || !knowledgePath.trim()}>{createKnowledge.isPending ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}登记知识库</button>
            </form>
            {createKnowledge.error && <ErrorBanner error={createKnowledge.error} />}
            <div className="registered-repository-list">
              {knowledgeRepositories.data?.map((repository) => (
                <article key={repository.id}>
                  <span><BookOpen size={16} /></span>
                  <div><strong>{repository.name}</strong><code title={repository.sourcePath}>{repository.sourcePath}</code><small><GitBranch size={11} />{repository.defaultBranch}{repository.description ? ` · ${repository.description}` : ""}</small></div>
                  <button className="icon-button" aria-label={`移除知识库 ${repository.name}`} disabled={removeKnowledge.isPending} onClick={() => {
                    if (window.confirm(`从应用设置移除知识库“${repository.name}”？不会删除本地仓库。`)) removeKnowledge.mutate(repository.id);
                  }}><Trash2 size={15} /></button>
                </article>
              ))}
              {!knowledgeRepositories.isLoading && !knowledgeRepositories.data?.length && <SmallEmpty>还没有登记知识库</SmallEmpty>}
            </div>
          </section>
        </div>
        <footer><button className="primary-button" onClick={onClose}>完成</button></footer>
      </section>
    </div>
  );
}

function NewTaskDialog({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(task: Task): void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("codex");
  const collections = useQuery({ queryKey: ["task-collections"], queryFn: api.collections });
  const registeredRepositories = useQuery({ queryKey: ["registered-repositories"], queryFn: api.registeredRepositories });
  const knowledgeRepositories = useQuery({ queryKey: ["knowledge-repositories"], queryFn: api.knowledgeRepositories });
  const [tagsText, setTagsText] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [deliveryTarget, setDeliveryTarget] = useState("");
  const [requirement, setRequirement] = useState("");
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<string[]>([]);
  const [selectedKnowledgeRepositoryIds, setSelectedKnowledgeRepositoryIds] = useState<string[]>([]);
  const [repositories, setRepositories] = useState<TaskRepositoryInput[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const create = useMutation({
    mutationFn: async (input: CreateTaskInput) => {
      const task = await api.createTask(input);
      for (const file of files) await api.upload(task.id, file);
      return api.task(task.id);
    },
    onSuccess: onCreated,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const selectedRepositories = (registeredRepositories.data ?? [])
      .filter((repository) => selectedRepositoryIds.includes(repository.id))
      .map((repository) => ({ sourcePath: repository.sourcePath, baseBranch: repository.defaultBranch }));
    const uniqueRepositories = [...new Map([...selectedRepositories, ...repositories]
      .filter((repository) => repository.sourcePath.trim())
      .map((repository) => [repository.sourcePath.trim().toLocaleLowerCase(), repository])).values()];
    create.mutate({
      title,
      description,
      provider,
      requirement,
      repositories: uniqueRepositories,
      knowledgeRepositoryIds: selectedKnowledgeRepositoryIds,
      source: { type: "manual", label: "直接创建" },
      tags: tagsText.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      collectionId: collectionId || undefined,
      acceptanceCriteria: acceptanceCriteria.trim() || undefined,
      deliveryTarget: deliveryTarget.trim() || undefined,
    });
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit}>
        <header>
          <div><span className="dialog-icon"><Sparkles size={18} /></span><div><h2>新建开发任务</h2><p>创建独立工作区并交给本地 Coding Agent</p></div></div>
          <button type="button" className="icon-button" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="dialog-body">
          <label className="field">
            <span>任务标题</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：退款链路兼容性改造" autoFocus required />
          </label>
          <label className="field">
            <span>补充说明</span>
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="可选：说明目标、范围或截止时间" />
          </label>
          <div className="dialog-two-columns">
            <label className="field"><span>自定义标签</span><input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="前端, 计算器（逗号分隔）" /></label>
            <label className="field"><span>任务收纳</span><select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}><option value="">未收纳</option>{collections.data?.map((collection) => <option value={collection.id} key={collection.id}>{collection.name}</option>)}</select></label>
          </div>
          <fieldset className="field">
            <legend>运行 Agent</legend>
            <div className="provider-options">
              {(["codex", "qoder", "qwen-code"] as const).map((item) => (
                <label className={provider === item ? "selected" : ""} key={item}>
                  <input type="radio" name="provider" value={item} checked={provider === item} onChange={() => setProvider(item)} />
                  <Bot size={18} />
                  <span><strong>{agentMeta[item].name}</strong><small>{agentMeta[item].runtime}</small></span>
                  {provider === item && <CheckCircle2 size={16} />}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field">
            <span>交付目标（可选）</span>
            <textarea value={deliveryTarget} onChange={(event) => setDeliveryTarget(event.target.value)} rows={2} placeholder="例如：完成退款链路改造并推送到任务分支。" />
          </label>
          <label className="field">
            <span>验收标准（可选）</span>
            <textarea value={acceptanceCriteria} onChange={(event) => setAcceptanceCriteria(event.target.value)} rows={3} placeholder="例如：自动化测试通过；移动端可用；展示关键运行证据。" />
          </label>
          <label className="field">
            <span>需求说明</span>
            <textarea value={requirement} onChange={(event) => setRequirement(event.target.value)} placeholder="粘贴 PRD、会议结论、验收条件或其他上下文…" rows={5} />
          </label>
          <div className="field">
            <div className="field-heading"><span>关联知识库（可选）</span></div>
            <div className="repository-picker">
              {knowledgeRepositories.data?.map((repository) => {
                const selected = selectedKnowledgeRepositoryIds.includes(repository.id);
                return (
                  <label className={selected ? "selected" : ""} key={repository.id}>
                    <input type="checkbox" checked={selected} onChange={() => setSelectedKnowledgeRepositoryIds((current) => selected ? current.filter((id) => id !== repository.id) : [...current, repository.id])} />
                    <BookOpen size={15} />
                    <span><strong>{repository.name}</strong><small title={repository.sourcePath}>{repository.description || repository.sourcePath}</small></span>
                    <code>{repository.defaultBranch}</code>
                    {selected && <Check size={14} />}
                  </label>
                );
              })}
              {!knowledgeRepositories.isLoading && !knowledgeRepositories.data?.length && (
                <div className="repository-picker-empty"><Settings2 size={14} /><span>尚未登记知识库，可在应用设置中添加；不选择时不会执行知识检索与沉淀。</span></div>
              )}
            </div>
          </div>
          <div className="field">
            <div className="field-heading"><span>关联代码仓库</span><button type="button" className="text-button" onClick={() => setRepositories((current) => [...current, { sourcePath: "", baseBranch: "" }])}><Plus size={13} />临时添加路径</button></div>
            <div className="repository-picker">
              {registeredRepositories.data?.map((repository) => {
                const selected = selectedRepositoryIds.includes(repository.id);
                return (
                  <label className={selected ? "selected" : ""} key={repository.id}>
                    <input type="checkbox" checked={selected} onChange={() => setSelectedRepositoryIds((current) => selected ? current.filter((id) => id !== repository.id) : [...current, repository.id])} />
                    <FolderGit2 size={15} />
                    <span><strong>{repository.name}</strong><small title={repository.sourcePath}>{repository.sourcePath}</small></span>
                    <code>{repository.defaultBranch}</code>
                    {selected && <Check size={14} />}
                  </label>
                );
              })}
              {!registeredRepositories.isLoading && !registeredRepositories.data?.length && (
                <div className="repository-picker-empty"><Settings2 size={14} /><span>尚未登记常用仓库，可在左下角“应用设置”中添加，也可以临时填写路径。</span></div>
              )}
            </div>
            <div className="repo-inputs">
              {repositories.map((repo, index) => (
                <div className="repo-input-row" key={index}>
                  <FolderGit2 size={16} />
                  <input
                    value={repo.sourcePath}
                    onChange={(event) => setRepositories((current) => current.map((item, i) => i === index ? { ...item, sourcePath: event.target.value } : item))}
                    placeholder="E:\code\order-service"
                  />
                  <input
                    className="branch-input"
                    value={repo.baseBranch}
                    onChange={(event) => setRepositories((current) => current.map((item, i) => i === index ? { ...item, baseBranch: event.target.value } : item))}
                    placeholder="当前分支"
                  />
                  <button type="button" className="icon-button" aria-label="移除临时仓库" onClick={() => setRepositories((current) => current.filter((_, i) => i !== index))}><X size={15} /></button>
                </div>
              ))}
            </div>
          </div>
          <label className="upload-zone">
            <Upload size={19} />
            <span><strong>补充材料</strong><small>{files.length ? files.map((file) => file.name).join("、") : "PDF、Markdown、图片或其他文件，单文件最大 50MB"}</small></span>
            <input type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
          </label>
          {create.error && <ErrorBanner error={create.error} />}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={create.isPending || !title.trim()}>
            {create.isPending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
            创建任务
          </button>
        </footer>
      </form>
    </div>
  );
}

function Welcome({ onCreate }: { onCreate(): void }) {
  return (
    <div className="welcome">
      <div className="welcome-mark"><Sparkles size={30} /></div>
      <span className="eyebrow">PERSONAL AGENT COCKPIT</span>
      <h1>从需求材料到可验证的代码变更</h1>
      <p>为多个仓库准备独立 Worktree，在一个页面中运行 Codex 或 Qoder，并处理提问、权限和结果。</p>
      <button className="primary-button" onClick={onCreate}><Plus size={16} />创建第一个任务</button>
      <div className="welcome-flow">
        <span><FileText size={16} />导入需求</span><ChevronRight size={15} />
        <span><FolderGit2 size={16} />准备仓库</span><ChevronRight size={15} />
        <span><Bot size={16} />运行 Agent</span><ChevronRight size={15} />
        <span><CheckCircle2 size={16} />验证交付</span>
      </div>
    </div>
  );
}

function Summary({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="summary"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}

function PanelTitle({ icon, title, badge }: { icon: React.ReactNode; title: string; badge?: number }) {
  return <div className="panel-title"><span>{icon}{title}</span>{badge ? <b>{badge}</b> : null}</div>;
}

function ContextGroup({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return <div className="context-group"><div className="context-heading"><span>{title}</span>{count !== undefined && <b>{count}</b>}</div>{children}</div>;
}

function SmallEmpty({ children }: { children: React.ReactNode }) {
  return <div className="small-empty">{children}</div>;
}

function SidebarSkeleton() {
  return <><div className="skeleton task-skeleton" /><div className="skeleton task-skeleton" /><div className="skeleton task-skeleton" /></>;
}

function ErrorBanner({ error }: { error: unknown }) {
  return <div className="error-banner"><AlertTriangle size={16} /><span>{error instanceof Error ? error.message : String(error)}</span></div>;
}
