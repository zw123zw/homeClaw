import type { Entity, Origin, ServiceResult } from "@homeclaw/contracts";
import type { Db } from "./db/index.ts";
import type { DeviceAdapter } from "./adapter/types.ts";
import type { Policy } from "./policy/index.ts";
import type { Audit } from "./audit/index.ts";

export type CommandInput = {
  entityId: string;
  service: string;
  data?: Record<string, unknown>;
  origin: Origin;
  actor: string;
  /** 幂等键：不传则自动生成（仅用于无需去重的场景） */
  idempotencyKey?: string;
  traceId: string;
};

export type CommandOutcome =
  | { ok: true; state: Record<string, unknown> | undefined; traceId: string; elapsedMs: number; replayed: boolean }
  | {
      ok: false;
      code: "NOT_FOUND" | "UNAVAILABLE" | "POLICY_DENIED" | "HARD_DENY" | "RATE_LIMITED" | "BAD_REQUEST";
      message: string;
      traceId: string;
      reason?: string;
    };

/**
 * CommandPipeline：设备操作的唯一入口（深模块）。
 *
 * 调用方（HTTP 路由、ToolHub、场景执行、规则引擎）只需知道
 * 「entityId + service + data + origin」，这里统一承担：
 *   幂等 → 实体查找 → 策略（硬拒绝/白名单/频率）→ 适配器调用 → 审计
 *
 * 这个模块的价值在删除测试：删掉它，上面五步会散落到 4 个调用方里，
 * 且任何一处漏掉硬拒绝就是安全事故。
 */
export class CommandPipeline {
  private readonly deps: {
    db: Db;
    homeId: string;
    adapter: DeviceAdapter;
    policy: Policy;
    audit: Audit;
    now: () => number;
    newId: (prefix: string) => string;
  };

  constructor(deps: {
    db: Db;
    homeId: string;
    adapter: DeviceAdapter;
    policy: Policy;
    audit: Audit;
    now: () => number;
    newId: (prefix: string) => string;
  }) {
    this.deps = deps;
  }

  async execute(input: CommandInput): Promise<CommandOutcome> {
    const { db, homeId, adapter, policy, audit, now, newId } = this.deps;
    const started = performance.now();
    const idempotencyKey = input.idempotencyKey ?? newId("ik");

    // 1) 幂等：命中即回放上次结果，但仍留痕（否则审计会出现黑洞）
    const cached = db.one<{ result: string }>(
      "SELECT result FROM idempotency WHERE home_id = ? AND key = ?",
      homeId, idempotencyKey,
    );
    if (cached) {
      const prev = JSON.parse(cached.result) as { ok: boolean; state?: Record<string, unknown> };
      audit.record({
        homeId, traceId: input.traceId, actor: input.actor, action: "entity.command",
        target: input.entityId,
        params: { service: input.service, ...(input.data ?? {}), idempotency_key: idempotencyKey },
        decision: "allow", reason: "idempotent_replay", result: "skipped",
        origin: input.origin, elapsedMs: 0,
      });
      return { ok: true, state: prev.state, traceId: input.traceId, elapsedMs: 0, replayed: true };
    }

    // 2) 实体必须存在
    const entity = await this.findEntity(input.entityId);
    if (!entity) {
      audit.record({
        homeId, traceId: input.traceId, actor: input.actor, action: "entity.command",
        target: input.entityId, params: { service: input.service },
        decision: "deny", reason: "policy_whitelist", result: "error", origin: input.origin, elapsedMs: 0,
      });
      return { ok: false, code: "NOT_FOUND", message: `实体不存在: ${input.entityId}`, traceId: input.traceId };
    }

    // 3) 策略：硬拒绝 → 白名单 → 频率
    const policyDecision = policy.checkEntityAndService(entity, input.service);
    if (!policyDecision.allow) {
      audit.record({
        homeId, traceId: input.traceId, actor: input.actor, action: "entity.command",
        target: entity.id, params: { service: input.service, ...(input.data ?? {}) },
        decision: "deny", reason: policyDecision.reason, result: "error",
        origin: input.origin, elapsedMs: Math.round(performance.now() - started),
      });
      return {
        ok: false,
        code: policyDecision.reason === "hard_deny" ? "HARD_DENY" : "POLICY_DENIED",
        message: policyDecision.detail,
        traceId: input.traceId,
        reason: policyDecision.reason,
      };
    }

    const rateDecision = policy.checkRate(entity, now());
    if (!rateDecision.allow) {
      audit.record({
        homeId, traceId: input.traceId, actor: input.actor, action: "entity.command",
        target: entity.id, params: { service: input.service },
        decision: "deny", reason: "rate_limited", result: "error",
        origin: input.origin, elapsedMs: Math.round(performance.now() - started),
      });
      return { ok: false, code: "RATE_LIMITED", message: rateDecision.detail, traceId: input.traceId, reason: "rate_limited" };
    }

    // 4) 设备离线：明确报错，不静默成功
    if (!entity.available) {
      const elapsed = Math.round(performance.now() - started);
      audit.record({
        homeId, traceId: input.traceId, actor: input.actor, action: "entity.command",
        target: entity.id, params: { service: input.service },
        decision: "allow", reason: "adapter_error", result: "error",
        origin: input.origin, elapsedMs: elapsed,
      });
      return { ok: false, code: "UNAVAILABLE", message: `${entity.name} 当前离线`, traceId: input.traceId };
    }

    // 5) 执行
    let result: ServiceResult;
    try {
      result = await adapter.callService({
        idempotency_key: idempotencyKey,
        home_id: homeId,
        entity_id: entity.id,
        service: input.service,
        data: input.data ?? {},
        origin: input.origin,
        trace_id: input.traceId,
        timeout_ms: 5000,
      });
    } catch (err) {
      result = { ok: false, elapsed_ms: 0, error: err instanceof Error ? err.message : "适配器异常" };
    }

    const elapsed = Math.round(performance.now() - started);

    if (!result.ok) {
      audit.record({
        homeId, traceId: input.traceId, actor: input.actor, action: "entity.command",
        target: entity.id, params: { service: input.service, ...(input.data ?? {}) },
        decision: "allow", reason: "adapter_error", result: "error",
        origin: input.origin, elapsedMs: elapsed,
      });
      return { ok: false, code: "BAD_REQUEST", message: result.error ?? "执行失败", traceId: input.traceId };
    }

    // 6) 成功：记配额、写幂等缓存、留审计
    policy.recordUsage(entity, now());
    db.run(
      "INSERT OR REPLACE INTO idempotency (home_id, key, result, ts) VALUES (?,?,?,?)",
      homeId, idempotencyKey, JSON.stringify({ ok: true, state: result.state }), now(),
    );
    audit.record({
      homeId, traceId: input.traceId, actor: input.actor, action: "entity.command",
      target: entity.id, params: { service: input.service, ...(input.data ?? {}) },
      decision: "allow", reason: "ok", result: "ok",
      origin: input.origin, elapsedMs: elapsed,
    });

    return { ok: true, state: result.state, traceId: input.traceId, elapsedMs: elapsed, replayed: false };
  }

  private async findEntity(entityId: string): Promise<Entity | undefined> {
    const list = await this.deps.adapter.listEntities(this.deps.homeId);
    return list.find((e: Entity) => e.id === entityId);
  }
}