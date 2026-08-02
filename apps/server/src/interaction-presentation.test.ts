import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agentdesk/protocol";
import {
  buildInteractionPresentation,
  buildInteractionResolutionPresentation,
} from "./interaction-presentation.js";

describe("interaction presentation", () => {
  it("joins a Codex approval with its file-change event", () => {
    const events: AgentEvent[] = [{
      id: 1,
      taskId: "task",
      sessionId: "session",
      type: "tool.started",
      createdAt: new Date().toISOString(),
      payload: {
        item: {
          id: "exec-1",
          type: "fileChange",
          changes: [
            { path: "E:/workspace/package.json", kind: { type: "add" } },
            { path: "E:/workspace/src/app.ts", kind: { type: "update" } },
          ],
        },
      },
    }];
    const result = buildInteractionPresentation({
      type: "file_approval",
      method: "item/fileChange/requestApproval",
      payload: { itemId: "exec-1", reason: "command failed; retry without sandbox?" },
      events,
      workspacePath: "E:/workspace",
    });
    expect(result).toMatchObject({
      category: "file_change",
      title: "允许 Agent 修改 2 个文件？",
      risk: "medium",
    });
    expect(result.description).toContain("沙箱权限限制");
    expect(result.details).toEqual(expect.arrayContaining([
      { label: "目标文件", value: "package.json", kind: "file" },
      { label: "目标文件", value: expect.stringMatching(/src[\\/]app\.ts/), kind: "file" },
    ]));
  });

  it("normalizes a Qoder command approval without provider-specific UI logic", () => {
    const result = buildInteractionPresentation({
      type: "command_approval",
      method: "Bash",
      payload: {
        toolName: "Bash",
        title: "运行测试",
        description: "验证计算器",
        input: { command: "pnpm test", cwd: "E:/workspace" },
      },
      workspacePath: "E:/workspace",
    });
    expect(result).toMatchObject({
      category: "command",
      title: "允许 Agent 运行“Bash”？",
      description: "验证计算器",
      risk: "medium",
    });
    expect(result.details).toContainEqual({ label: "执行命令", value: "pnpm test", kind: "command" });
  });

  it("records the user's answers in a provider-neutral timeline presentation", () => {
    const result = buildInteractionResolutionPresentation({
      type: "user_question",
      payload: {
        questions: [
          { id: "scope", question: "计算器需要支持哪些运算？" },
          { id: "style", question: "界面风格有什么要求？" },
        ],
      },
      response: {
        action: "accept",
        answers: {
          scope: ["只需要加法和减法"],
          style: ["保持简洁"],
        },
      },
    });
    expect(result).toMatchObject({
      category: "answer",
      outcome: "answered",
      title: "你已回答 Agent",
    });
    expect(result.details).toEqual([
      { label: "计算器需要支持哪些运算？", value: "只需要加法和减法" },
      { label: "界面风格有什么要求？", value: "保持简洁" },
    ]);
  });

  it("records permission rejection without depending on an agent provider", () => {
    expect(buildInteractionResolutionPresentation({
      type: "command_approval",
      payload: { command: "pnpm test" },
      response: { action: "decline" },
    })).toMatchObject({
      category: "permission",
      outcome: "declined",
      title: "你已拒绝本次操作",
    });
  });
});
