import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./store.js";
import { KnowledgeRetrievalService } from "./knowledge-retrieval.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("KnowledgeRetrievalService", () => {
  it("searches only task-associated knowledge repositories and returns traceable snippets", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-knowledge-"));
    tempDirs.push(directory);
    const knowledgePath = path.join(directory, "knowledge");
    fs.mkdirSync(path.join(knowledgePath, "wiki"), { recursive: true });
    fs.writeFileSync(path.join(knowledgePath, "wiki", "order.md"), "# 订单关闭\n\n订单关闭后不得恢复，应重新创建订单。\n\n## 关闭审计\n\n订单关闭必须保留审计记录。\n", "utf8");
    fs.writeFileSync(path.join(knowledgePath, "wiki", "unrelated.md"), "# 登录\n\n登录密码规则。\n", "utf8");

    const store = new Store(path.join(directory, "test.db"));
    const repository = store.createKnowledgeRepository({ name: "产品知识", sourcePath: knowledgePath, defaultBranch: "main" });
    const task = store.createTask({
      title: "支持订单关闭后的处理",
      provider: "codex",
      repositories: [],
      knowledgeRepositoryIds: [repository.id],
    });

    const result = await new KnowledgeRetrievalService().collect(task);
    expect(result.candidates[0]).toMatchObject({
      repositoryName: "产品知识",
      path: "wiki/order.md",
      anchor: "订单关闭",
    });
    expect(result.candidates[0]?.excerpt).toContain("不得恢复");
    expect(result.candidates.map((candidate) => candidate.anchor)).toContain("关闭审计");
    expect(result.candidates.some((candidate) => candidate.path === "wiki/unrelated.md")).toBe(false);
    store.close();
  });
});
