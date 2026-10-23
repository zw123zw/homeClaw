import { z } from "zod";
import { ErrorCode, Id, Timestamp } from "./common.ts";
import { Attachment } from "./attachment.ts";

export const PROTOCOL_VERSION = 1;

/**
 * L1 ↔ L2 消息信封（§5.1）。
 * 约束：所有信封带 v；assistant.delta 带 seq 用于去重排序与断线补齐；
 * reply_to 关联用户消息以支持并发多轮。
 */
const base = {
  v: z.literal(PROTOCOL_VERSION),
  id: Id,
  ts: Timestamp.optional(),
  session_id: Id.optional(),
  /**
   * 服务端事件日志序号（单调递增，仅服务端填写）。
   * 客户端断线重连时带 last_seq = 已收到的最大 log_seq，用于补齐缺口。
   * 注意：与 assistant.delta.seq（轮内分片序号）语义不同，不可混用。
   */
  log_seq: z.number().int().nonnegative().optional(),
};

export const UserMessage = z.object({
  ...base,
  type: z.literal("user.message"),
  payload: z.object({
    text: z.string(),
    attachments: z.array(Attachment).default([]),
    /** 本次 run 使用的模型配置 id；缺省时用网关当前 active 模型 */
    model_id: z.string().min(1).optional(),
    /**
     * 深度思考开关（聊天输入框）。
     * 只影响路由：true 时强制走规划内核，false/缺省按规则判定。
     * 不放进 payload.attachments 之类复用字段里，因为它是"意图"不是"数据"。
     */
    prefer_planning: z.boolean().optional(),
  }),
});
export type UserMessage = z.infer<typeof UserMessage>;

export const AssistantDelta = z.object({
  ...base,
  type: z.literal("assistant.delta"),
  reply_to: Id,
  seq: z.number().int().nonnegative(),
  payload: z.object({
    text: z.string(),
    /** true 表示该轮最后一帧，客户端据此结束 loading 态 */
    done: z.boolean().default(false),
    attachments: z.array(Attachment).default([]),
  }),
});
export type AssistantDelta = z.infer<typeof AssistantDelta>;

export const ToolStart = z.object({
  ...base,
  type: z.literal("tool.start"),
  reply_to: Id.optional(),
  payload: z.object({
    tool: z.string().min(1),
    args: z.record(z.unknown()).default({}),
    summary: z.string().optional(),
  }),
});
export type ToolStart = z.infer<typeof ToolStart>;

export const ToolResult = z.object({
  ...base,
  type: z.literal("tool.result"),
  /** 必须等于对应 tool.start 的 id，客户端据此把结果回填到同一张卡片 */
  payload: z.object({
    ok: z.boolean(),
    result: z.unknown().optional(),
    elapsed_ms: z.number().nonnegative().default(0),
    error: z.string().optional(),
  }),
});
export type ToolResult = z.infer<typeof ToolResult>;

export const RunCancel = z.object({
  ...base,
  type: z.literal("run.cancel"),
  payload: z.object({ target: Id }),
});
export type RunCancel = z.infer<typeof RunCancel>;

export const ErrorEnvelope = z.object({
  ...base,
  type: z.literal("error"),
  payload: z.object({
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean().default(false),
    reply_to: Id.optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/** 服务端在 SSE 建连后立即下发，客户端用 cursor 做首轮同步 */
export const ReadyEnvelope = z.object({
  ...base,
  type: z.literal("session.ready"),
  payload: z.object({
    session_id: Id,
    /** 该会话服务器已产出的最大 seq，客户端据此判断是否需要补齐 */
    last_seq: z.number().int().nonnegative().default(0),
  }),
});
export type ReadyEnvelope = z.infer<typeof ReadyEnvelope>;

export const Envelope = z.discriminatedUnion("type", [
  UserMessage,
  AssistantDelta,
  ToolStart,
  ToolResult,
  RunCancel,
  ErrorEnvelope,
  ReadyEnvelope,
]);
export type Envelope = z.infer<typeof Envelope>;

/** 客户端 → 网关的方向限定，避免前端误发服务端事件 */
export const ClientEnvelope = z.discriminatedUnion("type", [
  UserMessage,
  RunCancel,
]);
export type ClientEnvelope = z.infer<typeof ClientEnvelope>;
