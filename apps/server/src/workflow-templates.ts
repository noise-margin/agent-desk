import type { WorkflowNodeDefinition, WorkflowTemplate } from "@agentdesk/protocol";

const development: WorkflowNodeDefinition = {
  id: "development",
  kind: "development",
  name: "开发实现",
};

const knowledgeReview: WorkflowNodeDefinition = {
  id: "knowledge-review",
  kind: "knowledge_review",
  name: "需求知识审查",
};

const requirementDefinition = (): WorkflowNodeDefinition[] => [
  { id: "requirement-analysis", kind: "requirement_analysis", name: "需求分析" },
  { id: "requirement-approval", kind: "human_requirement_approval", name: "人工确认需求" },
];

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: "requirements",
    name: "需求驱动开发",
    description: "先确认需求规格，再开发、审查并由独立 Agent 维护 LLM Wiki，人工确认后提交。",
    nodes: [
      ...requirementDefinition(),
      development,
      { id: "agent-review", kind: "agent_review", name: "Agent Code Review" },
      knowledgeReview,
      { id: "human-review", kind: "human_review", name: "人工确认" },
      { id: "commit", kind: "commit", name: "本地提交" },
    ],
  },
  {
    id: "fast",
    name: "快速开发",
    description: "开发完成后执行独立需求知识审查，再创建本地提交。",
    nodes: [development, knowledgeReview, { id: "commit", kind: "commit", name: "本地提交" }],
  },
  {
    id: "agent-review",
    name: "Agent 代码审查",
    description: "先确认需求规格，再开发、独立代码审查和知识审查，不通过时打回原开发会话。",
    nodes: [
      ...requirementDefinition(),
      development,
      { id: "agent-review", kind: "agent_review", name: "Agent Code Review" },
      knowledgeReview,
      { id: "human-review", kind: "human_review", name: "人工确认" },
      { id: "commit", kind: "commit", name: "本地提交" },
    ],
  },
  {
    id: "acceptance",
    name: "目标验收",
    description: "先确认需求规格，再开发、独立审查、目标验收和知识审查，最后展示证据供人工确认。",
    nodes: [
      ...requirementDefinition(),
      development,
      { id: "agent-review", kind: "agent_review", name: "Agent Code Review" },
      { id: "agent-acceptance", kind: "agent_acceptance", name: "Agent 目标验收" },
      knowledgeReview,
      { id: "human-review", kind: "human_review", name: "人工验收" },
      { id: "commit", kind: "commit", name: "本地提交" },
    ],
  },
];

export function resolveWorkflowTemplate(
  templateId: string,
  customNodes?: WorkflowNodeDefinition[],
) {
  const template = workflowTemplates.find((item) => item.id === templateId) ?? workflowTemplates[0]!;
  const requestedNodes = (customNodes?.length ? customNodes : template.nodes).map((node) => ({ ...node }));
  if (!requestedNodes.some((node) => node.kind === "knowledge_review")) {
    const insertionIndex = requestedNodes.findIndex((node) => node.kind === "human_review" || node.kind === "commit");
    requestedNodes.splice(insertionIndex >= 0 ? insertionIndex : requestedNodes.length, 0, { ...knowledgeReview });
  }
  return {
    ...template,
    id: customNodes?.length ? "custom" : template.id,
    name: customNodes?.length ? "自定义工作流" : template.name,
    nodes: requestedNodes,
  };
}
