/**
 * HomeHub 会话/消息客户端。
 *
 * 会话持久化在 HomeHub（§3.2 记忆策略），L2 只读写、不拥有。
 * 所以 Gateway 不建自己的消息表 —— 否则客户端换一个网关就丢历史。
 */
import type { Attachment } from "@homeclaw/contracts";

export type HubMessage = {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "tool" | "system";
  seq: number;
  text: string;
  attachments: Attachment[];
  tool?: { name: string; args: Record<string, unknown>; ok?: boolean; elapsed_ms?: number };
  created_at: number;
};

export class HubClient {
  /**
   * 两张票据分工（§5.2）：
   *  - token（用户票据）：读实体/偏好/附件这类"面板也能做"的事；
   *  - mcpToken（MCP 票据）：写会话与消息 —— HomeHub 的 /v1/internal/* 只认这张。
   *
   * 为什么写消息不能用用户票据：客户端自己也持有用户票据，
   * 一旦它被允许写历史，客户端就能伪造 AI 的回复。
   */
  private readonly opts: { baseUrl: string; token: string; mcpToken: string };

  constructor(opts: { baseUrl: string; token: string; mcpToken: string }) {
    this.opts = opts;
  }

  private async req<T>(path: string, init?: RequestInit, principal: "user" | "mcp" = "user"): Promise<T> {
    const token = principal === "mcp" ? this.opts.mcpToken : this.opts.token;
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) throw new Error(`HomeHub ${init?.method ?? "GET"} ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  ensureSession(sessionId: string, title?: string) {
    return this.req<{ id: string }>("/v1/internal/sessions", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, title }),
    }, "mcp");
  }

  appendMessage(m: {
    session_id: string;
    id: string;
    role: HubMessage["role"];
    text: string;
    attachments?: Attachment[];
    tool?: HubMessage["tool"];
  }) {
    return this.req<HubMessage>("/v1/internal/messages", { method: "POST", body: JSON.stringify(m) }, "mcp");
  }

  /** 工具卡结果回填：不新增消息，避免历史里出现两张卡 */
  updateTool(sessionId: string, messageId: string, patch: { ok?: boolean; elapsed_ms?: number }) {
    return this.req<HubMessage>(`/v1/internal/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ session_id: sessionId, ...patch }),
    }, "mcp");
  }

  /** 读附件字节：图片要转 data URL 送模型，非文本附件只保留元数据 */
  async attachment(id: string): Promise<{ bytes: Buffer; mime: string }> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/attachments/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    if (!res.ok) throw new Error(`HomeHub GET /v1/attachments/${id} → HTTP ${res.status}`);
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      mime: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /** 断线补齐：cursor 是客户端已收到的最大 log_seq，这里用 seq 近似（一期两套 seq 同源） */
  messages(sessionId: string, q: { after?: number; before?: number; limit?: number } = {}) {
    const sp = new URLSearchParams();
    if (q.after !== undefined) sp.set("after", String(q.after));
    if (q.before !== undefined) sp.set("before", String(q.before));
    if (q.limit !== undefined) sp.set("limit", String(q.limit));
    return this.req<HubMessage[]>(`/v1/sessions/${encodeURIComponent(sessionId)}/messages?${sp}`);
  }

  /**
   * 已废弃：/v1/_debug/last-seq 现在默认关闭（HOMECLAW_DEBUG=1 才挂载）。
   * 断线补齐用的是 Gateway 自己的事件日志（stream.since），不需要问 HomeHub。
   * 保留这个方法只会让"默认配置下有一处调用必然 404"，所以直接删掉调用方。
   */
  lastSeq(sessionId: string): Promise<{ last_seq: number }> {
    void sessionId;
    return Promise.reject(new Error("lastSeq 已废弃：断线补齐请用 Gateway 的 stream.since"));
  }

  entities() {
    return this.req<Array<{ room: string }>>("/v1/entities");
  }

  /**
   * 用户偏好（记忆）。
   *
   * 失败时返回空对象而不是抛错：偏好是"加分项"，
   * HomeHub 偶发不可用不该让整轮对话失败 —— 模型少知道几条偏好仍能回答。
   */
  async preferences(): Promise<Record<string, string>> {
    try {
      const rows = await this.req<Array<{ key: string; value: string }>>("/v1/preferences");
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    } catch {
      return {};
    }
  }
}
