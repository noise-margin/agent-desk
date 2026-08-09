import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { spawn as spawnProcess } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  CreateTaskInput,
  ExecuteActionInput,
  HealthResponse,
  ResolveInteractionInput,
  SaveRegisteredRepositoryInput,
} from "@agentdesk/protocol";
import { config } from "./config.js";
import { EventBus } from "./event-bus.js";
import { Orchestrator } from "./orchestrator.js";
import { Store } from "./store.js";
import { WorkspaceService } from "./workspace.js";
import { ActionEngine } from "./action-engine.js";

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().optional(),
  provider: z.enum(["codex", "qoder", "qwen-code"]),
  requirement: z.string().optional(),
  repositories: z
    .array(
      z.object({
        sourcePath: z.string().trim().min(1),
        baseBranch: z.string().optional(),
      }),
    )
    .default([]),
  source: z.object({
    type: z.enum(["manual", "aone", "api", "import"]),
    label: z.string().trim().min(1).max(80),
    externalId: z.string().trim().max(200).optional(),
  }).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  collectionId: z.string().uuid().optional(),
  acceptanceCriteria: z.string().optional(),
  deliveryTarget: z.string().optional(),
});

const followUpSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  persist: z.boolean().default(true),
});

const resolveSchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  answers: z.record(z.string(), z.array(z.string())).optional(),
  content: z.unknown().optional(),
  decision: z.string().optional(),
});

const openPathSchema = z.object({
  target: z.enum(["workspace", "repository"]),
  repositoryId: z.string().optional(),
});

const taskActionSchema = z.object({
  type: z.enum(["generate_plan", "revise_plan", "accept_plan", "start_development", "request_changes", "run_code_review", "run_acceptance", "checkpoint_and_continue", "deliver", "generate_knowledge_proposal", "revise_knowledge_proposal", "accept_knowledge", "reject_knowledge", "archive"]),
  instruction: z.string().trim().max(100_000).optional(),
  feedback: z.string().trim().max(20_000).optional(),
  artifactId: z.string().uuid().optional(),
});

const collectionSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().trim().max(30).optional(),
});

const registeredRepositorySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  sourcePath: z.string().trim().min(1).max(2_000),
  defaultBranch: z.string().trim().max(300).optional(),
});

const addTaskRepositorySchema = z.object({
  registeredRepositoryId: z.string().uuid().optional(),
  sourcePath: z.string().trim().min(1).max(2_000).optional(),
  baseBranch: z.string().trim().max(300).optional(),
}).refine((value) => Boolean(value.registeredRepositoryId || value.sourcePath), {
  message: "请选择已登记仓库或填写仓库路径",
});

const organizationSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  collectionId: z.string().uuid().nullable().optional(),
});

const MATERIAL_PREVIEW_LIMIT = 256 * 1024;

function safeName(value: string) {
  const name = path.basename(value).replace(/[^\p{Letter}\p{Number}._ -]/gu, "_");
  return name.slice(0, 160) || "material.bin";
}

function isWithin(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function openFolder(targetPath: string) {
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawnProcess(command, [targetPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

export async function registerRoutes(
  app: FastifyInstance,
  services: {
    store: Store;
    events: EventBus;
    workspace: WorkspaceService;
    orchestrator: Orchestrator;
    actionEngine: ActionEngine;
  },
) {
  const { store, events, workspace, orchestrator, actionEngine } = services;

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    version: config.version,
    agents: await orchestrator.detectAgents(),
  }));

  app.get("/api/tasks", async () => store.listTasks());

  app.get("/api/registered-repositories", async () => store.listRegisteredRepositories());

  app.post("/api/registered-repositories", async (request, reply) => {
    const parsed = registeredRepositorySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    try {
      const inspected = await workspace.inspectRepository(parsed.data.sourcePath, parsed.data.defaultBranch);
      return reply.code(201).send(store.createRegisteredRepository({
        name: parsed.data.name || inspected.suggestedName,
        sourcePath: inspected.sourcePath,
        defaultBranch: inspected.defaultBranch,
      } as Required<SaveRegisteredRepositoryInput>));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("UNIQUE constraint") ? 409 : 400).send({ error: message.includes("UNIQUE constraint") ? "该仓库已经登记" : `无法读取 Git 仓库：${message}` });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/registered-repositories/:id", async (request, reply) => {
    if (!store.deleteRegisteredRepository(request.params.id)) return reply.code(404).send({ error: "仓库不存在" });
    return { ok: true };
  });

  app.get("/api/task-collections", async () => store.listCollections());

  app.post("/api/task-collections", async (request, reply) => {
    const parsed = collectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    try {
      return reply.code(201).send(store.createCollection(parsed.data));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/available-actions", async (request, reply) => {
    if (!store.getTask(request.params.id)) return reply.code(404).send({ error: "任务不存在" });
    return actionEngine.availableActions(request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/actions", async (request, reply) => {
    const parsed = taskActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    try {
      let task = store.getTask(request.params.id);
      if (task && !task.workspacePath) {
        await workspace.prepare(request.params.id);
        task = store.getTask(request.params.id);
      }
      if (!task) return reply.code(404).send({ error: "任务不存在" });
      return reply.code(202).send(await actionEngine.execute(request.params.id, parsed.data as ExecuteActionInput));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tasks", async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    }
    return reply.code(201).send(store.createTask(parsed.data as CreateTaskInput));
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = store.getTask(request.params.id);
    return task ?? reply.code(404).send({ error: "任务不存在" });
  });

  app.patch<{ Params: { id: string } }>("/api/tasks/:id/organization", async (request, reply) => {
    const parsed = organizationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    try {
      return store.updateTaskOrganization(request.params.id, parsed.data);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { before?: string; limit?: string; mode?: string };
  }>("/api/tasks/:id/events-page", async (request, reply) => {
    if (!store.getTask(request.params.id)) {
      return reply.code(404).send({ error: "任务不存在" });
    }
    const limit = Math.min(Math.max(Number(request.query.limit ?? 60), 10), 200);
    const before = Number(request.query.before);
    const mode = request.query.mode === "raw" ? "raw" : "timeline";
    return store.eventPage(request.params.id, {
      before: Number.isFinite(before) && before > 0 ? before : undefined,
      limit,
      mode,
    });
  });

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/materials",
    async (request, reply) => {
      const task = store.getTask(request.params.id);
      if (!task) return reply.code(404).send({ error: "任务不存在" });
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "请选择文件" });
      const baseDir = task.workspacePath
        ? path.join(task.workspacePath, "materials")
        : path.join(config.dataDir, "uploads", task.id);
      await fs.mkdir(baseDir, { recursive: true });
      const filename = safeName(file.filename);
      let target = path.join(baseDir, filename);
      try {
        await fs.access(target);
        target = path.join(baseDir, `${Date.now()}-${filename}`);
      } catch {
        // The target is available.
      }
      await pipeline(file.file, createWriteStream(target, { flags: "wx" }));
      const material = store.addMaterial({
        taskId: task.id,
        name: path.basename(target),
        kind: "file",
        path: target,
      });
      store.addActivity(task.id, "material.added", {
        materialId: material.id,
        name: material.name,
        kind: material.kind,
      });
      return reply.code(201).send(material);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/materials/:id",
    async (request, reply) => {
      const material = store.getMaterial(request.params.id);
      if (!material || material.deletedAt) {
        return reply.code(404).send({ error: "材料不存在或已经删除" });
      }
      const task = store.getTask(material.taskId);
      if (!task) return reply.code(404).send({ error: "任务不存在" });

      if (material.path && task.workspacePath && isWithin(material.path, path.join(task.workspacePath, "materials"))) {
        try {
          const archiveDir = path.join(task.workspacePath, ".agentdesk", "material-history");
          await fs.mkdir(archiveDir, { recursive: true });
          const archivePath = path.join(archiveDir, `${material.id}-${safeName(material.name)}`);
          await fs.rename(material.path, archivePath);
          store.updateMaterialPath(material.id, archivePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            return reply.code(409).send({
              error: error instanceof Error ? error.message : "材料归档失败",
            });
          }
        }
      }

      store.removeMaterial(material.id);
      store.addActivity(task.id, "material.removed", {
        materialId: material.id,
        name: material.name,
      });
      const active = task.sessions.find((session) =>
        ["starting", "running", "waiting_user"].includes(session.status),
      );
      if (active && task.provider === "codex") {
        await orchestrator
          .followUp(task.id, `用户删除了需求材料 materials/${material.name}，后续工作请不要再使用该材料。`)
          .catch(() => undefined);
      }
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/materials/:id/content",
    async (request, reply) => {
      const material = store.getMaterial(request.params.id);
      if (!material) return reply.code(404).send({ error: "材料不存在" });
      const task = store.getTask(material.taskId);
      if (!task) return reply.code(404).send({ error: "任务不存在" });

      if (material.content !== undefined) {
        return { material, content: material.content, truncated: false };
      }
      if (!material.path) return { material, content: "", truncated: false };
      const allowedRoots = [config.dataDir, task.workspacePath].filter(Boolean) as string[];
      if (!allowedRoots.some((root) => isWithin(material.path!, root))) {
        return reply.code(403).send({ error: "材料路径不在任务允许的目录中" });
      }
      try {
        const stat = await fs.stat(material.path);
        if (!stat.isFile()) return reply.code(400).send({ error: "材料不是可预览文件" });
        const handle = await fs.open(material.path, "r");
        try {
          const length = Math.min(stat.size, MATERIAL_PREVIEW_LIMIT);
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, 0);
          if (buffer.includes(0)) {
            return reply.code(415).send({ error: "当前仅支持预览文本文件" });
          }
          return {
            material,
            content: buffer.toString("utf8"),
            truncated: stat.size > MATERIAL_PREVIEW_LIMIT,
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        return reply.code(404).send({
          error: error instanceof Error ? error.message : "材料文件无法读取",
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/open-path",
    async (request, reply) => {
      const parsed = openPathSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
      const task = store.getTask(request.params.id);
      if (!task) return reply.code(404).send({ error: "任务不存在" });
      const targetPath = parsed.data.target === "workspace"
        ? task.workspacePath
        : task.repositories.find((repo) => repo.id === parsed.data.repositoryId)?.worktreePath ??
          task.repositories.find((repo) => repo.id === parsed.data.repositoryId)?.sourcePath;
      if (!targetPath) return reply.code(404).send({ error: "文件夹不存在" });
      try {
        const stat = await fs.stat(targetPath);
        if (!stat.isDirectory()) return reply.code(400).send({ error: "目标不是文件夹" });
        openFolder(path.resolve(targetPath));
        return { ok: true };
      } catch (error) {
        return reply.code(404).send({
          error: error instanceof Error ? error.message : "文件夹无法打开",
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/prepare",
    async (request, reply) => {
      try {
        return await workspace.prepare(request.params.id);
      } catch (error) {
        store.updateTask(request.params.id, { status: "failed" });
        return reply.code(400).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/tasks/:id/repositories", async (request, reply) => {
    const parsed = addTaskRepositorySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const task = store.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    try {
      const registered = parsed.data.registeredRepositoryId
        ? store.getRegisteredRepository(parsed.data.registeredRepositoryId)
        : undefined;
      if (parsed.data.registeredRepositoryId && !registered) return reply.code(404).send({ error: "已登记仓库不存在" });
      const inspected = await workspace.inspectRepository(
        registered?.sourcePath ?? parsed.data.sourcePath!,
        parsed.data.baseBranch || registered?.defaultBranch,
      );
      const repository = store.addTaskRepository(task.id, {
        sourcePath: inspected.sourcePath,
        baseBranch: inspected.defaultBranch,
      });
      let prepared: ReturnType<Store["getTask"]>;
      try {
        prepared = await workspace.attachRepository(task.id, repository.id);
      } catch (error) {
        store.removeTaskRepository(repository.id);
        throw error;
      }
      const attached = prepared!.repositories.find((candidate) => candidate.id === repository.id)!;
      store.addActivity(task.id, "repository.added", {
        repositoryId: attached.id,
        sourcePath: attached.sourcePath,
        worktreePath: attached.worktreePath,
        taskBranch: attached.taskBranch,
      });
      let agentNotified = false;
      try {
        agentNotified = await orchestrator.notifyActiveSession(
          task.id,
          `任务刚刚新增了代码仓库。请将它纳入当前分析和实现范围：\n- 源仓库：${attached.sourcePath}\n- 当前任务 worktree：${attached.worktreePath ?? "工作区尚未准备，将在启动时创建"}\n- 任务分支：${attached.taskBranch ?? "工作区准备时创建"}`,
        );
      } catch {
        agentNotified = false;
      }
      return { task: store.getTask(task.id)!, repository: attached, agentNotified };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/diff", async (request, reply) => {
    try {
      return await actionEngine.diff(request.params.id);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });


  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/follow-ups",
    async (request, reply) => {
      const parsed = followUpSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message });
      }
      const task = store.getTask(request.params.id);
      if (!task?.workspacePath) {
        return reply.code(400).send({ error: "请先准备工作区" });
      }
      let materialName: string | undefined;
      if (parsed.data.persist) {
        materialName = `补充要求-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
        const target = path.join(task.workspacePath, "materials", materialName);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, `# 补充要求\n\n${parsed.data.message}\n`, "utf8");
        const material = store.addMaterial({
          taskId: task.id,
          name: materialName,
          kind: "text",
          path: target,
          content: parsed.data.message,
        });
        store.addActivity(task.id, "material.added", {
          materialId: material.id,
          name: material.name,
          kind: material.kind,
          source: "followup",
        });
      }
      const instruction = materialName
        ? `用户追加了新要求，并已保存到 materials/${materialName}。请立即阅读并据此调整当前工作：\n\n${parsed.data.message}`
        : parsed.data.message;
      try {
        const hasActiveSession = task.sessions.some((session) =>
          ["starting", "running", "waiting_user"].includes(session.status),
        );
        if (!hasActiveSession) {
          const available = actionEngine.availableActions(task.id);
          const type = available.some((action) => action.type === "request_changes") ? "request_changes"
            : available.some((action) => action.type === "start_development") ? "start_development" : undefined;
          if (type) {
            await actionEngine.execute(task.id, type === "request_changes" ? { type, feedback: instruction } : { type, instruction });
            return reply.code(202).send({ mode: "new_turn", action: type });
          }
        }
        return reply.code(202).send(await orchestrator.followUp(task.id, instruction));
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/interrupt",
    async (request, reply) => {
      try {
        await actionEngine.interrupt(request.params.id);
        return { ok: true };
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/interactions/:id/resolve",
    async (request, reply) => {
      const parsed = resolveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message });
      }
      try {
        await orchestrator.resolve(
          request.params.id,
          parsed.data as ResolveInteractionInput,
        );
        return { ok: true };
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/tasks/:id/events",
    async (request, reply) => {
      if (!store.getTask(request.params.id)) {
        return reply.code(404).send({ error: "任务不存在" });
      }
      const after = Number(request.query.after ?? request.headers["last-event-id"] ?? 0);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (event: ReturnType<Store["events"]>[number]) => {
        reply.raw.write(`id: ${event.id}\n`);
        reply.raw.write(`event: agent-event\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      store.events(request.params.id, Number.isFinite(after) ? after : 0).forEach(send);
      const unsubscribe = events.subscribe(request.params.id, send);
      const keepAlive = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000);
      request.raw.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
    },
  );
}
