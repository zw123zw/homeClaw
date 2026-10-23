import type { AuditEntry, AuditDecision, AuditReason, Origin } from "@homeclaw/contracts";
import type { Db } from "../db/index.ts";

export type AuditInput = {
  homeId: string;
  traceId: string;
  actor: string;
  action: string;
  target: string;
  params?: Record<string, unknown>;
  decision: AuditDecision;
  reason: AuditReason;
  result: "ok" | "error" | "skipped";
  origin?: Origin;
  elapsedMs?: number;
};

type Row = {
  home_id: string;
  trace_id: string;
  actor: string;
  action: string;
  target: string;
  params: string;
  decision: string;
  reason: string;
  result: string;
  origin: string | null;
  elapsed_ms: number;
  ts: number;
};

/**
 * Audit：全量留痕。写入失败不能影响主流程，但必须留下警告 —
 * 审计缺失比操作失败更危险，因为它让事后追责变成不可能。
 */
export class Audit {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number) {
    this.db = db;
    this.now = now;
  }

  record(input: AuditInput): void {
    const ts = this.now();
    try {
      this.db.run(
        `INSERT INTO audit
          (home_id, trace_id, actor, action, target, params, decision, reason, result, origin, elapsed_ms, ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        input.homeId,
        input.traceId,
        input.actor,
        input.action,
        input.target,
        JSON.stringify(input.params ?? {}),
        input.decision,
        input.reason,
        input.result,
        input.origin ?? null,
        input.elapsedMs ?? 0,
        ts,
      );
    } catch (err) {
      console.error("[audit] 写入失败，操作已执行但无留痕:", err);
    }
  }

  query(q: {
    homeId: string;
    from?: number;
    to?: number;
    entity?: string;
    traceId?: string;
    decision?: AuditDecision;
    limit?: number;
  }): AuditEntry[] {
    const where: string[] = ["home_id = ?"];
    const args: Array<string | number> = [q.homeId];

    if (q.from !== undefined) { where.push("ts >= ?"); args.push(q.from); }
    if (q.to !== undefined) { where.push("ts <= ?"); args.push(q.to); }
    if (q.entity) { where.push("target LIKE ?"); args.push(`%${q.entity}%`); }
    if (q.traceId) { where.push("trace_id = ?"); args.push(q.traceId); }
    if (q.decision) { where.push("decision = ?"); args.push(q.decision); }

    const limit = Math.min(q.limit ?? 100, 1000);
    const rows = this.db.all<Row>(
      `SELECT * FROM audit WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ${limit}`,
      ...args,
    );

    return rows.map((r) => ({
      trace_id: r.trace_id,
      home_id: r.home_id,
      actor: r.actor,
      action: r.action,
      target: r.target,
      params: JSON.parse(r.params) as Record<string, unknown>,
      decision: r.decision as AuditDecision,
      reason: r.reason as AuditReason,
      result: r.result as "ok" | "error" | "skipped",
      origin: (r.origin ?? undefined) as Origin | undefined,
      elapsed_ms: r.elapsed_ms,
      ts: r.ts,
    }));
  }

  /** 按 trace 串起一次完整请求，用于排查（§M2 验收） */
  traceChain(homeId: string, traceId: string): AuditEntry[] {
    return this.query({ homeId, traceId, limit: 1000 }).reverse();
  }
}