import type { FastifyInstance } from "fastify";
import { AuditQuery } from "@homeclaw/contracts";

export async function auditRoutes(app: FastifyInstance) {
  const { store } = app;

  app.get("/v1/audit", async (req, reply) => {
    const parsed = AuditQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "查询参数不合法", retryable: false });
    }
    const { from, to, entity, trace_id, decision, limit } = parsed.data;
    return store.audit
      .filter((a) => (typeof from === "number" ? a.ts >= from : true))
      .filter((a) => (typeof to === "number" ? a.ts <= to : true))
      .filter((a) => (entity ? a.target.includes(entity) : true))
      .filter((a) => (trace_id ? a.trace_id === trace_id : true))
      .filter((a) => (decision ? a.decision === decision : true))
      .slice(0, limit);
  });
}
