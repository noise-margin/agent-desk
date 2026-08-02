const Database = require("../apps/server/node_modules/better-sqlite3");

const taskId = process.argv[2];
const includeSystem = process.argv.includes("--all");
if (!taskId) {
  throw new Error("Usage: node scripts/inspect-events.cjs <task-id>");
}

const database = new Database(".agentdesk/agentdesk.db", { readonly: true });
const events = database
  .prepare(
    `SELECT id, type, payload FROM events
     WHERE task_id = ? ${includeSystem ? "" : "AND type <> 'system.notice'"}
     ORDER BY id DESC LIMIT 30`,
  )
  .all(taskId)
  .reverse()
  .map((event) => {
    const payload = JSON.parse(event.payload);
    if (event.type === "system.notice" && typeof payload.message === "string") {
      payload.message = payload.message.slice(0, 2_000);
    }
    return { ...event, payload };
  });

console.log(JSON.stringify(events, null, 2));
