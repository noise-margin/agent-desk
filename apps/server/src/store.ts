import fs from "node:fs";
import Database from "better-sqlite3";
import type {
  AgentEvent,
  AgentEventType,
  AgentProvider,
  AgentSession,
  CreateTaskInput,
  InteractionType,
  Material,
  PendingInteraction,
  RegisteredRepository,
  SaveRegisteredRepositoryInput,
  Task,
  TaskActivity,
  TaskActivityType,
  TaskCollection,
  TaskRepository,
  TaskRepositoryInput,
  TaskStatus,
  WorkflowArtifact,
  WorkflowNodeRun,
  WorkflowNodeStatus,
  WorkflowRun,
} from "@agentdesk/protocol";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { resolveWorkflowTemplate } from "./workflow-templates.js";
import { buildInteractionPresentation } from "./interaction-presentation.js";

function now() {
  return new Date().toISOString();
}

function normalizeTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

function safeJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? normalizeTags(parsed.map(String)) : [];
  } catch {
    return [];
  }
}

function mapCollection(row: Record<string, unknown>): TaskCollection {
  return {
    id: String(row.id),
    name: String(row.name),
    color: row.color ? String(row.color) : undefined,
    createdAt: String(row.created_at),
  };
}

function mapRegisteredRepository(row: Record<string, unknown>): RegisteredRepository {
  return {
    id: String(row.id),
    name: String(row.name),
    sourcePath: String(row.source_path),
    defaultBranch: String(row.default_branch),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class Store {
  private readonly db: Database.Database;

  constructor(databasePath = config.databasePath) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.markRunningExecutionsInterrupted();
  }

  private markRunningExecutionsInterrupted() {
    const interruptedAt = now();
    const activeSessions = this.db
      .prepare("SELECT id,task_id,status FROM sessions WHERE status IN ('starting','running','waiting_user')")
      .all() as Array<{ id: string; task_id: string; status: string }>;
    this.db
      .prepare(
        "UPDATE interactions SET status = 'stale', resolved_at = ? WHERE status = 'pending'",
      )
      .run(interruptedAt);
    if (!activeSessions.length) return;
    const taskIds = [...new Set(activeSessions.map((session) => session.task_id))];
    const transaction = this.db.transaction(() => {
      this.db
        .prepare("UPDATE sessions SET status = 'interrupted', updated_at = ? WHERE status IN ('starting','running','waiting_user')")
        .run(interruptedAt);
      const updateTask = this.db.prepare("UPDATE tasks SET status='interrupted', updated_at=? WHERE id=?");
      const getWorkflow = this.db.prepare("SELECT id,status,current_node_id,nodes FROM workflow_runs WHERE task_id=?");
      const updateWorkflow = this.db.prepare("UPDATE workflow_runs SET status='interrupted',nodes=?,updated_at=? WHERE id=?");
      const addActivity = this.db.prepare("INSERT INTO task_activities (task_id,type,payload,created_at) VALUES (?,?,?,?)");
      for (const taskId of taskIds) {
        updateTask.run(interruptedAt, taskId);
        const workflow = getWorkflow.get(taskId) as { id: string; status: string; current_node_id?: string; nodes: string } | undefined;
        let nodeId: string | undefined;
        if (workflow && ["running", "interrupted"].includes(workflow.status)) {
          const nodes = JSON.parse(workflow.nodes) as WorkflowNodeRun[];
          nodeId = workflow.current_node_id;
          const current = nodes.find((node) => node.id === nodeId);
          if (current && current.status === "running") current.status = "interrupted";
          updateWorkflow.run(JSON.stringify(nodes), interruptedAt, workflow.id);
        }
        addActivity.run(taskId, "workflow.interrupted", JSON.stringify({
          nodeId,
          reason: "agentdesk_process_stopped",
          sessions: activeSessions.filter((session) => session.task_id === taskId).map((session) => ({ id: session.id, previousStatus: session.status })),
        }), interruptedAt);
      }
    });
    transaction();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        source_path TEXT NOT NULL,
        base_branch TEXT,
        worktree_path TEXT,
        task_branch TEXT,
        base_commit TEXT
      );
      CREATE TABLE IF NOT EXISTS registered_repositories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL UNIQUE,
        default_branch TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS materials (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT,
        content TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task_id_id ON events(task_id, id);
      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_request_id TEXT NOT NULL,
        method TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS task_activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_activities_task_id_id
        ON task_activities(task_id, id);
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        current_node_id TEXT,
        acceptance_criteria TEXT,
        nodes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        workflow_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        path TEXT,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const materialColumns = this.db.prepare("PRAGMA table_info(materials)").all() as Array<{
      name: string;
    }>;
    if (!materialColumns.some((column) => column.name === "deleted_at")) {
      this.db.exec("ALTER TABLE materials ADD COLUMN deleted_at TEXT");
    }
    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "source_type")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'");
    }
    if (!taskColumns.some((column) => column.name === "source_label")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN source_label TEXT NOT NULL DEFAULT '直接创建'");
    }
    if (!taskColumns.some((column) => column.name === "source_external_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN source_external_id TEXT");
    }
    if (!taskColumns.some((column) => column.name === "tags")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    }
    if (!taskColumns.some((column) => column.name === "collection_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN collection_id TEXT");
    }
    this.db.exec(`
      INSERT INTO task_activities (task_id,type,payload,created_at)
      SELECT m.task_id, 'material.added',
             json_object('materialId', m.id, 'name', m.name, 'kind', m.kind, 'source', 'migration'),
             m.created_at
      FROM materials m
      WHERE NOT EXISTS (
        SELECT 1 FROM task_activities a
        WHERE a.task_id = m.task_id
          AND a.type = 'material.added'
          AND json_extract(a.payload, '$.materialId') = m.id
      )
    `);
  }

  close() {
    this.db.close();
  }

  createTask(input: CreateTaskInput): Task {
    const id = randomUUID();
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tasks
          (id,title,description,provider,status,created_at,updated_at,source_type,source_label,source_external_id,tags,collection_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.title.trim(),
          input.description?.trim() || null,
          input.provider,
          "draft",
          timestamp,
          timestamp,
          input.source?.type ?? "manual",
          input.source?.label?.trim() || "直接创建",
          input.source?.externalId?.trim() || null,
          JSON.stringify(normalizeTags(input.tags ?? [])),
          input.collectionId || null,
        );

      const insertRepo = this.db.prepare(
        `INSERT INTO repositories (id,task_id,source_path,base_branch)
         VALUES (?,?,?,?)`,
      );
      const seenRepositories = new Set<string>();
      for (const repo of input.repositories) {
        const sourcePath = repo.sourcePath.trim();
        const identity = process.platform === "win32" ? sourcePath.toLocaleLowerCase() : sourcePath;
        if (!sourcePath || seenRepositories.has(identity)) continue;
        seenRepositories.add(identity);
        insertRepo.run(randomUUID(), id, sourcePath, repo.baseBranch?.trim() || null);
      }

      if (input.requirement?.trim()) {
        const materialId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO materials (id,task_id,name,kind,content,created_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .run(materialId, id, "需求说明.md", "text", input.requirement.trim(), timestamp);
        this.db
          .prepare(
            `INSERT INTO task_activities (task_id,type,payload,created_at)
             VALUES (?,?,?,?)`,
          )
          .run(
            id,
            "material.added",
            JSON.stringify({ materialId, name: "需求说明.md", source: "task_creation" }),
            timestamp,
          );
      }
    });
    transaction();
    if (input.workflow) {
      this.createWorkflow(id, input.workflow);
    }
    return this.getTask(id)!;
  }

  listTasks(): Task[] {
    const rows = this.db
      .prepare("SELECT id FROM tasks ORDER BY updated_at DESC")
      .all() as { id: string }[];
    return rows.map((row) => this.getTask(row.id)!).filter(Boolean);
  }

  listRegisteredRepositories(): RegisteredRepository[] {
    const rows = this.db
      .prepare("SELECT * FROM registered_repositories ORDER BY name COLLATE NOCASE, source_path COLLATE NOCASE")
      .all() as Record<string, unknown>[];
    return rows.map(mapRegisteredRepository);
  }

  getRegisteredRepository(id: string): RegisteredRepository | undefined {
    const row = this.db.prepare("SELECT * FROM registered_repositories WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? mapRegisteredRepository(row) : undefined;
  }

  createRegisteredRepository(input: Required<SaveRegisteredRepositoryInput>): RegisteredRepository {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(
      `INSERT INTO registered_repositories (id,name,source_path,default_branch,created_at,updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(id, input.name.trim(), input.sourcePath, input.defaultBranch, timestamp, timestamp);
    return mapRegisteredRepository(this.db.prepare("SELECT * FROM registered_repositories WHERE id=?").get(id) as Record<string, unknown>);
  }

  deleteRegisteredRepository(id: string): boolean {
    return this.db.prepare("DELETE FROM registered_repositories WHERE id=?").run(id).changes > 0;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      title: String(row.title),
      description: row.description ? String(row.description) : undefined,
      provider: row.provider as AgentProvider,
      status: row.status as TaskStatus,
      workspacePath: row.workspace_path ? String(row.workspace_path) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      source: {
        type: (row.source_type || "manual") as Task["source"]["type"],
        label: String(row.source_label || "直接创建"),
        externalId: row.source_external_id ? String(row.source_external_id) : undefined,
      },
      tags: safeJsonArray(row.tags),
      collectionId: row.collection_id ? String(row.collection_id) : undefined,
      collection: row.collection_id ? this.getCollection(String(row.collection_id)) : undefined,
      repositories: this.repositories(id),
      materials: this.materials(id),
      sessions: this.sessions(id),
      interactions: this.interactions(id),
      activities: this.activities(id),
      workflow: this.getWorkflow(id),
    };
  }

  updateTask(
    id: string,
    patch: Partial<{ status: TaskStatus; workspacePath: string }>,
  ) {
    if (patch.status) {
      this.db
        .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(patch.status, now(), id);
    }
    if (patch.workspacePath) {
      this.db
        .prepare("UPDATE tasks SET workspace_path = ?, updated_at = ? WHERE id = ?")
        .run(patch.workspacePath, now(), id);
    }
  }

  listCollections(): TaskCollection[] {
    const rows = this.db.prepare("SELECT * FROM task_collections ORDER BY name COLLATE NOCASE").all() as Record<string, unknown>[];
    return rows.map(mapCollection);
  }

  getCollection(id: string): TaskCollection | undefined {
    const row = this.db.prepare("SELECT * FROM task_collections WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? mapCollection(row) : undefined;
  }

  createCollection(input: { name: string; color?: string }): TaskCollection {
    const collection: TaskCollection = {
      id: randomUUID(),
      name: input.name.trim(),
      color: input.color?.trim() || undefined,
      createdAt: now(),
    };
    this.db.prepare("INSERT INTO task_collections (id,name,color,created_at) VALUES (?,?,?,?)")
      .run(collection.id, collection.name, collection.color ?? null, collection.createdAt);
    return collection;
  }

  updateTaskOrganization(taskId: string, input: { tags: string[]; collectionId?: string | null }): Task {
    if (input.collectionId && !this.getCollection(input.collectionId)) {
      throw new Error("收纳不存在");
    }
    this.db.prepare("UPDATE tasks SET tags=?, collection_id=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(normalizeTags(input.tags)), input.collectionId || null, now(), taskId);
    const task = this.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    return task;
  }

  private repositories(taskId: string): TaskRepository[] {
    const rows = this.db
      .prepare("SELECT * FROM repositories WHERE task_id = ? ORDER BY rowid")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      sourcePath: String(row.source_path),
      baseBranch: row.base_branch ? String(row.base_branch) : undefined,
      worktreePath: row.worktree_path ? String(row.worktree_path) : undefined,
      taskBranch: row.task_branch ? String(row.task_branch) : undefined,
      baseCommit: row.base_commit ? String(row.base_commit) : undefined,
    }));
  }

  addTaskRepository(taskId: string, input: TaskRepositoryInput): TaskRepository {
    const task = this.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    const sourcePath = input.sourcePath.trim();
    const normalize = (value: string) => process.platform === "win32" ? value.toLocaleLowerCase() : value;
    if (task.repositories.some((repository) => normalize(repository.sourcePath) === normalize(sourcePath))) {
      throw new Error("该任务已经关联此仓库");
    }
    const id = randomUUID();
    this.db.prepare(
      "INSERT INTO repositories (id,task_id,source_path,base_branch) VALUES (?,?,?,?)",
    ).run(id, taskId, sourcePath, input.baseBranch?.trim() || null);
    this.db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(now(), taskId);
    return this.repositories(taskId).find((repository) => repository.id === id)!;
  }

  removeTaskRepository(id: string): boolean {
    return this.db.prepare("DELETE FROM repositories WHERE id=? AND worktree_path IS NULL").run(id).changes > 0;
  }

  updateRepository(
    id: string,
    patch: { baseBranch: string; worktreePath: string; taskBranch: string; baseCommit: string },
  ) {
    this.db
      .prepare(
        `UPDATE repositories
         SET base_branch=?, worktree_path=?, task_branch=?, base_commit=?
         WHERE id=?`,
      )
      .run(patch.baseBranch, patch.worktreePath, patch.taskBranch, patch.baseCommit, id);
  }

  private materials(taskId: string): Material[] {
    const rows = this.db
      .prepare("SELECT * FROM materials WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      name: String(row.name),
      kind: row.kind as Material["kind"],
      path: row.path ? String(row.path) : undefined,
      content: row.content ? String(row.content) : undefined,
      createdAt: String(row.created_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : undefined,
    }));
  }

  getMaterial(id: string): Material | undefined {
    const row = this.db.prepare("SELECT * FROM materials WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      name: String(row.name),
      kind: row.kind as Material["kind"],
      path: row.path ? String(row.path) : undefined,
      content: row.content ? String(row.content) : undefined,
      createdAt: String(row.created_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : undefined,
    };
  }

  addMaterial(input: {
    taskId: string;
    name: string;
    kind: Material["kind"];
    path?: string;
    content?: string;
  }): Material {
    const material: Material = {
      id: randomUUID(),
      taskId: input.taskId,
      name: input.name,
      kind: input.kind,
      path: input.path,
      content: input.content,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO materials (id,task_id,name,kind,path,content,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        material.id,
        material.taskId,
        material.name,
        material.kind,
        material.path ?? null,
        material.content ?? null,
        material.createdAt,
      );
    this.db
      .prepare("UPDATE tasks SET updated_at=? WHERE id=?")
      .run(material.createdAt, material.taskId);
    return material;
  }

  removeMaterial(id: string): Material | undefined {
    const material = this.getMaterial(id);
    if (!material || material.deletedAt) return undefined;
    const deletedAt = now();
    this.db.prepare("UPDATE materials SET deleted_at=? WHERE id=?").run(deletedAt, id);
    this.db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(deletedAt, material.taskId);
    return material;
  }

  updateMaterialPath(id: string, materialPath: string) {
    this.db.prepare("UPDATE materials SET path=? WHERE id=?").run(materialPath, id);
  }

  addActivity(
    taskId: string,
    type: TaskActivityType,
    payload: Record<string, unknown> = {},
  ): TaskActivity {
    const createdAt = now();
    const result = this.db
      .prepare(
        "INSERT INTO task_activities (task_id,type,payload,created_at) VALUES (?,?,?,?)",
      )
      .run(taskId, type, JSON.stringify(payload), createdAt);
    this.db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(createdAt, taskId);
    return {
      id: Number(result.lastInsertRowid),
      taskId,
      type,
      payload,
      createdAt,
    };
  }

  private activities(taskId: string): TaskActivity[] {
    const rows = this.db
      .prepare("SELECT * FROM task_activities WHERE task_id=? ORDER BY id")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      taskId: String(row.task_id),
      type: row.type as TaskActivityType,
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      createdAt: String(row.created_at),
    }));
  }

  createWorkflow(taskId: string, input: NonNullable<CreateTaskInput["workflow"]>): WorkflowRun {
    const template = resolveWorkflowTemplate(input.templateId, input.nodes);
    const timestamp = now();
    const existingSession = this.sessions(taskId).find((session) => session.providerSessionId);
    const nodes: WorkflowNodeRun[] = template.nodes.map((node) => ({
      ...node,
      status: "pending",
      attempt: 0,
      sessionId: node.kind === "development" ? existingSession?.id : undefined,
    }));
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO workflow_runs
         (id,task_id,template_id,name,status,current_node_id,acceptance_criteria,nodes,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        taskId,
        template.id,
        template.name,
        "idle",
        null,
        input.acceptanceCriteria?.trim() || null,
        JSON.stringify(nodes),
        timestamp,
        timestamp,
      );
    this.addActivity(taskId, "workflow.configured", {
      templateId: template.id,
      name: template.name,
      nodes: nodes.map((node) => ({ id: node.id, kind: node.kind, name: node.name })),
    });
    return this.getWorkflow(taskId)!;
  }

  replaceWorkflow(taskId: string, input: NonNullable<CreateTaskInput["workflow"]>) {
    const workflow = this.getWorkflow(taskId);
    if (!workflow) return this.createWorkflow(taskId, input);
    if (workflow.status !== "idle" || workflow.nodes.some((node) => node.attempt > 0)) {
      throw new Error("工作流已经开始执行，不能再更换模板");
    }
    this.db.prepare("DELETE FROM workflow_runs WHERE task_id=?").run(taskId);
    return this.createWorkflow(taskId, input);
  }

  getWorkflow(taskId: string): WorkflowRun | undefined {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE task_id=?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const artifacts = this.db
      .prepare("SELECT * FROM workflow_artifacts WHERE task_id=? ORDER BY created_at")
      .all(taskId) as Record<string, unknown>[];
    return {
      id: String(row.id),
      taskId,
      templateId: String(row.template_id),
      name: String(row.name),
      status: row.status as WorkflowRun["status"],
      currentNodeId: row.current_node_id ? String(row.current_node_id) : undefined,
      acceptanceCriteria: row.acceptance_criteria ? String(row.acceptance_criteria) : undefined,
      nodes: JSON.parse(String(row.nodes)) as WorkflowNodeRun[],
      artifacts: artifacts.map((artifact) => ({
        id: String(artifact.id),
        taskId,
        nodeId: String(artifact.node_id),
        kind: artifact.kind as WorkflowArtifact["kind"],
        title: String(artifact.title),
        content: artifact.content ? String(artifact.content) : undefined,
        path: artifact.path ? String(artifact.path) : undefined,
        metadata: JSON.parse(String(artifact.metadata)) as Record<string, unknown>,
        createdAt: String(artifact.created_at),
      })),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  updateWorkflow(
    taskId: string,
    patch: Partial<Pick<WorkflowRun, "status" | "currentNodeId" | "nodes">>,
  ) {
    const workflow = this.getWorkflow(taskId);
    if (!workflow) throw new Error("工作流不存在");
    const status = patch.status ?? workflow.status;
    const currentNodeId = patch.currentNodeId === undefined ? workflow.currentNodeId : patch.currentNodeId;
    const nodes = patch.nodes ?? workflow.nodes;
    this.db
      .prepare(
        "UPDATE workflow_runs SET status=?,current_node_id=?,nodes=?,updated_at=? WHERE task_id=?",
      )
      .run(status, currentNodeId ?? null, JSON.stringify(nodes), now(), taskId);
  }

  updateWorkflowNode(
    taskId: string,
    nodeId: string,
    patch: Partial<Pick<WorkflowNodeRun, "status" | "attempt" | "sessionId" | "startedAt" | "completedAt" | "output">>,
  ) {
    const workflow = this.getWorkflow(taskId);
    if (!workflow) throw new Error("工作流不存在");
    const nodes = workflow.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node);
    this.updateWorkflow(taskId, { nodes });
  }

  findWorkflowNodeBySession(sessionId: string) {
    const rows = this.db.prepare("SELECT task_id,nodes FROM workflow_runs").all() as Array<{
      task_id: string;
      nodes: string;
    }>;
    for (const row of rows) {
      const node = (JSON.parse(row.nodes) as WorkflowNodeRun[]).find((item) => item.sessionId === sessionId);
      if (node) return { taskId: row.task_id, node };
    }
    return undefined;
  }

  addWorkflowArtifact(
    taskId: string,
    nodeId: string,
    input: Omit<WorkflowArtifact, "id" | "taskId" | "nodeId" | "createdAt">,
  ) {
    const workflow = this.getWorkflow(taskId);
    if (!workflow) throw new Error("工作流不存在");
    const artifact: WorkflowArtifact = {
      id: randomUUID(),
      taskId,
      nodeId,
      createdAt: now(),
      ...input,
    };
    this.db
      .prepare(
        `INSERT INTO workflow_artifacts
         (id,task_id,workflow_id,node_id,kind,title,content,path,metadata,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        artifact.id,
        taskId,
        workflow.id,
        nodeId,
        artifact.kind,
        artifact.title,
        artifact.content ?? null,
        artifact.path ?? null,
        JSON.stringify(artifact.metadata),
        artifact.createdAt,
      );
    return artifact;
  }

  updateWorkflowArtifact(
    id: string,
    patch: Partial<Pick<WorkflowArtifact, "title" | "content" | "path" | "metadata">>,
  ) {
    const row = this.db.prepare("SELECT * FROM workflow_artifacts WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("工作流产物不存在");
    this.db.prepare("UPDATE workflow_artifacts SET title=?,content=?,path=?,metadata=? WHERE id=?").run(
      patch.title ?? String(row.title),
      patch.content ?? (row.content ? String(row.content) : null),
      patch.path ?? (row.path ? String(row.path) : null),
      JSON.stringify(patch.metadata ?? JSON.parse(String(row.metadata))),
      id,
    );
  }

  sessionEvents(sessionId: string): AgentEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE session_id=? ORDER BY id")
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => this.mapEvent(row));
  }

  createSession(taskId: string, provider: AgentProvider): AgentSession {
    const timestamp = now();
    const session: AgentSession = {
      id: randomUUID(),
      taskId,
      provider,
      status: "starting",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO sessions
        (id,task_id,provider,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        session.id,
        session.taskId,
        session.provider,
        session.status,
        session.createdAt,
        session.updatedAt,
      );
    return session;
  }

  private sessions(taskId: string): AgentSession[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      provider: row.provider as AgentProvider,
      providerSessionId: row.provider_session_id
        ? String(row.provider_session_id)
        : undefined,
      status: row.status as AgentSession["status"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  updateSession(
    id: string,
    patch: Partial<Pick<AgentSession, "status" | "providerSessionId">>,
  ) {
    if (patch.status) {
      this.db
        .prepare("UPDATE sessions SET status=?, updated_at=? WHERE id=?")
        .run(patch.status, now(), id);
    }
    if (patch.providerSessionId) {
      this.db
        .prepare("UPDATE sessions SET provider_session_id=?, updated_at=? WHERE id=?")
        .run(patch.providerSessionId, now(), id);
    }
  }

  addEvent(
    taskId: string,
    sessionId: string,
    type: AgentEventType,
    payload: Record<string, unknown> = {},
  ): AgentEvent {
    const createdAt = now();
    const result = this.db
      .prepare(
        "INSERT INTO events (task_id,session_id,type,payload,created_at) VALUES (?,?,?,?,?)",
      )
      .run(taskId, sessionId, type, JSON.stringify(payload), createdAt);
    return {
      id: Number(result.lastInsertRowid),
      taskId,
      sessionId,
      type,
      payload,
      createdAt,
    };
  }

  events(taskId: string, after = 0): AgentEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id")
      .all(taskId, after) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      taskId: String(row.task_id),
      sessionId: String(row.session_id),
      type: row.type as AgentEventType,
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      createdAt: String(row.created_at),
    }));
  }

  eventPage(
    taskId: string,
    options: { before?: number; limit: number; mode: "timeline" | "raw" },
  ): { events: AgentEvent[]; hasMore: boolean; nextBefore?: number } {
    const conditions = ["task_id = ?"];
    const parameters: Array<string | number> = [taskId];
    if (options.before) {
      conditions.push("id < ?");
      parameters.push(options.before);
    }
    if (options.mode === "timeline") {
      conditions.push(`(
        type IN (
          'user.followup','session.started','session.resumed','session.status','command.completed','file.changed',
          'interaction.requested','interaction.resolved','turn.started','turn.completed','turn.failed'
        )
        OR (
          type = 'message.completed'
          AND COALESCE(json_extract(payload, '$.item.text'), '') <> ''
        )
        OR (
          type = 'tool.completed'
          AND json_extract(payload, '$.item.type') IN ('fileChange','mcpToolCall','webSearch')
        )
      )`);
    }
    parameters.push(options.limit + 1);
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE ${conditions.join(" AND ")}
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(...parameters) as Record<string, unknown>[];
    const hasMore = rows.length > options.limit;
    const pageRows = rows.slice(0, options.limit).reverse();
    const events = pageRows.map((row) => this.mapEvent(row));
    return {
      events,
      hasMore,
      nextBefore: hasMore ? events[0]?.id : undefined,
    };
  }

  private mapEvent(row: Record<string, unknown>): AgentEvent {
    return {
      id: Number(row.id),
      taskId: String(row.task_id),
      sessionId: String(row.session_id),
      type: row.type as AgentEventType,
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      createdAt: String(row.created_at),
    };
  }

  createInteraction(input: {
    taskId: string;
    sessionId: string;
    agentRequestId: string;
    method: string;
    type: InteractionType;
    payload: unknown;
  }): PendingInteraction {
    const interaction: PendingInteraction = {
      id: randomUUID(),
      ...input,
      status: "pending",
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO interactions
        (id,task_id,session_id,agent_request_id,method,type,status,payload,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        interaction.id,
        interaction.taskId,
        interaction.sessionId,
        interaction.agentRequestId,
        interaction.method,
        interaction.type,
        interaction.status,
        JSON.stringify(interaction.payload),
        interaction.createdAt,
      );
    return interaction;
  }

  getInteraction(id: string): PendingInteraction | undefined {
    const row = this.db.prepare("SELECT * FROM interactions WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapInteraction(row) : undefined;
  }

  private interactions(taskId: string): PendingInteraction[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM interactions WHERE task_id=?
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => this.mapInteraction(row));
  }

  private mapInteraction(row: Record<string, unknown>): PendingInteraction {
    const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
    const status = row.status as PendingInteraction["status"];
    const taskId = String(row.task_id);
    const sessionId = String(row.session_id);
    const workspace = status === "pending"
      ? this.db.prepare("SELECT workspace_path FROM tasks WHERE id=?").get(taskId) as { workspace_path?: string } | undefined
      : undefined;
    return {
      id: String(row.id),
      taskId,
      sessionId,
      agentRequestId: String(row.agent_request_id),
      method: String(row.method),
      type: row.type as InteractionType,
      status,
      payload,
      presentation: status === "pending" ? buildInteractionPresentation({
        type: row.type as InteractionType,
        method: String(row.method),
        payload,
        events: this.sessionEvents(sessionId),
        workspacePath: workspace?.workspace_path ? String(workspace.workspace_path) : undefined,
      }) : undefined,
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
    };
  }

  resolveInteraction(
    id: string,
    status: Exclude<PendingInteraction["status"], "pending">,
  ): boolean {
    const result = this.db
      .prepare(
        "UPDATE interactions SET status=?, resolved_at=? WHERE id=? AND status='pending'",
      )
      .run(status, now(), id);
    return result.changes === 1;
  }
}
