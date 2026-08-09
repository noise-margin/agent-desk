import fs from "node:fs";
import Database from "better-sqlite3";
import type {
  AgentEvent,
  AgentEventType,
  AgentProvider,
  AgentSession,
  ActionArtifact,
  ActionRun,
  ActionRunStatus,
  CodeSnapshot,
  CreateTaskInput,
  InteractionType,
  KnowledgeRepository,
  Material,
  PendingInteraction,
  RegisteredRepository,
  SaveRegisteredRepositoryInput,
  SaveKnowledgeRepositoryInput,
  Task,
  TaskActivity,
  TaskActivityType,
  TaskCollection,
  TaskRepository,
  TaskRepositoryInput,
  TaskKnowledgeRepository,
  TaskStatus,
} from "@agentdesk/protocol";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
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

function mapKnowledgeRepository(row: Record<string, unknown>): KnowledgeRepository {
  return {
    id: String(row.id), name: String(row.name), sourcePath: String(row.source_path),
    defaultBranch: String(row.default_branch),
    description: row.description ? String(row.description) : undefined,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
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
      const interruptActions = this.db.prepare("UPDATE action_runs SET status='interrupted',completed_at=? WHERE task_id=? AND status='running'");
      const addActivity = this.db.prepare("INSERT INTO task_activities (task_id,type,payload,created_at) VALUES (?,?,?,?)");
      for (const taskId of taskIds) {
        updateTask.run(interruptedAt, taskId);
        interruptActions.run(interruptedAt, taskId);
        addActivity.run(taskId, "action.interrupted", JSON.stringify({
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
      CREATE TABLE IF NOT EXISTS knowledge_repositories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL UNIQUE,
        default_branch TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_knowledge_repositories (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        knowledge_repository_id TEXT NOT NULL REFERENCES knowledge_repositories(id) ON DELETE RESTRICT,
        worktree_path TEXT,
        task_branch TEXT,
        base_commit TEXT,
        UNIQUE(task_id, knowledge_repository_id)
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
      DROP TABLE IF EXISTS workflow_artifacts;
      DROP TABLE IF EXISTS workflow_runs;
      CREATE TABLE IF NOT EXISTS action_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT NOT NULL,
        snapshot_id TEXT,
        session_id TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_action_runs_task_created ON action_runs(task_id, created_at);
      CREATE TABLE IF NOT EXISTS action_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        action_run_id TEXT NOT NULL REFERENCES action_runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        path TEXT,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_action_artifacts_task_created ON action_artifacts(task_id, created_at);
      CREATE TABLE IF NOT EXISTS code_snapshots (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        repositories TEXT NOT NULL,
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
    if (!taskColumns.some((column) => column.name === "acceptance_criteria")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT");
    }
    if (!taskColumns.some((column) => column.name === "delivery_target")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN delivery_target TEXT");
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
          (id,title,description,provider,status,created_at,updated_at,source_type,source_label,source_external_id,tags,collection_id,acceptance_criteria,delivery_target)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          input.acceptanceCriteria?.trim() || null,
          input.deliveryTarget?.trim() || null,
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

      const insertKnowledge = this.db.prepare(
        `INSERT INTO task_knowledge_repositories (id,task_id,knowledge_repository_id) VALUES (?,?,?)`,
      );
      for (const knowledgeRepositoryId of [...new Set(input.knowledgeRepositoryIds ?? [])]) {
        if (this.getKnowledgeRepository(knowledgeRepositoryId)) {
          insertKnowledge.run(randomUUID(), id, knowledgeRepositoryId);
        }
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

  listKnowledgeRepositories(): KnowledgeRepository[] {
    const rows = this.db.prepare("SELECT * FROM knowledge_repositories ORDER BY name COLLATE NOCASE").all() as Record<string, unknown>[];
    return rows.map(mapKnowledgeRepository);
  }

  getKnowledgeRepository(id: string): KnowledgeRepository | undefined {
    const row = this.db.prepare("SELECT * FROM knowledge_repositories WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? mapKnowledgeRepository(row) : undefined;
  }

  createKnowledgeRepository(input: Required<Omit<SaveKnowledgeRepositoryInput, "description">> & { description?: string }): KnowledgeRepository {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO knowledge_repositories (id,name,source_path,default_branch,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, input.name.trim(), input.sourcePath, input.defaultBranch, input.description?.trim() || null, timestamp, timestamp);
    return this.getKnowledgeRepository(id)!;
  }

  deleteKnowledgeRepository(id: string): boolean {
    return this.db.prepare("DELETE FROM knowledge_repositories WHERE id=?").run(id).changes > 0;
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
      knowledgeRepositories: this.taskKnowledgeRepositories(id),
      materials: this.materials(id),
      sessions: this.sessions(id),
      interactions: this.interactions(id),
      activities: this.activities(id),
      actions: this.actions(id),
      artifacts: this.artifacts(id),
      snapshots: this.snapshots(id),
      acceptanceCriteria: row.acceptance_criteria ? String(row.acceptance_criteria) : undefined,
      deliveryTarget: row.delivery_target ? String(row.delivery_target) : undefined,
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

  private taskKnowledgeRepositories(taskId: string): TaskKnowledgeRepository[] {
    const rows = this.db.prepare(`SELECT tkr.*,kr.name,kr.source_path,kr.default_branch,kr.description
      FROM task_knowledge_repositories tkr JOIN knowledge_repositories kr ON kr.id=tkr.knowledge_repository_id
      WHERE tkr.task_id=? ORDER BY tkr.rowid`).all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), taskId: String(row.task_id), knowledgeRepositoryId: String(row.knowledge_repository_id),
      name: String(row.name), sourcePath: String(row.source_path), defaultBranch: String(row.default_branch),
      description: row.description ? String(row.description) : undefined,
      worktreePath: row.worktree_path ? String(row.worktree_path) : undefined,
      taskBranch: row.task_branch ? String(row.task_branch) : undefined,
      baseCommit: row.base_commit ? String(row.base_commit) : undefined,
    }));
  }

  updateTaskKnowledgeRepository(id: string, patch: { worktreePath: string; taskBranch: string; baseCommit: string }) {
    this.db.prepare(`UPDATE task_knowledge_repositories SET worktree_path=?,task_branch=?,base_commit=? WHERE id=?`)
      .run(patch.worktreePath, patch.taskBranch, patch.baseCommit, id);
  }

  addTaskKnowledgeRepository(taskId: string, knowledgeRepositoryId: string): TaskKnowledgeRepository {
    if (!this.getTask(taskId)) throw new Error("任务不存在");
    if (!this.getKnowledgeRepository(knowledgeRepositoryId)) throw new Error("知识库不存在");
    const id = randomUUID();
    this.db.prepare(`INSERT INTO task_knowledge_repositories (id,task_id,knowledge_repository_id) VALUES (?,?,?)`)
      .run(id, taskId, knowledgeRepositoryId);
    this.db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(now(), taskId);
    return this.taskKnowledgeRepositories(taskId).find((item) => item.id === id)!;
  }

  removeTaskKnowledgeRepository(id: string): boolean {
    return this.db.prepare("DELETE FROM task_knowledge_repositories WHERE id=? AND worktree_path IS NULL").run(id).changes > 0;
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

  actions(taskId: string): ActionRun[] {
    const rows = this.db.prepare("SELECT * FROM action_runs WHERE task_id=? ORDER BY created_at").all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), taskId, type: row.type as ActionRun["type"], status: row.status as ActionRunStatus,
      input: JSON.parse(String(row.input)), output: JSON.parse(String(row.output)),
      snapshotId: row.snapshot_id ? String(row.snapshot_id) : undefined,
      sessionId: row.session_id ? String(row.session_id) : undefined,
      startedAt: row.started_at ? String(row.started_at) : undefined,
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  createAction(taskId: string, type: ActionRun["type"], input: Record<string, unknown> = {}): ActionRun {
    const action: ActionRun = { id: randomUUID(), taskId, type, status: "pending", input, output: {}, createdAt: now() };
    this.db.prepare(`INSERT INTO action_runs (id,task_id,type,status,input,output,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(action.id, taskId, type, action.status, JSON.stringify(input), "{}", action.createdAt);
    return action;
  }

  updateAction(id: string, patch: Partial<Pick<ActionRun, "status" | "input" | "output" | "snapshotId" | "sessionId" | "startedAt" | "completedAt">>) {
    const row = this.db.prepare("SELECT * FROM action_runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("动作运行不存在");
    this.db.prepare(`UPDATE action_runs SET status=?,input=?,output=?,snapshot_id=?,session_id=?,started_at=?,completed_at=? WHERE id=?`).run(
      patch.status ?? row.status,
      JSON.stringify(patch.input ?? JSON.parse(String(row.input))),
      JSON.stringify(patch.output ?? JSON.parse(String(row.output))),
      patch.snapshotId === undefined ? row.snapshot_id : patch.snapshotId ?? null,
      patch.sessionId === undefined ? row.session_id : patch.sessionId ?? null,
      patch.startedAt === undefined ? row.started_at : patch.startedAt ?? null,
      patch.completedAt === undefined ? row.completed_at : patch.completedAt ?? null,
      id,
    );
  }

  findActionBySession(sessionId: string) {
    const row = this.db.prepare("SELECT * FROM action_runs WHERE session_id=? ORDER BY created_at DESC LIMIT 1").get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.actions(String(row.task_id)).find((action) => action.id === String(row.id)) : undefined;
  }

  activeAction(taskId: string) {
    return [...this.actions(taskId)].reverse().find((action) => ["pending", "running", "waiting_user", "interrupted"].includes(action.status));
  }

  artifacts(taskId: string): ActionArtifact[] {
    const rows = this.db.prepare("SELECT * FROM action_artifacts WHERE task_id=? ORDER BY created_at").all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), taskId, actionRunId: String(row.action_run_id), kind: row.kind as ActionArtifact["kind"],
      title: String(row.title), content: row.content ? String(row.content) : undefined,
      path: row.path ? String(row.path) : undefined,
      metadata: JSON.parse(String(row.metadata)), createdAt: String(row.created_at),
    }));
  }

  addArtifact(taskId: string, actionRunId: string, input: Omit<ActionArtifact, "id" | "taskId" | "actionRunId" | "createdAt">) {
    const artifact: ActionArtifact = { id: randomUUID(), taskId, actionRunId, createdAt: now(), ...input };
    this.db.prepare(`INSERT INTO action_artifacts (id,task_id,action_run_id,kind,title,content,path,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(artifact.id, taskId, actionRunId, artifact.kind, artifact.title, artifact.content ?? null, artifact.path ?? null, JSON.stringify(artifact.metadata), artifact.createdAt);
    return artifact;
  }

  updateArtifact(id: string, patch: Partial<Pick<ActionArtifact, "title" | "content" | "path" | "metadata">>) {
    const row = this.db.prepare("SELECT * FROM action_artifacts WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("动作产物不存在");
    this.db.prepare("UPDATE action_artifacts SET title=?,content=?,path=?,metadata=? WHERE id=?").run(
      patch.title ?? row.title, patch.content ?? row.content, patch.path ?? row.path,
      JSON.stringify(patch.metadata ?? JSON.parse(String(row.metadata))), id,
    );
  }

  snapshots(taskId: string): CodeSnapshot[] {
    const rows = this.db.prepare("SELECT * FROM code_snapshots WHERE task_id=? ORDER BY created_at").all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({ id: String(row.id), taskId, repositories: JSON.parse(String(row.repositories)), createdAt: String(row.created_at) }));
  }

  addSnapshot(taskId: string, repositories: CodeSnapshot["repositories"]): CodeSnapshot {
    const snapshot: CodeSnapshot = { id: randomUUID(), taskId, repositories, createdAt: now() };
    this.db.prepare("INSERT INTO code_snapshots (id,task_id,repositories,created_at) VALUES (?,?,?,?)")
      .run(snapshot.id, taskId, JSON.stringify(repositories), snapshot.createdAt);
    return snapshot;
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
