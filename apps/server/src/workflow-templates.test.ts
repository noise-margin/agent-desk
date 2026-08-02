import { describe, expect, it } from "vitest";
import { workflowTemplates } from "./workflow-templates.js";
import { resolveWorkflowTemplate } from "./workflow-templates.js";

describe("workflow templates", () => {
  it("requires a confirmed requirements baseline for every non-fast workflow", () => {
    for (const template of workflowTemplates) {
      const kinds = template.nodes.map((node) => node.kind);
      expect(kinds).toContain("knowledge_review");
      expect(kinds.indexOf("knowledge_review")).toBeGreaterThan(kinds.indexOf("development"));
      expect(kinds.indexOf("knowledge_review")).toBeLessThan(kinds.indexOf("commit"));
      if (template.id === "fast") {
        expect(kinds).not.toContain("requirement_analysis");
        expect(kinds).not.toContain("human_requirement_approval");
        continue;
      }
      expect(kinds.slice(0, 2)).toEqual([
        "requirement_analysis",
        "human_requirement_approval",
      ]);
      expect(kinds.indexOf("development")).toBeGreaterThan(1);
    }
  });

  it("adds knowledge review to custom workflows that omit it", () => {
    const resolved = resolveWorkflowTemplate("fast", [
      { id: "development", kind: "development", name: "开发" },
      { id: "human-review", kind: "human_review", name: "人工审核" },
      { id: "commit", kind: "commit", name: "提交" },
    ]);
    expect(resolved.nodes.map((node) => node.kind)).toEqual([
      "development",
      "knowledge_review",
      "human_review",
      "commit",
    ]);
  });
});
