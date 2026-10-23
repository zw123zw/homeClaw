import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { Envelope } from "./envelope.ts";
import { Attachment } from "./attachment.ts";

/** 会话持久化在 HomeHub（sessions 表），L2 只读写、不拥有 */
export const Session = z.object({
  id: Id,
  home_id: Id,
  title: z.string(),
  created_at: Timestamp,
  updated_at: Timestamp,
  message_count: z.number().int().nonnegative().default(0),
});
export type Session = z.infer<typeof Session>;

export const MessageRole = z.enum(["user", "assistant", "tool", "system"]);
export type MessageRole = z.infer<typeof MessageRole>;

/** messages 表：seq 在同一 session 内单调递增，是断线补齐的唯一依据 */
export const Message = z.object({
  id: Id,
  session_id: Id,
  home_id: Id,
  role: MessageRole,
  seq: z.number().int().nonnegative(),
  text: z.string().default(""),
  attachments: z.array(Attachment).default([]),
  tool: z
    .object({
      name: z.string(),
      args: z.record(z.unknown()).default({}),
      ok: z.boolean().optional(),
      elapsed_ms: z.number().optional(),
    })
    .optional(),
  created_at: Timestamp,
});
export type Message = z.infer<typeof Message>;

export const CreateSessionRequest = z.object({
  title: z.string().max(120).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

/** 断线重连补齐：?after=<seq> 返回所有 seq > after 的消息，按 seq 升序 */
export const MessagePageQuery = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  before: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type MessagePageQuery = z.infer<typeof MessagePageQuery>;

export { Envelope };
