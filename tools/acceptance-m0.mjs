import http from "node:http";
const BASE = "http://127.0.0.1:4010";
const sid = "s_e2e_" + Date.now().toString(36);
let ok = 0, bad = [];
const check = (name, cond, extra = "") => {
  if (cond) { ok++; console.log(`  ✓ ${name}`); }
  else { bad.push(name); console.log(`  ✗ ${name} ${extra}`); }
};

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(BASE + path, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c)); res.on("end", () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    req.on("error", reject); req.write(data); req.end();
  });
}
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(JSON.parse(b))); }).on("error", reject);
  });
}
function collect(sessionId, lastSeq, ms) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.get(`${BASE}/v1/stream?session_id=${sessionId}&last_seq=${lastSeq}`, (res) => {
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk; let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (line) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
        }
      });
    });
    setTimeout(() => { req.destroy(); resolve(events); }, ms);
  });
}

console.log("\n[M0 验收] mock-server 端到端");

const health = await get("/v1/health");
check("GET /v1/health 三路状态齐全", health.ok && health.adapter && health.llm && health.gateway);

const ents = await get("/v1/entities");
check("设备面板可拿到 12 个 Mock 实体", ents.length === 12, `实际 ${ents.length}`);
check("其中 1 个为离线态", ents.filter((e) => !e.available).length === 1);

const offline = ents.find((e) => !e.available);
const offlineRes = await post(`/v1/entities/${offline.id}/command`, { service: "open_cover", data: {} });
check("离线设备返回明确错误而非静默失败", offlineRes.status === 503 && offlineRes.body.code === "UNAVAILABLE", `HTTP ${offlineRes.status}`);

const before = await get("/v1/entities/light.living_room_ceiling");
const idemKey = "idem-" + Date.now().toString(36);
const cmd1 = await post("/v1/entities/light.living_room_ceiling/command", { service: "set_brightness", data: { brightness_pct: 30 }, idempotency_key: idemKey });
const after = await get("/v1/entities/light.living_room_ceiling");
check("手动控制改变状态", cmd1.body.ok && after.state.brightness === 30, `brightness ${after.state.brightness}`);
check("状态变化可被面板读到", before.state.brightness !== after.state.brightness || after.state.brightness === 30);

const cmd2 = await post("/v1/entities/light.living_room_ceiling/command", { service: "turn_off", data: {}, idempotency_key: idemKey });
const after2 = await get("/v1/entities/light.living_room_ceiling");
check("幂等键重复提交不重复执行", cmd2.body.ok && after2.state.on === true, "第二次 turn_off 必须被幂等命中");

const audit = await get("/v1/audit");
check("手动操作全部留审计", audit.length >= 3, `audit=${audit.length}`);
check("审计含 trace_id 可串联", audit.every((a) => typeof a.trace_id === "string" && a.trace_id.startsWith("tr_")));
check("幂等命中留痕为 idempotent_replay", audit.some((a) => a.reason === "idempotent_replay"));
check("审计可按 trace_id 串起一次完整请求", (() => {
  const tr = audit[0].trace_id;
  return audit.filter((a) => a.trace_id === tr).length >= 1;
})());

const scenes = await get("/v1/scenes");
const sceneRun = await post(`/v1/scenes/${scenes[0].id}/run`, {});
check("场景页可执行且有结果反馈", sceneRun.body.results.length === scenes[0].actions.length);
check("场景结果含逐动作状态", sceneRun.body.results.every((r) => typeof r.ok === "boolean"));

// --- 流式：连续 20 轮 ---
console.log("\n[M0 验收] 流式对话与断线补齐");
const streamP = collect(sid, 0, 20_000);
await new Promise((r) => setTimeout(r, 300));

const t0 = Date.now();
for (let i = 1; i <= 20; i++) {
  await post("/v1/chat/message", { session_id: sid, text: `第${i}轮：把客厅灯调到30%` });
}
const events = await streamP;
const deltas = events.filter((e) => e.type === "assistant.delta");
const userEchoes = events.filter((e) => e.type === "user.message");
const toolStarts = events.filter((e) => e.type === "tool.start");
const toolResults = events.filter((e) => e.type === "tool.result");

check("20 轮全部被服务端接收", userEchoes.length === 20, `实际 ${userEchoes.length}`);
check("每轮都有流式分片", deltas.length > 20, `deltas=${deltas.length}`);
check("每轮都有 done 帧", deltas.filter((d) => d.payload.done).length === 20, `done=${deltas.filter((d) => d.payload.done).length}`);
check("工具卡片 start/result 成对", toolStarts.length === 20 && toolResults.length === 20, `start=${toolStarts.length} result=${toolResults.length}`);
check("tool.result 复用 tool.start 的 id（卡片不错位）",
  toolStarts.every((s, i) => s.id === toolResults[i]?.id));

// session.ready 是建连握手帧，不进事件日志，因此不带 log_seq
const logged = events.filter((e) => e.type !== "session.ready");
const logSeqs = logged.map((e) => e.log_seq).filter((n) => typeof n === "number");
check("服务端事件全部带 log_seq（握手帧除外）", logSeqs.length === logged.length, `${logSeqs.length}/${logged.length}`);
check("log_seq 严格单调递增", logSeqs.every((n, i) => i === 0 || n > logSeqs[i - 1]));

// 断线补齐：带 last_seq 重连，只应补到缺口之后
const cursor = Math.floor(logSeqs[logSeqs.length - 1] / 2);
const replay = await collect(sid, cursor, 1200);
const replayEnvs = replay.filter((e) => e.type !== "session.ready");
const replayedSeq = replayEnvs.map((e) => e.log_seq);
check("重连时按 last_seq 补齐缺口", replayEnvs.length > 0 && replayedSeq.every((n) => n > cursor),
  `cursor=${cursor} 补 ${replayEnvs.length} 帧, min=${Math.min(...replayedSeq)}`);
check("补齐不重复下发已收到的帧", !replayedSeq.includes(cursor));
check("重连先收到 session.ready", replay[0]?.type === "session.ready");
check("session.ready 携带服务端 last_seq", typeof replay[0]?.payload.last_seq === "number");

const msgs = await get(`/v1/sessions/${sid}/messages?limit=500`);
check("消息已持久化可回溯", msgs.length >= 40, `messages=${msgs.length}`);
check("消息 seq 单调递增", msgs.every((m, i) => i === 0 || m.seq > msgs[i - 1].seq));

const afterPage = await get(`/v1/sessions/${sid}/messages?after=10&limit=5`);
check("messages?after= 支持增量拉取", afterPage.length === 5 && afterPage.every((m) => m.seq > 10));

const badReq = await post("/v1/chat/message", { text: "no session" });
check("缺失 session_id 返回 400", badReq.status === 400 && badReq.body.code === "BAD_REQUEST");

console.log(`\n结果: ${ok} passed, ${bad.length} failed, 用时 ${Date.now() - t0}ms`);
if (bad.length) { console.log("失败项:", bad.join(", ")); process.exit(1); }
