import { z } from "zod";
import { Id, Origin, Timestamp } from "./common.ts";

export const AuditActor = z.string().regex(/^(ai|user|rule|system):.+$/, {
  message: "actor 必须形如 ai:hermes / user:u_xxx / rule:auto_xxx",
});
export type AuditActor = z.infer<typeof AuditActor>;

export const AuditDecision = z.enum(["allow", "deny"]);
export type AuditDecision = z.infer<typeof AuditDecision>;

/** 拒绝/告警原因，与 policy 模块一一对应，便于统计 */
export const AuditReason = z.enum([
  "ok",
  "policy_whitelist",
  "policy_service",
  "hard_deny",
  "rate_limited",
  "budget_exceeded",
  "loop_blocked",
  "idempotent_replay",
  "adapter_error",
]);
export type AuditReason = z.infer<typeof AuditReason>;

export const AuditEntry = z.object({
  trace_id: Id,
  home_id: Id,
  actor: AuditActor,
  action: z.string().min(1),
  target: z.string(),
  params: z.record(z.unknown()).default({}),
  decision: AuditDecision,
  reason: AuditReason,
  result: z.enum(["ok", "error", "skipped"]),
  origin: Origin.optional(),
  elapsed_ms: z.number().nonnegative().default(0),
  ts: Timestamp,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** 审计查询：一期只支持时间区间 + 目标 + trace 三种过滤 */
export const AuditQuery = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  entity: z.string().optional(),
  trace_id: z.string().optional(),
  decision: AuditDecision.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
export type AuditQuery = z.infer<typeof AuditQuery>;
