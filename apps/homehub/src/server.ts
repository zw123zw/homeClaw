import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig, type HubConfig } from "./config.ts";
import { createRuntime } from "./bootstrap.ts";
import type { RuntimeOptions } from "./bootstrap.ts";
import type { HomeRuntime } from "./runtime.ts";
import { makeIds } from "./runtime.ts";
import { registerRoutes } from "./routes/index.ts";

declare module "fastify" {
  interface FastifyInstance {
    rt: HomeRuntime;
    newId: (prefix: string) => string;
  }
}

export type BuildOptions = {
  config?: HubConfig;
  /** test overrides */
  overrides?: RuntimeOptions["overrides"];
};

export async function buildServer(opts: BuildOptions = {}) {
  const config = opts.config ?? loadConfig();
  const rt = createRuntime(config, { overrides: opts.overrides });

  const app = Fastify({ logger: { level: config.logLevel } });
  app.decorate("rt", rt);
  app.decorate("newId", makeIds());

  await app.register(cors, { origin: true });

  /**
   * 空 body 的容错。
   *
   * DELETE /v1/preferences/:key、DELETE /v1/attachments/:id 这类请求本来就没有 body，
   * 而统一请求头很容易把 Content-Type: application/json 一起带上，
   * Fastify 的 json 解析器于是抛 FST_ERR_CTP_EMPTY_JSON_BODY → 400。
   * 用户看到的是"删除失败"，而实际上什么都没坏。
   */
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const raw = typeof body === "string" ? body.trim() : "";
    if (!raw) return done(null, undefined);
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(Object.assign(new Error("请求体不是合法 JSON"), { statusCode: 400, code: "BAD_JSON" }), undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    const message = err instanceof Error ? err.message : "internal error";
    reply.code(500).send({ code: "INTERNAL", message, retryable: false });
  });

  await registerRoutes(app);

  app.addHook("onClose", async () => {
    rt.shutdown();
  });

  return app;
}

/**
 * 是否作为可执行入口启动。
 *
 * 两种形态都要认：
 *  1) 开发/调试：直接 node src/server.ts；
 *  2) 打包：先由 tools/build-backend.mjs 打成单文件 .mjs，再用 HOMECLAW_STANDALONE=1 启动。
 * 只认 "src/server.ts" 会让打包产物"能加载但永不 listen"——现象是端口一直连不上，
 * 而日志里一行错误都没有。
 */
const invokedDirectly =
  process.env.HOMECLAW_STANDALONE === "1" ||
  Boolean(process.argv[1]?.replace(/\\/g, "/").endsWith("src/server.ts"));
if (invokedDirectly) {
  const config = loadConfig();
  buildServer({ config })
    .then((app) => app.listen({ port: config.port, host: config.host }))
    .then((addr) => console.log(`[homehub] listening on ${addr}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}