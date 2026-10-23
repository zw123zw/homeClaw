import { z } from "zod";

/** 所有时间戳统一为 Unix 秒（与服务端、HA 一致） */
export const Timestamp = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof Timestamp>;

/** 所有实体/记录 ID 统一字符串前缀式：h_ / s_ / c_ / a_ / t_ / tr_ / e_ */
export const Id = z.string().min(1).max(128);
export type Id = z.infer<typeof Id>;

export const RoomId = z.string().min(1).max(64);
export type RoomId = z.infer<typeof RoomId>;

/** 设备类型（一期覆盖范围，长尾类型走 L2 检索，不在此枚举内） */
export const DeviceType = z.enum([
  "light",
  "cover",
  "climate",
  "fan",
  "switch",
  "sensor",
  "binary_sensor",
  "media_player",
  "vacuum",
  "lock",
  "camera",
  "energy",
]);
export type DeviceType = z.infer<typeof DeviceType>;

/** 操作来源：决定事件是否允许再触发 AI（origin=ai 硬阻断，防止环路） */
export const Origin = z.enum(["ai", "user", "rule", "device"]);
export type Origin = z.infer<typeof Origin>;

/** 统一错误码；客户端据此决定是否展示重试按钮 */
export const ErrorCode = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "BAD_REQUEST",
  "POLICY_DENIED",
  "HARD_DENY",
  "RATE_LIMITED",
  "BUDGET_EXCEEDED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_ERROR",
  "CONFLICT",
  "UNAVAILABLE",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  retryable: z.boolean().default(false),
  trace_id: Id.optional(),
  detail: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
