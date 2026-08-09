import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./store.js";
import { WorkspaceService } from "./workspace.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("WorkspaceService", () => {
  it("creates a task branch and worktree from a registered local repository", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-worktree-"));
    tempDirs.push(root);
    const repositoryPath = path.join(root, "order-service");
    fs.mkdirSync(repositoryPath);
    execFileSync("git", ["init", repositoryPath]);
    execFileSync("git", ["-C", repositoryPath, "config", "user.email", "agentdesk@local"]);
    execFileSync("git", ["-C", repositoryPath, "config", "user.name", "AgentDesk Test"]);
    fs.writeFileSync(path.join(repositoryPath, "README.md"), "# order\n");
    execFileSync("git", ["-C", repositoryPath, "add", "README.md"]);
    execFileSync("git", ["-C", repositoryPath, "commit", "-m", "initial"]);
    const baseBranch = execFileSync("git", ["-C", repositoryPath, "branch", "--show-current"], { encoding: "utf8" }).trim();

    const knowledgePath = path.join(root, "product-knowledge");
    fs.mkdirSync(knowledgePath);
    execFileSync("git", ["init", knowledgePath]);
    execFileSync("git", ["-C", knowledgePath, "config", "user.email", "agentdesk@local"]);
    execFileSync("git", ["-C", knowledgePath, "config", "user.name", "AgentDesk Test"]);
    fs.writeFileSync(path.join(knowledgePath, "index.md"), "# knowledge\n");
    execFileSync("git", ["-C", knowledgePath, "add", "index.md"]);
    execFileSync("git", ["-C", knowledgePath, "commit", "-m", "initial"]);
    const knowledgeBranch = execFileSync("git", ["-C", knowledgePath, "branch", "--show-current"], { encoding: "utf8" }).trim();

    const store = new Store(path.join(root, "agentdesk.db"));
    const knowledge = store.createKnowledgeRepository({ name: "Product knowledge", sourcePath: knowledgePath, defaultBranch: knowledgeBranch });
    const task = store.createTask({
      title: "worktree task",
      provider: "codex",
      repositories: [{ sourcePath: repositoryPath, baseBranch }],
      knowledgeRepositoryIds: [knowledge.id],
    });
    const service = new WorkspaceService(store, path.join(root, "workspaces"));
    const prepared = await service.prepare(task.id);
    const linkedRepository = prepared.repositories[0]!;

    expect(prepared.status).toBe("ready");
    expect(linkedRepository.taskBranch).toMatch(/^agentdesk\/worktree-task-/);
    expect(linkedRepository.worktreePath).toBeTruthy();
    expect(fs.existsSync(path.join(linkedRepository.worktreePath!, "README.md"))).toBe(true);
    expect(execFileSync("git", ["-C", linkedRepository.worktreePath!, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe(linkedRepository.taskBranch);
    expect(prepared.knowledgeRepositories[0]?.taskBranch).toMatch(/^agentdesk\/knowledge-worktree-task-/);
    expect(fs.existsSync(path.join(prepared.knowledgeRepositories[0]!.worktreePath!, "index.md"))).toBe(true);

    const runtimeRepositoryPath = path.join(root, "payment-service");
    fs.mkdirSync(runtimeRepositoryPath);
    execFileSync("git", ["init", runtimeRepositoryPath]);
    execFileSync("git", ["-C", runtimeRepositoryPath, "config", "user.email", "agentdesk@local"]);
    execFileSync("git", ["-C", runtimeRepositoryPath, "config", "user.name", "AgentDesk Test"]);
    fs.writeFileSync(path.join(runtimeRepositoryPath, "payment.txt"), "payment\n");
    execFileSync("git", ["-C", runtimeRepositoryPath, "add", "payment.txt"]);
    execFileSync("git", ["-C", runtimeRepositoryPath, "commit", "-m", "initial"]);
    const runtimeBaseBranch = execFileSync("git", ["-C", runtimeRepositoryPath, "branch", "--show-current"], { encoding: "utf8" }).trim();
    const runtimeRepository = store.addTaskRepository(task.id, { sourcePath: runtimeRepositoryPath, baseBranch: runtimeBaseBranch });
    const attached = await service.attachRepository(task.id, runtimeRepository.id);
    const runtimeWorktree = attached.repositories.find((repository) => repository.id === runtimeRepository.id)!;
    expect(runtimeWorktree.worktreePath).toBeTruthy();
    expect(fs.existsSync(path.join(runtimeWorktree.worktreePath!, "payment.txt"))).toBe(true);
    expect(execFileSync("git", ["-C", runtimeWorktree.worktreePath!, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe(runtimeWorktree.taskBranch);
    store.close();
  });
});
