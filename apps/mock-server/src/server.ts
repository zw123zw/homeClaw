import Fastify from "fastify";
import cors from "@fastify/cors";
import { entityRoutes } from "./routes/entities.ts";
import { sceneRoutes } from "./routes/scenes.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { auditRoutes } from "./routes/audit.ts";
import { chatRoutes } from "./chat.ts";
import { createStore, type Store } from "./store.ts";
import { HOME_ID, nowSeconds as NOW } from "@homeclaw/contracts";
import type { Health } from "@homeclaw/contracts";

declare module "fastify" {
  interface FastifyInstance {
    store: Store;
  }
}

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  app.decorate("store", createStore());

  await app.register(cors, { origin: true });

  app.get("/v1/health", async (): Promise<Health> => ({
    ok: true,
    version: "mock-0.1.0",
    ts: NOW(),
    adapter: { status: "ok", detail: "MockAdapter / 12 entities" },
    llm: { status: "ok", detail: "mock streaming (30ms chunks)" },
    gateway: { status: "ok", detail: "mock gateway (in-process)" },
    db: { status: "disabled", detail: "mock 内存存储" },
  }));

  app.get("/v1/home", async () => ({ home_id: HOME_ID, name: "演示家庭" }));

  await app.register(entityRoutes);
  await app.register(sceneRoutes);
  await app.register(sessionRoutes);
  await app.register(auditRoutes);
  await app.register(chatRoutes);

  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    reply.code(500).send({ code: "INTERNAL", message: err instanceof Error ? err.message : "internal error", retryable: false });
  });

  return app;
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("src/server.ts");
if (isMain) {
  const port = Number(process.env.PORT ?? 4010);
  const host = process.env.HOST ?? "127.0.0.1";
  buildServer()
    .then((app) => app.listen({ port, host }))
    .then((addr) => console.log(`[mock-server] listening on ${addr}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

