import type { Attachment, Message, Session } from "@homeclaw/contracts";
import type { Db } from "../db/index.ts";

type SessionRow = {
  home_id: string;
  session_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
};

type MessageRow = {
  home_id: string;
  session_id: string;
  message_id: string;
  role: string;
  seq: number;
  text: string;
  attachments: string;
  tool: string | null;
  created_at: number;
};

const toSession = (r: SessionRow): Session => ({
  id: r.session_id,
  home_id: r.home_id,
  title: r.title,
  created_at: r.created_at,
  updated_at: r.updated_at,
  message_count: r.message_count,
});

function parseAttachments(raw: string | null | undefined): Attachment[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as Attachment[]) : [];
  } catch {
    return [];
  }
}

const toMessage = (r: MessageRow): Message => ({
  id: r.message_id,
  session_id: r.session_id,
  home_id: r.home_id,
  role: r.role as Message["role"],
  seq: r.seq,
  text: r.text,
  attachments: parseAttachments(r.attachments),
  tool: r.tool ? (JSON.parse(r.tool) as Message["tool"]) : undefined,
  created_at: r.created_at,
});

export type AppendMessageInput = Omit<Message, "seq" | "created_at" | "home_id" | "attachments"> & {
  attachments?: Attachment[];
};

/**
 * Sessions：会话与消息的持久化。
 * 关键不变式：同一 session 内 seq 单调递增且无空洞；seq 是断线补齐的唯一依据。
 * 因此追加消息必须在一个事务里"取当前最大 seq + 1 并插入"。
 */
export class Sessions {
  private readonly db: Db;
  private readonly homeId: string;
  private readonly now: () => number;

  constructor(db: Db, homeId: string, now: () => number) {
    this.db = db;
    this.homeId = homeId;
    this.now = now;
  }

  create(sessionId: string, title = "新会话"): Session {
    const ts = this.now();
    this.db.run(
      `INSERT INTO sessions (home_id, session_id, title, created_at, updated_at, message_count)
       VALUES (?,?,?,?,?,0)`,
      this.homeId, sessionId, title, ts, ts,
    );
    return this.mustGet(sessionId);
  }

  ensure(sessionId: string, title = "新会话"): Session {
    const found = this.find(sessionId);
    return found ?? this.create(sessionId, title);
  }

  find(sessionId: string): Session | undefined {
    const row = this.db.one<SessionRow>(
      "SELECT * FROM sessions WHERE home_id = ? AND session_id = ?",
      this.homeId, sessionId,
    );
    return row ? toSession(row) : undefined;
  }

  private mustGet(sessionId: string): Session {
    const s = this.find(sessionId);
    if (!s) throw new Error(`会话不存在: ${sessionId}`);
    return s;
  }

  list(): Session[] {
    return this.db
      .all<SessionRow>(
        "SELECT * FROM sessions WHERE home_id = ? ORDER BY updated_at DESC",
        this.homeId,
      )
      .map(toSession);
  }

  findMessage(sessionId: string, messageId: string): Message | undefined {
    const row = this.db.one<MessageRow>(
      "SELECT * FROM messages WHERE home_id = ? AND session_id = ? AND message_id = ?",
      this.homeId, sessionId, messageId,
    );
    return row ? toMessage(row) : undefined;
  }

  /**
   * 追加消息：事务内分配 seq，保证并发下不重号。
   * 按 message_id 幂等：客户端重试 / Gateway 重放时返回原消息，不产生第二条。
   */
  append(input: AppendMessageInput): Message {
    const existing = this.findMessage(input.session_id, input.id);
    if (existing) return existing;

    const ts = this.now();
    return this.db.tx(() => {
      const last = this.db.one<{ max_seq: number | null }>(
        "SELECT MAX(seq) AS max_seq FROM messages WHERE home_id = ? AND session_id = ?",
        this.homeId, input.session_id,
      );
      const seq = (last?.max_seq ?? 0) + 1;

      this.db.run(
        `INSERT INTO messages (home_id, session_id, message_id, role, seq, text, attachments, tool, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        this.homeId, input.session_id, input.id, input.role, seq, input.text,
        JSON.stringify(input.attachments ?? []),
        input.tool ? JSON.stringify(input.tool) : null, ts,
      );

      this.db.run(
        `UPDATE sessions SET message_count = message_count + 1, updated_at = ?
         WHERE home_id = ? AND session_id = ?`,
        ts, this.homeId, input.session_id,
      );

      return { ...input, attachments: input.attachments ?? [], home_id: this.homeId, seq, created_at: ts };
    });
  }

  /** 工具结果回填：只改同一条工具卡，不新增消息，避免历史里出现两张卡 */
  updateTool(sessionId: string, messageId: string, patch: { ok?: boolean; elapsed_ms?: number }): Message | undefined {
    const row = this.db.one<MessageRow>(
      "SELECT * FROM messages WHERE home_id = ? AND session_id = ? AND message_id = ?",
      this.homeId, sessionId, messageId,
    );
    if (!row) return undefined;
    const current = row.tool ? (JSON.parse(row.tool) as NonNullable<Message["tool"]>) : { name: "", args: {} };
    const next = { ...current, ...patch };
    this.db.run(
      "UPDATE messages SET tool = ? WHERE home_id = ? AND session_id = ? AND message_id = ?",
      JSON.stringify(next), this.homeId, sessionId, messageId,
    );
    return { ...toMessage(row), tool: next };
  }

  /**
   * 分页：after 用于断线补齐（seq > after），before 用于历史回溯（seq < before）。
   * 两种语义互斥，同时给以 after 为准并记录告警 —— 静默忽略会让排障变困难。
   */
  page(sessionId: string, q: { after?: number; before?: number; limit: number }): Message[] {
    if (q.after !== undefined && q.before !== undefined) {
      console.warn(`[sessions] after 与 before 同时提供，以 after 为准 (session=${sessionId})`);
    }

    if (q.after !== undefined) {
      return this.db
        .all<MessageRow>(
          `SELECT * FROM messages WHERE home_id = ? AND session_id = ? AND seq > ?
           ORDER BY seq ASC LIMIT ?`,
          this.homeId, sessionId, q.after, q.limit,
        )
        .map(toMessage);
    }

    if (q.before !== undefined) {
      // 历史回溯：先取最近的 N 条，再升序返回，客户端可直接拼接
      const rows = this.db.all<MessageRow>(
        `SELECT * FROM messages WHERE home_id = ? AND session_id = ? AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
        this.homeId, sessionId, q.before, q.limit,
      );
      return rows.reverse().map(toMessage);
    }

    return this.db
      .all<MessageRow>(
        `SELECT * FROM messages WHERE home_id = ? AND session_id = ?
         ORDER BY seq ASC LIMIT ?`,
        this.homeId, sessionId, q.limit,
      )
      .map(toMessage);
  }

  lastSeq(sessionId: string): number {
    const row = this.db.one<{ max_seq: number | null }>(
      "SELECT MAX(seq) AS max_seq FROM messages WHERE home_id = ? AND session_id = ?",
      this.homeId, sessionId,
    );
    return row?.max_seq ?? 0;
  }
}
