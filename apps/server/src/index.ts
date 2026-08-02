import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { EventBus } from "./event-bus.js";
import { Orchestrator } from "./orchestrator.js";
import { registerRoutes } from "./routes.js";
import { Store } from "./store.js";
import { WorkspaceService } from "./workspace.js";
import { WorkflowEngine } from "./workflow-engine.js";

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.workspacesDir, { recursive: true });

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  bodyLimit: 10 * 1024 * 1024,
});

await app.register(cors, {
  origin: [config.webOrigin],
});
await app.register(multipart, {
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

const store = new Store();
const events = new EventBus(store);
const workspace = new WorkspaceService(store);
const orchestrator = new Orchestrator(store, events);
const workflowEngine = new WorkflowEngine(store, events, orchestrator);

await registerRoutes(app, { store, events, workspace, orchestrator, workflowEngine });

const webDist = path.resolve(config.rootDir, "apps/web/dist");
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: false,
  });
  app.get<{ Params: { "*": string } }>("/assets/*", (request, reply) =>
    reply.sendFile(`assets/${request.params["*"]}`),
  );
  app.get("/*", (_request, reply) => reply.sendFile("index.html"));
}

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const statusCode =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
  const message = error instanceof Error ? error.message : String(error);
  void reply.code(statusCode).send({ error: message });
});

await app.listen({ host: config.host, port: config.port });

try {
  const recoveredInterruptedWorkflows = await workflowEngine.recoverInterruptedWorkflows();
  const recoveredQualityReworks = await workflowEngine.recoverAutomaticQualityReworks();
  if (recoveredInterruptedWorkflows > 0 || recoveredQualityReworks > 0) {
    app.log.info(
      { recoveredInterruptedWorkflows, recoveredQualityReworks },
      "recovered interrupted workflows",
    );
  }
} catch (error) {
  app.log.error(error, "failed to recover workflows after startup");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => {
      store.close();
      process.exit(0);
    });
  });
}
