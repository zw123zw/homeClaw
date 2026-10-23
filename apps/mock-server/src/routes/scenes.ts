import type { FastifyInstance } from "fastify";
import { newId, recordAudit, scenes, applyService } from "../store.ts";

export async function sceneRoutes(app: FastifyInstance) {
  const { store } = app;

  app.get("/v1/scenes", async () => scenes);

  app.post("/v1/scenes/:id/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const scene = scenes.find((s) => s.id === id);
    const traceId = newId("tr");

    if (!scene) {
      return reply.code(404).send({ code: "NOT_FOUND", message: `场景不存在: ${id}`, retryable: false });
    }

    const results = [];
    for (const action of scene.actions) {
      const started = performance.now();
      const entity = store.entities.get(action.entity);
      if (!entity || !entity.available) {
        const elapsed = Math.round(performance.now() - started);
        results.push({ entity: action.entity, service: action.service, ok: false, error: entity ? "设备离线" : "实体不存在", elapsed_ms: elapsed });
        recordAudit(store, {
          trace_id: traceId, home_id: scene.home_id, actor: "user:u_demo", action: "scene.run",
          target: `${scene.id} -> ${action.entity}`, params: action.data, decision: "allow",
          reason: "adapter_error", result: "error", origin: "user", elapsed_ms: elapsed,
        });
        continue;
      }
      try {
        const next = applyService(entity, action.service, action.data);
        store.entities.set(action.entity, next);
        const elapsed = Math.round(performance.now() - started);
        results.push({ entity: action.entity, service: action.service, ok: true, elapsed_ms: elapsed });
        recordAudit(store, {
          trace_id: traceId, home_id: scene.home_id, actor: "user:u_demo", action: "scene.run",
          target: `${scene.id} -> ${action.entity}`, params: action.data, decision: "allow",
          reason: "ok", result: "ok", origin: "user", elapsed_ms: elapsed,
        });
      } catch (err) {
        const elapsed = Math.round(performance.now() - started);
        results.push({ entity: action.entity, service: action.service, ok: false, error: err instanceof Error ? err.message : "失败", elapsed_ms: elapsed });
      }
    }

    return { ok: results.every((r) => r.ok), trace_id: traceId, results };
  });
}
