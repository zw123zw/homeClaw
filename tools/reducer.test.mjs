/**
 * 进程内测试运行器：本沙箱禁用了子进程（spawn EPERM），
 * 因此不用 node --test / vitest，直接 import 后跑断言。
 * 真实 CI 环境可换成 vitest，用例逻辑不变。
 */
import assert from "node:assert/strict";
import { initialChatState, reduceEnvelope, appendLocalUser, markStopped } from "../apps/web/src/chat/reducer.ts";

let pass = 0;
const failures = [];

function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

const userMsg = (id) => ({ v: 1, type: "user.message", id, session_id: "s1", ts: 1, log_seq: 1, payload: { text: "hi", attachments: [] } });
const delta = (replyTo, seq, text, done = false, logSeq = 2) => ({
  v: 1, type: "assistant.delta", id: "a" + seq, session_id: "s1", ts: 1,
  reply_to: replyTo, seq, log_seq: logSeq, payload: { text, done },
});

console.log("\n[reducer] 流式渲染核心逻辑");

test("分片合并进同一气泡，不产生多条消息", () => {
  let s = reduceEnvelope(initialChatState, userMsg("c1"));
  s = reduceEnvelope(s, delta("c1", 1, "好的，"));
  s = reduceEnvelope(s, delta("c1", 2, "客厅灯"));
  s = reduceEnvelope(s, delta("c1", 3, "已调到30%。"));
  const assistants = s.items.filter((i) => i.kind === "assistant");
  assert.equal(assistants.length, 1, "三次分片必须合并为一条");
  assert.equal(assistants[0].text, "好的，客厅灯已调到30%。");
  assert.equal(assistants[0].streaming, true);
  assert.equal(s.items.length, 2);
});

test("done 帧结束流式态并清空 activeReplyId", () => {
  let s = reduceEnvelope(initialChatState, userMsg("c1"));
  s = reduceEnvelope(s, delta("c1", 1, "abc"));
  assert.ok(s.activeReplyId);
  s = reduceEnvelope(s, delta("c1", 2, "", true));
  assert.equal(s.activeReplyId, null);
  assert.equal(s.items.filter((i) => i.kind === "assistant")[0].streaming, false);
});

test("乐观插入 + 服务端回声按 id 去重", () => {
  let s = appendLocalUser(initialChatState, "c9", "开灯");
  assert.equal(s.items.length, 1);
  s = reduceEnvelope(s, userMsg("c9"));
  assert.equal(s.items.length, 1, "回声不应重复插入");
});

test("工具卡片 start->result 两态，并发乱序不错位", () => {
  let s = initialChatState;
  s = reduceEnvelope(s, { v: 1, type: "tool.start", id: "t1", session_id: "s1", ts: 1, log_seq: 2, payload: { tool: "set_room_light", args: { room: "客厅" }, summary: "客厅灯 → 30%" } });
  s = reduceEnvelope(s, { v: 1, type: "tool.start", id: "t2", session_id: "s1", ts: 1, log_seq: 3, payload: { tool: "set_cover", args: { room: "卧室" } } });
  s = reduceEnvelope(s, { v: 1, type: "tool.result", id: "t2", session_id: "s1", log_seq: 4, payload: { ok: false, elapsed_ms: 310 } });
  assert.equal(s.items.find((i) => i.id === "t1").ok, undefined, "t1 仍在执行中");
  assert.equal(s.items.find((i) => i.id === "t2").ok, false, "t2 结果回填到自己那张卡");
  assert.equal(s.items.find((i) => i.id === "t2").elapsedMs, 310);
  s = reduceEnvelope(s, { v: 1, type: "tool.result", id: "t1", session_id: "s1", log_seq: 5, payload: { ok: true, elapsed_ms: 240 } });
  assert.equal(s.items.find((i) => i.id === "t1").ok, true);
});

test("last_seq 取最大值，重连游标不回退", () => {
  let s = reduceEnvelope(initialChatState, delta("c1", 1, "a", false, 10));
  s = reduceEnvelope(s, delta("c1", 2, "b", false, 7));
  assert.equal(s.lastLogSeq, 10);
});

test("error 帧终止流式且保留已输出文本", () => {
  let s = reduceEnvelope(initialChatState, userMsg("c1"));
  s = reduceEnvelope(s, delta("c1", 1, "已经说了一部分"));
  s = reduceEnvelope(s, { v: 1, type: "error", id: "e1", session_id: "s1", log_seq: 3, payload: { code: "UPSTREAM_TIMEOUT", message: "模型响应超时", retryable: true } });
  const a = s.items.find((i) => i.kind === "assistant");
  assert.equal(a.streaming, false);
  assert.equal(a.error, "模型响应超时");
  assert.equal(a.text, "已经说了一部分");
  assert.equal(s.activeReplyId, null);
});

test("停止生成收尾流式态", () => {
  let s = reduceEnvelope(initialChatState, userMsg("c1"));
  s = reduceEnvelope(s, delta("c1", 1, "半句"));
  s = markStopped(s);
  assert.equal(s.activeReplyId, null);
  assert.equal(s.items.find((i) => i.kind === "assistant").streaming, false);
});

test("未知类型不崩溃（前向兼容新信封）", () => {
  const s = reduceEnvelope(initialChatState, { v: 1, type: "future.thing", id: "x" });
  assert.equal(s.items.length, 0);
});

console.log(`\n结果: ${pass} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
