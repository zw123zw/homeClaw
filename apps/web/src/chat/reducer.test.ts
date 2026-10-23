import { describe, expect, it } from "vitest";
import { initialChatState, reduceEnvelope, appendLocalUser, markStopped } from "./reducer";
import type { Envelope } from "@homeclaw/contracts";

const userMsg = (id: string): Envelope => ({
  v: 1, type: "user.message", id, session_id: "s1", ts: 1, log_seq: 1,
  payload: { text: "hi", attachments: [] },
});
const delta = (replyTo: string, seq: number, text: string, done = false, logSeq = 2): Envelope => ({
  v: 1, type: "assistant.delta", id: `a${seq}`, session_id: "s1", ts: 1,
  reply_to: replyTo, seq, log_seq: logSeq, payload: { text, done, attachments: [] },
});

describe("chat reducer", () => {
  it("分片合并进同一气泡，不产生多条消息", () => {
    let s = reduceEnvelope(initialChatState, userMsg("c1"));
    s = reduceEnvelope(s, delta("c1", 1, "好的，"));
    s = reduceEnvelope(s, delta("c1", 2, "客厅灯"));
    s = reduceEnvelope(s, delta("c1", 3, "已调到30%。"));
    const assistants = s.items.filter((i) => i.kind === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: "好的，客厅灯已调到30%。", streaming: true });
  });

  it("乐观插入 + 服务端回声按 id 去重", () => {
    let s = appendLocalUser(initialChatState, "c9", "开灯");
    s = reduceEnvelope(s, userMsg("c9"));
    expect(s.items).toHaveLength(1);
  });

  it("工具结果按 id 回填，并发乱序不错位", () => {
    let s: typeof initialChatState = initialChatState;
    s = reduceEnvelope(s, { v: 1, type: "tool.start", id: "t1", session_id: "s1", log_seq: 2, payload: { tool: "a", args: {} } });
    s = reduceEnvelope(s, { v: 1, type: "tool.start", id: "t2", session_id: "s1", log_seq: 3, payload: { tool: "b", args: {} } });
    s = reduceEnvelope(s, { v: 1, type: "tool.result", id: "t2", session_id: "s1", log_seq: 4, payload: { ok: false, elapsed_ms: 310 } });
    expect(s.items.find((i) => i.id === "t2")).toMatchObject({ ok: false, elapsedMs: 310 });
    expect(s.items.find((i) => i.id === "t1")?.kind === "tool" && (s.items.find((i) => i.id === "t1") as { ok?: boolean }).ok).toBeUndefined();
  });

  it("last_seq 取最大值，重连游标不回退", () => {
    let s = reduceEnvelope(initialChatState, delta("c1", 1, "a", false, 10));
    s = reduceEnvelope(s, delta("c1", 2, "b", false, 7));
    expect(s.lastLogSeq).toBe(10);
  });

  it("error 帧保持已输出文本并结束流式", () => {
    let s = reduceEnvelope(initialChatState, userMsg("c1"));
    s = reduceEnvelope(s, delta("c1", 1, "已经说了一部分"));
    s = reduceEnvelope(s, { v: 1, type: "error", id: "e1", session_id: "s1", log_seq: 3, payload: { code: "UPSTREAM_TIMEOUT", message: "模型响应超时", retryable: true } });
    const a = s.items.find((i) => i.kind === "assistant");
    expect(a).toMatchObject({ streaming: false, error: "模型响应超时", text: "已经说了一部分" });
  });

  it("停止生成收尾流式态", () => {
    let s = reduceEnvelope(initialChatState, userMsg("c1"));
    s = reduceEnvelope(s, delta("c1", 1, "半句"));
    s = markStopped(s);
    expect(s.activeReplyId).toBeNull();
  });
});