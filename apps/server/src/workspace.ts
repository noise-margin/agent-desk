import fs from "node:fs/promises";
import path from "node:path";
import type { Task } from "@agentdesk/protocol";
import { config } from "./config.js";
import { execFileAsync } from "./lib/process.js";
import { Store } from "./store.js";

function slug(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return (normalized || "task").slice(0, 36);
}

function repoName(repoPath: string) {
  return path.basename(repoPath).replace(/\.git$/i, "") || "repository";
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

export class WorkspaceService {
  constructor(
    private readonly store: Store,
    private readonly workspacesDir = config.workspacesDir,
  ) {}

  async inspectRepository(sourcePath: string, requestedBranch?: string) {
    const candidate = path.resolve(sourcePath.trim());
    await fs.access(candidate);
    const { stdout: rootOutput } = await execFileAsync(
      "git",
      ["-C", candidate, "rev-parse", "--show-toplevel"],
    );
    const sourceRoot = path.resolve(rootOutput.trim());
    const { stdout: branchOutput } = await execFileAsync(
      "git",
      ["-C", sourceRoot, "branch", "--show-current"],
    );
    const defaultBranch = requestedBranch?.trim() || branchOutput.trim() || "HEAD";
    await execFileAsync("git", ["-C", sourceRoot, "rev-parse", "--verify", `${defaultBranch}^{commit}`]);
    return { sourcePath: sourceRoot, defaultBranch, suggestedName: repoName(sourceRoot) };
  }

  async prepare(taskId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    if (task.workspacePath) return task;

    this.store.updateTask(taskId, { status: "preparing" });
    const shortId = task.id.slice(0, 8);
    const taskSlug = `${slug(task.title)}-${shortId}`;
    const workspacePath = path.resolve(this.workspacesDir, taskSlug);
    const materialsPath = path.join(workspacePath, "materials");
    const reposPath = path.join(workspacePath, "repos");
    const knowledgePath = path.join(workspacePath, "knowledge");
    const artifactsPath = path.join(workspacePath, "artifacts");
    const logsPath = path.join(workspacePath, "logs");

    await fs.mkdir(materialsPath, { recursive: true });
    await fs.mkdir(reposPath, { recursive: true });
    await fs.mkdir(knowledgePath, { recursive: true });
    await fs.mkdir(artifactsPath, { recursive: true });
    await fs.mkdir(logsPath, { recursive: true });

    for (const material of task.materials) {
      if (material.kind === "text" && material.content) {
        await fs.writeFile(path.join(materialsPath, material.name), material.content, "utf8");
      } else if (material.kind === "file" && material.path) {
        await fs.copyFile(material.path, path.join(materialsPath, material.name));
      }
    }

    const usedNames = new Set<string>();
    for (const repo of task.repositories) {
      await this.prepareRepository(task, repo, reposPath, usedNames);
    }
    const usedKnowledgeNames = new Set<string>();
    for (const repository of task.knowledgeRepositories) {
      await this.prepareKnowledgeRepository(task, repository, knowledgePath, usedKnowledgeNames);
    }

    this.store.updateTask(taskId, { workspacePath, status: "ready" });
    const prepared = this.store.getTask(taskId)!;
    await fs.writeFile(path.join(workspacePath, "task.yaml"), this.taskYaml(prepared), "utf8");
    await fs.writeFile(
      path.join(workspacePath, "AGENTS.md"),
      this.agentInstructions(prepared),
      "utf8",
    );
    return prepared;
  }

  async attachRepository(taskId: string, repositoryId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    const repository = task.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository) throw new Error("任务仓库不存在");
    if (!task.workspacePath) return task;

    const reposPath = path.join(task.workspacePath, "repos");
    await fs.mkdir(reposPath, { recursive: true });
    const usedNames = new Set(task.repositories
      .filter((candidate) => candidate.id !== repositoryId && candidate.worktreePath)
      .map((candidate) => path.basename(candidate.worktreePath!)));
    await this.prepareRepository(task, repository, reposPath, usedNames);
    const prepared = this.store.getTask(taskId)!;
    await fs.writeFile(path.join(task.workspacePath, "task.yaml"), this.taskYaml(prepared), "utf8");
    await fs.writeFile(path.join(task.workspacePath, "AGENTS.md"), this.agentInstructions(prepared), "utf8");
    return prepared;
  }

  async attachKnowledgeRepository(taskId: string, taskKnowledgeRepositoryId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    const repository = task.knowledgeRepositories.find((item) => item.id === taskKnowledgeRepositoryId);
    if (!repository) throw new Error("任务知识库不存在");
    if (!task.workspacePath) return task;
    const knowledgePath = path.join(task.workspacePath, "knowledge");
    await fs.mkdir(knowledgePath, { recursive: true });
    const usedNames = new Set(task.knowledgeRepositories.filter((item) => item.id !== repository.id && item.worktreePath).map((item) => path.basename(item.worktreePath!)));
    await this.prepareKnowledgeRepository(task, repository, knowledgePath, usedNames);
    const prepared = this.store.getTask(taskId)!;
    await fs.writeFile(path.join(task.workspacePath, "task.yaml"), this.taskYaml(prepared), "utf8");
    await fs.writeFile(path.join(task.workspacePath, "AGENTS.md"), this.agentInstructions(prepared), "utf8");
    return prepared;
  }

  private async prepareRepository(
    task: Task,
    repository: Task["repositories"][number],
    reposPath: string,
    usedNames: Set<string>,
  ) {
    const inspected = await this.inspectRepository(repository.sourcePath, repository.baseBranch);
    const sourceRoot = inspected.sourcePath;
    let name = repoName(sourceRoot);
    let suffix = 2;
    while (usedNames.has(name)) name = `${repoName(sourceRoot)}-${suffix++}`;
    usedNames.add(name);

    const baseBranch = inspected.defaultBranch;
    const { stdout: commitOutput } = await execFileAsync("git", ["-C", sourceRoot, "rev-parse", baseBranch]);
    const baseCommit = commitOutput.trim();
    const taskSlug = `${slug(task.title)}-${task.id.slice(0, 8)}`;
    const taskBranch = `agentdesk/${taskSlug}`;
    const worktreePath = path.join(reposPath, name);

    try {
      await fs.access(worktreePath);
    } catch {
      const { stdout: branchExists } = await execFileAsync("git", ["-C", sourceRoot, "branch", "--list", taskBranch]);
      await execFileAsync(
        "git",
        branchExists.trim()
          ? ["-C", sourceRoot, "worktree", "add", worktreePath, taskBranch]
          : ["-C", sourceRoot, "worktree", "add", "-b", taskBranch, worktreePath, baseBranch],
        { timeout: 60_000 },
      );
    }

    this.store.updateRepository(repository.id, { baseBranch, worktreePath, taskBranch, baseCommit });
  }

  private async prepareKnowledgeRepository(
    task: Task,
    repository: Task["knowledgeRepositories"][number],
    knowledgePath: string,
    usedNames: Set<string>,
  ) {
    const inspected = await this.inspectRepository(repository.sourcePath, repository.defaultBranch);
    let name = repoName(inspected.sourcePath);
    let suffix = 2;
    while (usedNames.has(name)) name = `${repoName(inspected.sourcePath)}-${suffix++}`;
    usedNames.add(name);
    const { stdout } = await execFileAsync("git", ["-C", inspected.sourcePath, "rev-parse", inspected.defaultBranch]);
    const baseCommit = stdout.trim();
    const taskBranch = `agentdesk/knowledge-${slug(task.title)}-${task.id.slice(0, 8)}`;
    const worktreePath = path.join(knowledgePath, name);
    try {
      await fs.access(worktreePath);
    } catch {
      const exists = (await execFileAsync("git", ["-C", inspected.sourcePath, "branch", "--list", taskBranch])).stdout.trim();
      await execFileAsync("git", exists
        ? ["-C", inspected.sourcePath, "worktree", "add", worktreePath, taskBranch]
        : ["-C", inspected.sourcePath, "worktree", "add", "-b", taskBranch, worktreePath, inspected.defaultBranch],
      { timeout: 60_000 });
    }
    this.store.updateTaskKnowledgeRepository(repository.id, { worktreePath, taskBranch, baseCommit });
  }

  private taskYaml(task: Task) {
    return [
      `id: ${yamlString(task.id)}`,
      `title: ${yamlString(task.title)}`,
      `provider: ${task.provider}`,
      `status: ${task.status}`,
      "repositories:",
      ...task.repositories.flatMap((repo) => [
        `  - source: ${yamlString(repo.sourcePath)}`,
        `    worktree: ${yamlString(repo.worktreePath ?? "")}`,
        `    baseBranch: ${yamlString(repo.baseBranch ?? "")}`,
        `    taskBranch: ${yamlString(repo.taskBranch ?? "")}`,
        `    baseCommit: ${yamlString(repo.baseCommit ?? "")}`,
      ]),
      "knowledgeRepositories:",
      ...task.knowledgeRepositories.flatMap((repo) => [
        `  - name: ${yamlString(repo.name)}`,
        `    source: ${yamlString(repo.sourcePath)}`,
        `    worktree: ${yamlString(repo.worktreePath ?? "")}`,
        `    defaultBranch: ${yamlString(repo.defaultBranch)}`,
        `    taskBranch: ${yamlString(repo.taskBranch ?? "")}`,
      ]),
      "",
    ].join("\n");
  }

  private agentInstructions(task: Task) {
    const repoList =
      task.repositories.length > 0
        ? task.repositories
            .map((repo) => `- ${repo.worktreePath ?? repo.sourcePath}`)
            .join("\n")
        : "- 当前任务工作区";
    return `# AgentDesk 任务约束

任务：${task.title}

## 工作目录

${repoList}

## 行为要求

- 首先阅读 materials 目录中的需求材料，再分析代码。
- 不要修改任务工作区以外的文件。
- 需求条件缺失且会改变实现方案时，必须使用用户提问工具确认。
- 高风险、破坏性或超出工作区的操作必须请求用户批准。
- 修改后运行与改动相关的测试。
- 最终总结修改文件、测试结果、遗留风险和需要人工确认的事项。
`;
  }
}
