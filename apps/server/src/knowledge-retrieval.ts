import fs from "node:fs/promises";
import path from "node:path";
import type { Task } from "@agentdesk/protocol";

export interface KnowledgeCandidate {
  knowledgeRepositoryId: string;
  repositoryName: string;
  path: string;
  absolutePath: string;
  anchor?: string;
  excerpt: string;
  score: number;
  matchedKeywords: string[];
}

function keywords(text: string) {
  const normalized = text.toLocaleLowerCase();
  const latin = normalized.match(/[\p{Letter}\p{Number}_-]{2,32}/gu) ?? [];
  const chineseRuns = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const chinese = chineseRuns.flatMap((run) => {
    const result: string[] = [];
    for (const size of [4, 3, 2]) {
      for (let index = 0; index <= run.length - size; index += 1) result.push(run.slice(index, index + size));
    }
    return result;
  });
  return [...new Set([...latin, ...chinese])].filter((term) => !/^(当前|需求|任务|实现|进行|相关|可以|需要)$/.test(term)).slice(0, 80);
}

async function markdownFiles(root: string) {
  const result: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && /\.(md|mdx|txt)$/i.test(entry.name)) result.push(target);
      if (result.length >= 2_000) return;
    }
  };
  await visit(root);
  return result;
}

function candidatesFromContent(content: string, file: string, terms: string[]) {
  const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)];
  const sections = headings.length
    ? headings.map((heading, index) => ({
        anchor: heading[1]?.trim(),
        content: content.slice(heading.index ?? 0, headings[index + 1]?.index ?? content.length),
      }))
    : [{ anchor: undefined, content }];
  const fileName = path.basename(file).toLocaleLowerCase();
  return sections.flatMap((section) => {
    const lower = section.content.toLocaleLowerCase();
    const matched = terms.filter((term) => lower.includes(term));
    if (!matched.length) return [];
    const first = Math.min(...matched.map((term) => lower.indexOf(term)).filter((index) => index >= 0));
    const start = Math.max(0, first - 250);
    const excerpt = section.content.slice(start, Math.min(section.content.length, first + 900)).trim();
    const headingBonus = matched.filter((term) => fileName.includes(term) || section.anchor?.toLocaleLowerCase().includes(term)).length * 4;
    return [{ excerpt, anchor: section.anchor, matchedKeywords: matched.slice(0, 12), score: matched.reduce((sum, term) => sum + Math.min(4, term.length), 0) + headingBonus }];
  });
}

export class KnowledgeRetrievalService {
  async collect(task: Task, extraQuery = ""): Promise<{ query: string; keywords: string[]; candidates: KnowledgeCandidate[] }> {
    const materialText = task.materials.map((material) => material.content ?? "").join("\n");
    const artifactText = task.artifacts.map((artifact) => `${artifact.title}\n${artifact.content ?? ""}`).join("\n");
    const query = [task.title, task.description, task.deliveryTarget, task.acceptanceCriteria, materialText, artifactText, extraQuery].filter(Boolean).join("\n").slice(0, 120_000);
    const terms = keywords(query);
    const candidates: KnowledgeCandidate[] = [];
    for (const repository of task.knowledgeRepositories) {
      const root = repository.worktreePath ?? repository.sourcePath;
      for (const file of await markdownFiles(root)) {
        const content = await fs.readFile(file, "utf8").catch(() => "");
        for (const match of candidatesFromContent(content, file, terms)) {
          candidates.push({
            knowledgeRepositoryId: repository.knowledgeRepositoryId,
            repositoryName: repository.name,
            path: path.relative(root, file).replaceAll("\\", "/"), absolutePath: file,
            ...match,
          });
        }
      }
    }
    candidates.sort((left, right) => right.score - left.score);
    return { query, keywords: terms, candidates: candidates.slice(0, 40) };
  }
}
