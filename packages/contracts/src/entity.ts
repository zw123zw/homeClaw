import { z } from "zod";
import { DeviceType, Id, Origin, RoomId, Timestamp } from "./common.ts";

/**
 * Entity —— 设备实体。id 使用 HA 风格 <domain>.<slug>，显示名与 id 分离：
 * 中文名只存在于 name 字段，可随时改；id 稳定不变。
 */
export const EntityCapability = z.enum([
  "on_off",
  "brightness",
  "color_temp",
  "color",
  "position",
  "temperature",
  "mode",
  "fan_speed",
  "media",
  "detect",
  "battery",
  "power",
]);
export type EntityCapability = z.infer<typeof EntityCapability>;

/** 状态体量小、形态多变，因此用宽松 record 承载，按 type 在适配器侧解释 */
export const EntityState = z.record(z.unknown());
export type EntityState = z.infer<typeof EntityState>;

export const Entity = z.object({
  id: Id,
  home_id: Id,
  name: z.string().min(1),
  room: RoomId,
  type: DeviceType,
  capabilities: z.array(EntityCapability).default([]),
  state: EntityState.default({}),
  available: z.boolean().default(true),
  updated_at: Timestamp,
});
export type Entity = z.infer<typeof Entity>;

/** 面板手动控制：与 AI 调用走同一 Policy/Audit 路径，只是 origin 不同 */
export const EntityCommandRequest = z.object({
  service: z.string().min(1).max(64),
  data: z.record(z.unknown()).default({}),
  idempotency_key: Id.optional(),
});
export type EntityCommandRequest = z.infer<typeof EntityCommandRequest>;

export const EntityCommandResponse = z.object({
  ok: z.boolean(),
  state: EntityState.optional(),
  trace_id: Id,
  elapsed_ms: z.number().nonnegative(),
});
export type EntityCommandResponse = z.infer<typeof EntityCommandResponse>;

/** 适配器层内部使用的完整指令（客户端不会构造它） */
export const ServiceCommand = z.object({
  idempotency_key: Id,
  home_id: Id,
  entity_id: Id,
  service: z.string().min(1).max(64),
  data: z.record(z.unknown()).default({}),
  origin: Origin,
  trace_id: Id,
  timeout_ms: z.number().int().positive().max(30_000).default(5000),
});
export type ServiceCommand = z.infer<typeof ServiceCommand>;

export const ServiceResult = z.object({
  ok: z.boolean(),
  state: EntityState.optional(),
  elapsed_ms: z.number().nonnegative(),
  error: z.string().optional(),
});
export type ServiceResult = z.infer<typeof ServiceResult>;

/** 设备事件：L4 上报 → L3 EventBus。origin 由 L3 归因，不由设备决定 */
export const DeviceEvent = z.object({
  id: Id,
  home_id: Id,
  entity_id: Id,
  kind: z.enum(["state_changed", "availability_changed", "triggered"]),
  attribute: z.string().optional(),
  old: z.unknown().optional(),
  new: z.unknown().optional(),
  origin: Origin.default("device"),
  trace_id: Id.optional(),
  ts: Timestamp,
});
export type DeviceEvent = z.infer<typeof DeviceEvent>;
