import type { FastifyInstance } from "fastify";
import { EntityCommandRequest } from "@homeclaw/contracts";
import { applyService, newId, recordAudit } from "../store.ts";

export async function entityRoutes(app: FastifyInstance) {
  const { store } = app;

  app.get("/v1/entities", async (req) => {
    const q = req.query as { room?: string; type?: string };
    return [...store.entities.values()]
      .filter((e) => (q.room ? e.room === q.room : true))
      .filter((e) => (q.type ? e.type === q.type : true))
      .sort((a, b) => a.room.localeCompare(b.room) || a.name.localeCompare(b.name));
  });

  app.get("/v1/entities/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const entity = store.entities.get(id);
    if (!entity) {
      return reply.code(404).send({ code: "NOT_FOUND", message: `实体不存在: ${id}`, retryable: false });
    }
    return entity;
  });

  app.post("/v1/entities/:id/command", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = EntityCommandRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "请求体不合法", retryable: false, detail: parsed.error.issues });
    }

    const key = parsed.data.idempotency_key;
    if (key && store.idempotency.has(key)) {
      // 幂等命中不重复执行，但仍需留痕：否则审计里会出现"设备没动但也没记录"的黑洞
      const cached = store.idempotency.get(key) as { trace_id?: string } | undefined;
      recordAudit(store, {
        trace_id: cached?.trace_id ?? newId("tr"), home_id: "h_demo0001", actor: "user:u_demo",
        action: "entity.command", target: id,
        params: { service: parsed.data.service, ...parsed.data.data, idempotency_key: key },
        decision: "allow", reason: "idempotent_replay", result: "skipped", origin: "user", elapsed_ms: 0,
      });
      return store.idempotency.get(key);
    }

    const entity = store.entities.get(id);
    const traceId = newId("tr");
    const started = performance.now();

    if (!entity) {
      recordAudit(store, {
        trace_id: traceId, home_id: "h_demo0001", actor: "user:u_demo", action: "entity.command",
        target: id, params: parsed.data.data, decision: "deny", reason: "policy_whitelist",
        result: "error", origin: "user", elapsed_ms: 0,
      });
      return reply.code(404).send({ code: "NOT_FOUND", message: `实体不存在: ${id}`, retryable: false });
    }

    if (!entity.available) {
      const elapsed = Math.round(performance.now() - started);
      recordAudit(store, {
        trace_id: traceId, home_id: entity.home_id, actor: "user:u_demo", action: "entity.command",
        target: id, params: { service: parsed.data.service, ...parsed.data.data }, decision: "allow",
        reason: "adapter_error", result: "error", origin: "user", elapsed_ms: elapsed,
      });
      return reply.code(503).send({ code: "UNAVAILABLE", message: `${entity.name} 当前离线`, retryable: true, trace_id: traceId });
    }

    try {
      const next = applyService(entity, parsed.data.service, parsed.data.data);
      store.entities.set(id, next);
      const elapsed = Math.round(performance.now() - started);
      recordAudit(store, {
        trace_id: traceId, home_id: next.home_id, actor: "user:u_demo", action: "entity.command",
        target: id, params: { service: parsed.data.service, ...parsed.data.data }, decision: "allow",
        reason: "ok", result: "ok", origin: "user", elapsed_ms: elapsed,
      });
      const body = { ok: true, state: next.state, trace_id: traceId, elapsed_ms: elapsed };
      if (key) store.idempotency.set(key, body);
      return body;
    } catch (err) {
      const elapsed = Math.round(performance.now() - started);
      recordAudit(store, {
        trace_id: traceId, home_id: entity.home_id, actor: "user:u_demo", action: "entity.command",
        target: id, params: { service: parsed.data.service }, decision: "allow",
        reason: "adapter_error", result: "error", origin: "user", elapsed_ms: elapsed,
      });
      return reply.code(400).send({
        code: "BAD_REQUEST",
        message: err instanceof Error ? err.message : "执行失败",
        retryable: false,
        trace_id: traceId,
      });
    }
  });
}
