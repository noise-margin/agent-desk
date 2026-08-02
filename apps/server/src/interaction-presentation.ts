import type {
  AgentEvent,
  InteractionPresentation,
  InteractionResolutionPresentation,
  InteractionType,
  ResolveInteractionInput,
} from "@agentdesk/protocol";
import path from "node:path";

type PresentationInput = {
  type: InteractionType;
  method: string;
  payload: Record<string, unknown>;
  events?: AgentEvent[];
  workspacePath?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function displayPath(value: string, workspacePath?: string) {
  if (!workspacePath) return value;
  const relative = path.relative(workspacePath, value);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : value;
}

function explainReason(reason?: string) {
  if (!reason) return undefined;
  const normalized = reason.toLowerCase();
  if (normalized.includes("retry without sandbox") || normalized.includes("sandbox")) {
    return "上一步受到沙箱权限限制，Agent 希望在更宽松的权限下重试。";
  }
  return reason;
}

function relatedItem(payload: Record<string, unknown>, events: AgentEvent[]) {
  const itemId = text(payload.itemId ?? payload.item_id);
  if (!itemId) return undefined;
  return [...events].reverse().map((event) => record(event.payload.item)).find((item) => String(item.id ?? "") === itemId);
}

function compactJson(value: unknown) {
  try {
    const json = JSON.stringify(value);
    return json.length > 240 ? `${json.slice(0, 237)}…` : json;
  } catch {
    return String(value);
  }
}

export function buildInteractionPresentation(input: PresentationInput): InteractionPresentation {
  const payload = input.payload;
  const item = relatedItem(payload, input.events ?? []);
  const toolInput = record(payload.input ?? payload.toolInput ?? payload.arguments);
  const reason = explainReason(text(payload.reason ?? payload.description));

  if (input.type === "user_question") {
    return {
      category: "question",
      title: "Agent 需要补充信息",
      description: reason ?? "回答后 Agent 会继续当前工作。",
      risk: "low",
      details: [],
    };
  }

  if (input.type === "file_approval" || String(item?.type ?? "").toLowerCase().includes("filechange")) {
    const changes = Array.isArray(item?.changes) ? item.changes.map(record) : [];
    const files = changes.map((change) => text(change.path)).filter((value): value is string => Boolean(value));
    const additions = changes.filter((change) => text(record(change.kind).type) === "add").length;
    const deletions = changes.filter((change) => text(record(change.kind).type) === "delete").length;
    const scopes = files.map((file) => displayPath(file, input.workspacePath));
    return {
      category: "file_change",
      title: files.length ? `允许 Agent 修改 ${files.length} 个文件？` : "允许 Agent 修改工作区文件？",
      description: reason ?? "Agent 需要写入工作区才能继续完成当前开发任务。",
      risk: files.some((file) => input.workspacePath ? path.relative(input.workspacePath, file).startsWith("..") : false) ? "high" : "medium",
      details: [
        ...scopes.slice(0, 12).map((file) => ({ label: "目标文件", value: file, kind: "file" as const })),
        ...(changes.length ? [{ label: "变更概况", value: `${additions ? `新增 ${additions} 个` : ""}${additions && deletions ? "，" : ""}${deletions ? `删除 ${deletions} 个` : ""}${!additions && !deletions ? `修改 ${changes.length} 个` : ""}`, kind: "text" as const }] : []),
        ...(text(payload.grantRoot) ? [{ label: "授权范围", value: displayPath(text(payload.grantRoot)!, input.workspacePath), kind: "scope" as const }] : []),
      ],
    };
  }

  const explicitToolName = text(payload.toolName ?? payload.tool_name);
  const toolName = explicitToolName ?? text(payload.title ?? input.method) ?? "外部工具";
  const command = text(item?.command ?? item?.cmd ?? toolInput.command ?? toolInput.cmd ?? payload.command);
  const cwd = text(item?.cwd ?? toolInput.cwd ?? payload.cwd);
  const file = text(toolInput.file_path ?? toolInput.filePath ?? toolInput.path ?? payload.path);
  if (input.type === "command_approval" || command || /bash|shell|command|exec/i.test(toolName)) {
    return {
      category: "command",
      title: explicitToolName ? `允许 Agent 运行“${toolName}”？` : "允许 Agent 运行命令？",
      description: reason ?? text(payload.description) ?? "该命令将在任务工作区中执行。",
      risk: /rm\s|del\s|remove|reset\s+--hard|sudo|admin/i.test(command ?? "") ? "high" : "medium",
      details: [
        ...(command ? [{ label: "执行命令", value: command, kind: "command" as const }] : []),
        ...(cwd ? [{ label: "运行目录", value: displayPath(cwd, input.workspacePath), kind: "scope" as const }] : []),
        ...(file ? [{ label: "目标文件", value: displayPath(file, input.workspacePath), kind: "file" as const }] : []),
      ],
    };
  }

  const permission = text(payload.permission ?? payload.scope ?? payload.permissions);
  return {
    category: "permission",
    title: text(payload.title) ?? `允许 Agent 使用“${toolName}”？`,
    description: reason ?? text(payload.description) ?? "Agent 请求当前步骤所需的额外权限。",
    risk: "medium",
    details: [
      ...(permission ? [{ label: "权限范围", value: permission, kind: "scope" as const }] : []),
      ...(!permission && Object.keys(toolInput).length ? [{ label: "操作摘要", value: compactJson(toolInput), kind: "text" as const }] : []),
    ],
  };
}

export function buildInteractionResolutionPresentation(input: {
  type: InteractionType;
  payload: Record<string, unknown>;
  response: ResolveInteractionInput;
}): InteractionResolutionPresentation {
  const { response } = input;
  const accepted = response.action === "accept";
  const cancelled = response.action === "cancel";
  const isQuestion = input.type === "user_question" || input.type === "elicitation";

  if (isQuestion) {
    const questions = Array.isArray(input.payload.questions)
      ? input.payload.questions.map(record)
      : [{ id: "answer", question: input.payload.question }];
    const questionLabels = new Map(
      questions.map((question) => [String(question.id ?? "answer"), text(question.question ?? question.header) ?? "你的回答"]),
    );
    const details = Object.entries(response.answers ?? {}).map(([questionId, answers]) => ({
      label: questionLabels.get(questionId) ?? "你的回答",
      value: answers.join("；"),
    }));
    if (!details.length && typeof response.content === "string" && response.content.trim()) {
      details.push({ label: "你的回答", value: response.content.trim() });
    }
    return {
      category: "answer",
      outcome: accepted ? "answered" : cancelled ? "cancelled" : "declined",
      title: accepted ? "你已回答 Agent" : cancelled ? "你取消了回答" : "你拒绝了回答",
      description: accepted ? "回答已发送，Agent 将结合这些信息继续工作。" : "Agent 已收到本次处理结果。",
      details,
    };
  }

  return {
    category: "permission",
    outcome: accepted ? "approved" : cancelled ? "cancelled" : "declined",
    title: accepted ? "你已允许本次操作" : cancelled ? "你取消了权限处理" : "你已拒绝本次操作",
    description: accepted
      ? "授权结果已发送给 Agent，仅作用于本次权限请求。"
      : "拒绝结果已发送给 Agent，Agent 可以调整方案或重新提出请求。",
    details: [],
  };
}
