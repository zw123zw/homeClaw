import type { Attachment, Envelope } from "@homeclaw/contracts";

/** 消息流中的一条记录。tool 卡片是独立 item，与 assistant 文本分离，便于折叠 */
export type ChatItem =
  | { kind: "user"; id: string; text: string; attachments: Attachment[]; ts: number }
  | { kind: "assistant"; id: string; text: string; attachments: Attachment[]; streaming: boolean; ts: number; error?: string }
  | { kind: "tool"; id: string; tool: string; args: Record<string, unknown>; summary?: string; ok?: boolean; elapsedMs?: number; ts: number };

export type ChatState = {
  items: ChatItem[];
  /** 正在流式输出的 assistant item id（null 表示空闲） */
  activeReplyId: string | null;
  /** 用于"停止生成"按钮 */
  activeUserMsgId: string | null;
  lastLogSeq: number;
};

export const initialChatState: ChatState = {
  items: [],
  activeReplyId: null,
  activeUserMsgId: null,
  lastLogSeq: 0,
};

/**
 * 流式 reducer（§3.1）：只做纯函数增量，不做渲染调度。
 * 分片合并到同一个 assistant item，避免每个 token 产生一个新数组元素。
 */
export function reduceEnvelope(state: ChatState, env: Envelope): ChatState {
  const logSeq = typeof env.log_seq === "number" ? Math.max(state.lastLogSeq, env.log_seq) : state.lastLogSeq;

  switch (env.type) {
    case "user.message": {
      // 本地乐观插入过的同 id 消息不重复添加
      if (state.items.some((i) => i.id === env.id)) return { ...state, lastLogSeq: logSeq };
      return {
        ...state,
        lastLogSeq: logSeq,
        items: [
          ...state.items,
          { kind: "user", id: env.id, text: env.payload.text, attachments: env.payload.attachments ?? [], ts: env.ts ?? Date.now() / 1000 },
        ],
      };
    }

    case "assistant.delta": {
      const isDone = env.payload.done;
      const idx = state.items.findIndex((i) => i.kind === "assistant" && i.id === state.activeReplyId && i.streaming);

      if (idx >= 0) {
        const items = state.items.slice();
        const cur = items[idx] as Extract<ChatItem, { kind: "assistant" }>;
        items[idx] = isDone
          ? { ...cur, streaming: false }
          : { ...cur, text: cur.text + env.payload.text };
        return { ...state, lastLogSeq: logSeq, items, activeReplyId: isDone ? null : state.activeReplyId };
      }

      // 首片：新建一个 streaming 气泡
      const id = `a_${env.reply_to}_${env.seq}`;
      if (isDone) return { ...state, lastLogSeq: logSeq, activeReplyId: null };
      return {
        ...state,
        lastLogSeq: logSeq,
        activeReplyId: id,
        items: [
          ...state.items,
          { kind: "assistant", id, text: env.payload.text, attachments: env.payload.attachments ?? [], streaming: true, ts: env.ts ?? Date.now() / 1000 },
        ],
      };
    }

    case "tool.start": {
      return {
        ...state,
        lastLogSeq: logSeq,
        items: [
          ...state.items,
          {
            kind: "tool",
            id: env.id,
            tool: env.payload.tool,
            args: env.payload.args,
            summary: env.payload.summary,
            ts: env.ts ?? Date.now() / 1000,
          },
        ],
      };
    }

    case "tool.result": {
      // 按 id 精确回填到起对应的那张卡片（并发工具调用时不会错位）
      const idx = state.items.findIndex((i) => i.kind === "tool" && i.id === env.id);
      if (idx < 0) return { ...state, lastLogSeq: logSeq };
      const items = state.items.slice();
      const cur = items[idx] as Extract<ChatItem, { kind: "tool" }>;
      items[idx] = { ...cur, ok: env.payload.ok, elapsedMs: env.payload.elapsed_ms };
      return { ...state, lastLogSeq: logSeq, items };
    }

    case "error": {
      if (state.activeReplyId) {
        const items = state.items.map((i) =>
          i.kind === "assistant" && i.id === state.activeReplyId
            ? { ...i, streaming: false, error: env.payload.message }
            : i,
        );
        return { ...state, lastLogSeq: logSeq, items, activeReplyId: null };
      }
      return {
        ...state,
        lastLogSeq: logSeq,
        items: [
          ...state.items,
          { kind: "assistant", id: env.id, text: "", attachments: [], streaming: false, error: env.payload.message, ts: env.ts ?? Date.now() / 1000 },
        ],
      };
    }

    case "session.ready":
      return { ...state, lastLogSeq: logSeq };

    case "run.cancel":
      return state;

    default:
      // 前向兼容：网关升级后可能下发本客户端不认识的信封，忽略而不是崩溃
      return state;
  }
}

/**
 * 历史消息 → 消息流。
 *
 * 为什么不用"渲染两套 UI"（历史一套、实时一套）：
 *  切换会话时视觉会跳变，而且两份渲染代码必然漂移。
 * 这里把历史消息按同样的 ChatItem 形状喂进同一个列表，实时信封继续往后追加即可。
 *
 * seq 的作用：断线期间收到的实时信封（log_seq）与历史（seq）是两套编号，
 * 但**同一会话里消息 seq 单调递增**，所以历史最后一条的 seq 可以作为分页游标。
 */
export function fromHistory(
  rows: Array<{ id: string; role: string; text: string; attachments?: Attachment[]; tool?: { name: string; args: Record<string, unknown>; ok?: boolean; elapsed_ms?: number }; created_at: number }>,
): ChatState {
  const items: ChatItem[] = [];
  for (const m of rows) {
    if (m.role === "tool" && m.tool) {
      items.push({
        kind: "tool",
        id: m.id,
        tool: m.tool.name,
        args: m.tool.args ?? {},
        ok: m.tool.ok,
        elapsedMs: m.tool.elapsed_ms,
        ts: m.created_at,
      });
      continue;
    }
    if (m.role === "user") {
      items.push({ kind: "user", id: m.id, text: m.text, attachments: m.attachments ?? [], ts: m.created_at });
      continue;
    }
    if (m.role === "assistant" && m.text) {
      items.push({ kind: "assistant", id: m.id, text: m.text, attachments: m.attachments ?? [], streaming: false, ts: m.created_at });
    }
    // role=system 不进消息流：那是落库用的元信息，不该出现在对话里
  }
  return { ...initialChatState, items };
}

/** 上线乐观插入：本地先显示用户消息，收到服务端回声后按 id 去重 */
export function appendLocalUser(state: ChatState, id: string, text: string, attachments: Attachment[] = []): ChatState {
  if (state.items.some((i) => i.id === id)) return state;
  return {
    ...state,
    activeUserMsgId: id,
    items: [...state.items, { kind: "user", id, text, attachments, ts: Date.now() / 1000 }],
  };
}

export function markStopped(state: ChatState): ChatState {
  if (!state.activeReplyId) return { ...state, activeUserMsgId: null };
  return {
    ...state,
    activeUserMsgId: null,
    activeReplyId: null,
    items: state.items.map((i) =>
      i.kind === "assistant" && i.id === state.activeReplyId ? { ...i, streaming: false } : i,
    ),
  };
}