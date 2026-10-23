import type { FastifyInstance } from "fastify";
import { CreateSessionRequest, MessagePageQuery } from "@homeclaw/contracts";
import { appendMessage, ensureSession, newId } from "../store.ts";
import { HOME_ID, nowSeconds as NOW } from "@homeclaw/contracts";

export async function sessionRoutes(app: FastifyInstance) {
  const { store } = app;

  app.get("/v1/sessions", async () =>
    [...store.sessions.values()].sort((a, b) => b.updated_at - a.updated_at),
  );

  app.post("/v1/sessions", async (req, reply) => {
    const parsed = CreateSessionRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "请求体不合法", retryable: false });
    }
    const id = newId("s");
    const session = ensureSession(store, id, parsed.data.title ?? "新会话");
    return reply.code(201).send(session);
  });

  /** 分页：before 用于历史回溯，after 用于断线补齐（§5.1 约定） */
  app.get("/v1/sessions/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = MessagePageQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "查询参数不合法", retryable: false });
    }
    if (!store.sessions.has(id)) {
      return reply.code(404).send({ code: "NOT_FOUND", message: `会话不存在: ${id}`, retryable: false });
    }

    const { after, before, limit } = parsed.data;
    let list = store.messages.get(id) ?? [];
    if (typeof after === "number") list = list.filter((m) => m.seq > after);
    if (typeof before === "number") list = list.filter((m) => m.seq < before);
    return list.slice(0, limit);
  });

  /** 断线补齐便捷入口：GET /v1/messages?session_id=&after= */
  app.get("/v1/messages", async (req, reply) => {
    const q = req.query as { session_id?: string; after?: string };
    if (!q.session_id) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "缺少 session_id", retryable: false });
    }
    const after = Number(q.after ?? 0);
    const list = (store.messages.get(q.session_id) ?? []).filter((m) => m.seq > after);
    return list;
  });

  app.get("/v1/health/mock", async () => ({ ok: true, ts: NOW(), home_id: HOME_ID }));

  app.post("/_mock/reset", async () => {
    store.messages.clear();
    store.sessions.clear();
    store.audit.length = 0;
    return { ok: true };
  });

  app.get("/v1/_debug/last-seq", async (req) => {
    const q = req.query as { session_id: string };
    const list = store.messages.get(q.session_id) ?? [];
    return { session_id: q.session_id, last_seq: list.length === 0 ? 0 : list[list.length - 1]!.seq };
  });

  void appendMessage;
}
