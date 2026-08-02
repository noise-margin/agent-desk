import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = process.env.AGENTDESK_ROOT
  ? path.resolve(process.env.AGENTDESK_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = path.resolve(rootDir, process.env.AGENTDESK_DATA_DIR ?? ".agentdesk");
const bundledCodexScript = path.join(
  rootDir,
  "apps",
  "server",
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js",
);
const useBundledCodex =
  !process.env.AGENTDESK_CODEX_COMMAND && fs.existsSync(bundledCodexScript);

export const config = {
  version: "0.1.0",
  rootDir,
  dataDir,
  databasePath: path.join(dataDir, "agentdesk.db"),
  workspacesDir: path.join(dataDir, "workspaces"),
  host: process.env.AGENTDESK_HOST ?? "127.0.0.1",
  port: Number(process.env.AGENTDESK_PORT ?? 4310),
  webOrigin: process.env.AGENTDESK_WEB_ORIGIN ?? "http://localhost:5173",
  codexCommand: process.env.AGENTDESK_CODEX_COMMAND ?? (useBundledCodex ? process.execPath : "codex"),
  codexBaseArgs: useBundledCodex ? [bundledCodexScript] : [],
  qoderCommand: process.env.AGENTDESK_QODER_COMMAND ?? "qodercli",
  qwenCodeCommand: process.env.AGENTDESK_QWEN_CODE_COMMAND ?? "qwen",
};
