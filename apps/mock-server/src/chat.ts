import type { FastifyInstance, FastifyReply } from "fastify";
import type { Envelope } from "@homeclaw/contracts";
import { PROTOCOL_VERSION } from "@homeclaw/contracts";
import { appendMessage, ensureSession, newId, nextSeq } from "./store.ts";
import { nowSeconds as NOW } from "@homeclaw/contracts";

type Logged = { seq: number; env: Envelope };
type Subscriber = (entry: Logged) => void;

/** session_id -> 已产出的信封日志（断线补齐的唯一依据） */
const logs = new Map<string, Logged[]>();
const subs = new Map<string, Set<Subscriber>>();

function lastSeq(sessionId: string): number {
  const log = logs.get(sessionId) ?? [];
  return log.length === 0 ? 0 : log[log.length - 1]!.seq;
}

export function emit(sessionId: string, env: Envelope) {
  const log = logs.get(sessionId) ?? [];
  const entry: Logged = { seq: lastSeq(sessionId) + 1, env };
  log.push(entry);
  logs.set(sessionId, log);
  for (const fn of subs.get(sessionId) ?? []) {
    try {
      fn(entry);
    } catch {
      /* 单个订阅者异常不影响广播 */
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sseWrite(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 假流式：30ms 一片；工具调用 800ms 延迟模拟真实往返 */
async function runFakeTurn(sessionId: string, userText: string, userMsgId: string) {
  const text = userText.trim();

  // 极简意图识别：命中"灯/窗帘/空调"就演一遍工具调用
  const isLight = /灯/.test(text);
  const isCover = /窗帘/.test(text);
  const tool = isLight ? "set_room_light" : isCover ? "set_cover" : null;

  if (tool) {
    const toolCallId = newId("t");
    emit(sessionId, {
      v: PROTOCOL_VERSION, type: "tool.start", id: toolCallId, session_id: sessionId,
      ts: NOW(), reply_to: userMsgId,
      payload: { tool, args: { room: "客厅", level: 30 }, summary: "客厅灯 → 30%" },
    } satisfies Envelope);
    await sleep(800);
    emit(sessionId, {
      v: PROTOCOL_VERSION, type: "tool.result", id: toolCallId, session_id: sessionId, ts: NOW(),
      payload: { ok: true, elapsed_ms: 800, result: { on: true, brightness: 30 } },
    } satisfies Envelope);
  }

  const reply = tool
    ? "好的，客厅灯已经调到 30% 了。还需要调整色温吗？"
    : `我收到了你的消息：「${text}」。这是 Mock 服务的模拟回复，用于验证流式渲染与断线补齐。`;

  const chunks = reply.match(/.{1,4}/gs) ?? [];
  for (const chunk of chunks) {
    emit(sessionId, {
      v: PROTOCOL_VERSION, type: "assistant.delta", id: newId("a"), session_id: sessionId,
      ts: NOW(), reply_to: userMsgId, seq: nextSeqOf(sessionId),
      payload: { text: chunk, done: false },
    } satisfies Envelope);
    await sleep(30);
  }

  emit(sessionId, {
    v: PROTOCOL_VERSION, type: "assistant.delta", id: newId("a"), session_id: sessionId,
    ts: NOW(), reply_to: userMsgId, seq: nextSeqOf(sessionId),
    payload: { text: "", done: true },
  } satisfies Envelope);
}

/** assistant.delta 的 seq 表示"本轮分片序号"，与信封日志 seq 分离 */
const turnSeq = new Map<string, number>();
function nextSeqOf(sessionId: string): number {
  const n = (turnSeq.get(sessionId) ?? 0) + 1;
  turnSeq.set(sessionId, n);
  return n;
}

export async function chatRoutes(app: FastifyInstance) {
  const { store } = app;

  /** SSE 通道：先补历史（last_seq 之后），再接收实时事件 */
  app.get("/v1/stream", async (req, reply) => {
    const q = req.query as { session_id?: string; last_seq?: string };
    const sessionId = q.session_id;
    if (!sessionId) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "缺少 session_id", retryable: false });
    }
    const after = Number(q.last_seq ?? 0);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    // 1) 先登记订阅，避免补齐期间丢事件
    const queue: Logged[] = [];
    let replaying = true;
    const sub: Subscriber = (entry) => {
      if (replaying) queue.push(entry);
      else sseWrite(reply, "envelope", { ...entry.env, log_seq: entry.seq });
    };
    const set = subs.get(sessionId) ?? new Set<Subscriber>();
    set.add(sub);
    subs.set(sessionId, set);

    // 2) 下发就绪帧 + 补齐
    sseWrite(reply, "envelope", {
      v: PROTOCOL_VERSION, type: "session.ready", id: newId("e"), session_id: sessionId, ts: NOW(),
      payload: { session_id: sessionId, last_seq: lastSeq(sessionId) },
    } satisfies Envelope);

    for (const entry of logs.get(sessionId) ?? []) {
      if (entry.seq > after) sseWrite(reply, "envelope", { ...entry.env, log_seq: entry.seq });
    }

    // 3) 补齐完成，flush 期间积压
    replaying = false;
    for (const entry of queue) sseWrite(reply, "envelope", { ...entry.env, log_seq: entry.seq });

    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    const cleanup = () => {
      clearInterval(ping);
      set.delete(sub);
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);

    // 该 handler 不 resolve，保持连接直到客户端断开
    await new Promise<void>((resolve) => {
      req.raw.on("close", () => resolve());
      req.raw.on("error", () => resolve());
    });
  });

  /** 上行：用户消息。立即 202，事件经 SSE 下发（与真实网关语义一致） */
  app.post("/v1/chat/message", async (req, reply) => {
    // 按 §5.1 收敛为"只认信封"：payload.text 才是正文；
    // 同时兼容 {session_id, text} 的扁平写法，方便 curl 调试
    const raw = req.body as
      | { type?: string; session_id?: string; id?: string; text?: string; payload?: { text?: string } }
      | undefined;
    const sessionId = raw?.session_id;
    const text = raw?.payload?.text ?? raw?.text;
    if (!sessionId || typeof text !== "string") {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "需要 session_id 与 text", retryable: false });
    }
    ensureSession(store, sessionId);

    const userMsgId = raw.id ?? newId("c");
    appendMessage(store, {
      id: userMsgId, session_id: sessionId, home_id: "h_demo0001", role: "user", text,
    });

    emit(sessionId, {
      v: PROTOCOL_VERSION, type: "user.message", id: userMsgId, session_id: sessionId, ts: NOW(),
      payload: { text, attachments: [] },
    } satisfies Envelope);

    void runFakeTurn(sessionId, text, userMsgId).then(() => {
      appendMessage(store, {
        id: newId("a"), session_id: sessionId, home_id: "h_demo0001", role: "assistant",
        text: "（模拟回复）",
      });
    });

    return reply.code(202).send({ ok: true, id: userMsgId });
  });

  /** 取消：只发错误帧 + done，模拟中断语义 */
  app.post("/v1/chat/cancel", async (req, reply) => {
    const body = req.body as { session_id?: string; target?: string } | undefined;
    if (!body?.session_id || !body.target) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "需要 session_id 与 target", retryable: false });
    }
    emit(body.session_id, {
      v: PROTOCOL_VERSION, type: "error", id: newId("e"), session_id: body.session_id, ts: NOW(),
      payload: { code: "CONFLICT", message: "已取消", retryable: false, reply_to: body.target },
    } satisfies Envelope);
    return { ok: true };
  });

  app.post("/_mock/reset-stream", async () => {
    logs.clear();
    turnSeq.clear();
    return { ok: true };
  });
}

