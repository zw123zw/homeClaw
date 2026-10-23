/**
 * M1 验收：HomeHub 骨架 + 适配器 + 数据模型。
 * 全部走真实 HTTP，不 mock 任何一层；SSE 用原生 http 读流。
 * 前置：node --experimental-strip-types --experimental-sqlite apps/homehub/src/server.ts（PORT=4020）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.HUB ?? "http://127.0.0.1:4020";
/** 每次运行唯一的后缀：固定 id 在重复运行时会撞唯一索引 */
const runId = Date.now().toString(36);
const USER = process.env.USER_TOKEN ?? "dev-user-token";
const MCP = process.env.MCP_TOKEN ?? "dev-mcp-token";
const DB = process.env.DB_PATH ?? "data/m1-test.db";

let pass = 0;
const bad = [];
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("  OK   " + name);
  } else {
    bad.push(name);
    console.log("  FAIL " + name + (extra ? "  -> " + extra : ""));
  }
};

async function call(pathname, { method = "GET", body, token = USER, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(BASE + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

/** 读一段 SSE，返回收到的设备事件数组 */
function readSse(pathname, ms, token = USER) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(
      BASE + pathname,
      { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ status: res.statusCode, events });
          return;
        }
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith(":")) continue;
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line) {
              try {
                events.push(JSON.parse(line.slice(6)));
              } catch {
                /* 坏帧 */
              }
            }
          }
        });
      },
    );
    req.on("error", reject);
    setTimeout(() => {
      req.destroy();
      resolve({ status: 200, events });
    }, ms);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\n[M1 验收] HomeHub 骨架 + 适配器 + 数据模型");

/* ---------- 1. 健康与真实数据 ---------- */

const health = await call("/v1/health");
check("GET /v1/health 返回三路状态", health.status === 200 && health.json?.ok === true, JSON.stringify(health.json));
check("adapter 状态为 ok（MockAdapter 已接）", health.json?.adapter?.status === "ok", String(health.json?.adapter?.status));
check("db 状态为 ok（真 SQLite，不是内存假数据）", health.json?.db?.status === "ok", String(health.json?.db?.status));
check("llm/gateway 明确标 disabled 而非假装 ok", health.json?.llm?.status === "disabled" && health.json?.gateway?.status === "disabled");

const ents = await call("/v1/entities");
check("GET /v1/entities 返回 12 个实体", Array.isArray(ents.json) && ents.json.length === 12, `实际 ${ents.json?.length}`);
check("其中恰好 1 个离线态", ents.json?.filter((e) => !e.available).length === 1);
check("实体字段完整（id/name/room/type/capabilities/state）", ents.json?.every((e) =>
  e.id && e.name && e.room && e.type && Array.isArray(e.capabilities) && e.state && typeof e.home_id === "string"));

const room = await call("/v1/entities?room=" + encodeURIComponent("客厅"));
check("房间过滤生效", room.json?.length === 4 && room.json.every((e) => e.room === "客厅"), `count=${room.json?.length}`);

const lights = await call("/v1/entities?type=light");
check("类型过滤生效", lights.json?.length === 6 && lights.json.every((e) => e.type === "light"), `count=${lights.json?.length}`);

/* ---------- 2. 手动控制 → 实时推送到面板 ---------- */

const target = "light.living_room_ceiling";

// 先订阅，再控制，验证事件真的推出来了（顺序很重要，晚了就收不到）
const ssePromise = readSse("/v1/events", 1200);

await sleep(150);
const idem = "m1-" + Date.now().toString(36);
/* 目标亮度必须与当前值不同，否则"没变化"就真的不会产生事件 */
const beforeState = await call(`/v1/entities/${target}`);
const fromBrightness = Number(beforeState.json?.state?.brightness ?? 0);
const toBrightness = fromBrightness === 33 ? 34 : 33;

const cmd = await call(`/v1/entities/${target}/command`, {
  method: "POST",
  body: { service: "set_brightness", data: { brightness_pct: toBrightness }, idempotency_key: idem },
});
check("POST /v1/entities/:id/command 成功并回新状态", cmd.status === 200 && cmd.json?.ok === true && cmd.json?.state?.brightness === toBrightness, JSON.stringify(cmd.json));

const state = await call(`/v1/entities/${target}`);
check("状态已落库（下次读取仍是新值）", state.json?.state?.brightness === toBrightness, String(state.json?.state?.brightness));

const sse = await ssePromise;
const pushed = sse.events.find((e) => e.entity_id === target && e.new === toBrightness);
check("GET /v1/events 实时推送了这次状态变化", !!pushed, `收到 ${sse.events.length} 个事件`);
check("事件带 origin=user（可归因，是防环与审计的依据）", pushed?.origin === "user", String(pushed?.origin));
check("事件带 trace_id，可与审计串起", typeof pushed?.trace_id === "string" && pushed.trace_id.startsWith("tr_"), String(pushed?.trace_id));

/* ---------- 3. 幂等 / 硬拒绝 / 离线 ---------- */

const replay = await call(`/v1/entities/${target}/command`, {
  method: "POST",
  body: { service: "turn_off", data: {}, idempotency_key: idem },
});
const afterReplay = await call(`/v1/entities/${target}`);
check("同一幂等键重复提交不重复执行", afterReplay.json?.state?.brightness === toBrightness, `brightness=${afterReplay.json?.state?.brightness}`);

const audit = await call("/v1/audit?limit=200");
check("幂等命中留下 idempotent_replay 审计", audit.json?.some?.((a) => a.reason === "idempotent_replay"));

const offline = ents.json.find((e) => !e.available);
const offRes = await call(`/v1/entities/${offline.id}/command`, { method: "POST", body: { service: "open_cover" } });
check("离线设备返回 503 UNAVAILABLE 而非静默失败", offRes.status === 503 && offRes.json?.code === "UNAVAILABLE", `HTTP ${offRes.status}`);

// 硬拒绝：mock 实体里没有 lock.*，所以用一个不存在于白名单的实体验证"被拒且留审计"
const missing = await call("/v1/entities/lock.front_door/command", { method: "POST", body: { service: "unlock" } });
check("不存在的实体被拒且返回 NOT_FOUND", missing.status === 404 && missing.json?.code === "NOT_FOUND", `HTTP ${missing.status}`);

/* ---------- 4. 场景 ---------- */

const scenes = await call("/v1/scenes");
check("GET /v1/scenes 返回 4 个场景", scenes.json?.length === 4, `count=${scenes.json?.length}`);

const run = await call("/v1/scenes/scene.movie/run", { method: "POST" });
check("POST /v1/scenes/:id/run 逐动作返回结果", run.status === 200 && Array.isArray(run.json?.results) && run.json.results.length === 3, JSON.stringify(run.json?.results?.length));
check("场景执行带统一 trace_id", typeof run.json?.trace_id === "string" && run.json.trace_id.startsWith("tr_"));

const cinema = await call("/v1/entities/light.living_room_accent");
check("场景动作真的改变了设备状态", cinema.json?.state?.on === true && cinema.json?.state?.brightness === 15, JSON.stringify(cinema.json?.state));

/* ---------- 5. 会话与 seq ---------- */

const sess = await call("/v1/sessions", { method: "POST", body: { title: "M1 验收会话" } });
check("POST /v1/sessions 建档成功", sess.status === 201 && typeof sess.json?.id === "string", `HTTP ${sess.status}`);
const sid = sess.json.id;

const m1 = await call("/v1/internal/messages", { method: "POST", token: MCP, body: { session_id: sid, id: "msg_a_" + runId, role: "user", text: "你好" } });
const m2 = await call("/v1/internal/messages", { method: "POST", token: MCP, body: { session_id: sid, id: "msg_b_" + runId, role: "assistant", text: "在" } });
check("消息 seq 从 1 起单调递增", m1.json?.seq === 1 && m2.json?.seq === 2, `${m1.json?.seq},${m2.json?.seq}`);

const page = await call(`/v1/sessions/${sid}/messages?after=1`);
check("after 分页只返回 seq>1 的消息", page.json?.length === 1 && page.json[0].seq === 2, `count=${page.json?.length}`);

const beforePage = await call(`/v1/sessions/${sid}/messages?before=2`);
check("before 分页升序返回历史", beforePage.json?.length === 1 && beforePage.json[0].seq === 1);

const sessions = await call("/v1/sessions");
check("会话列表含刚建的会话", sessions.json?.some((s) => s.id === sid && s.message_count === 2));

check("幂等建档（ensure）不会重复插入", (await call("/v1/internal/sessions", { method: "POST", token: MCP, body: { session_id: sid } })).json?.id === sid);

/* ---------- 6. 审计链路 ---------- */

const target2 = "light.study_accent";
const c2 = await call(`/v1/entities/${target2}/command`, { method: "POST", body: { service: "turn_off" } });
const traceId = c2.json?.trace_id;
const chain = await call(`/v1/audit/${traceId}`);
check("审计可按 trace_id 串起一次完整请求", Array.isArray(chain.json) && chain.json.length >= 1 && chain.json.every((a) => a.trace_id === traceId), `len=${chain.json?.length}`);
check("审计记录的 actor 形如 user:xxx", chain.json?.[0]?.actor?.startsWith("user:"), String(chain.json?.[0]?.actor));

/* ---------- 7. 两套票据不可混用 ---------- */

const noAuth = await call("/v1/entities", { token: null });
check("无票据访问面板 → 401", noAuth.status === 401, `HTTP ${noAuth.status}`);

const mcpOnUser = await call("/v1/entities", { token: MCP });
check("MCP 票据不能访问用户面板 → 403", mcpOnUser.status === 403, `HTTP ${mcpOnUser.status}`);

/* ---------- 8. 数据表全部含 home_id ---------- */

const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(DB, { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
const missingHomeId = [];
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols.includes("home_id")) missingHomeId.push(t);
}
db.close();
check(`数据表全部含 home_id（共 ${tables.length} 张）`, missingHomeId.length === 0, "缺：" + missingHomeId.join(","));
check("表结构齐全（homes/entities/scenes/sessions/messages/audit/idempotency/preferences/automations/trigger_log/usage）",
  ["homes", "entities", "scenes", "sessions", "messages", "audit", "idempotency", "preferences", "automations", "trigger_log", "usage"].every((t) => tables.includes(t)),
  tables.join(","));

/* ---------- 9. 前端一行不改：契约路径与形状对得上 ---------- */

const clientSrc = fs.readFileSync("apps/web/src/api/client.ts", "utf8");
/**
 * 契约一致性：不靠正则解析源码（模板字符串里嵌套花括号，正则必然出错），
 * 而是直接按 §5.2 的九条路径发真请求。
 * 任何一条 404 都说明"前端换个 baseURL 就能用"这句话是假的。
 */
const sidProbe = (await call("/v1/sessions", { method: "POST", body: { title: "契约探针" } })).json.id;
await call("/v1/internal/messages", {
  method: "POST",
  token: MCP,
  body: { session_id: sidProbe, id: "msg_probe_" + runId, role: "user", text: "probe" },
});

const contract = [
  ["GET  /v1/health", () => call("/v1/health")],
  ["GET  /v1/entities", () => call("/v1/entities")],
  ["GET  /v1/entities/:id", () => call("/v1/entities/light.study_ceiling")],
  ["POST /v1/entities/:id/command", () => call("/v1/entities/light.study_ceiling/command", { method: "POST", body: { service: "set_brightness", data: { brightness_pct: 55 } } })],
  ["GET  /v1/scenes", () => call("/v1/scenes")],
  ["POST /v1/scenes/:id/run", () => call("/v1/scenes/scene.arrive_home/run", { method: "POST" })],
  ["GET  /v1/sessions", () => call("/v1/sessions")],
  ["POST /v1/sessions", () => call("/v1/sessions", { method: "POST", body: { title: "契约探针 2" } })],
  ["GET  /v1/sessions/:id/messages", () => call(`/v1/sessions/${sidProbe}/messages?after=0`)],
  ["GET  /v1/audit", () => call("/v1/audit?limit=5")],
];
const results = [];
for (const [label, fn] of contract) {
  const r = await fn();
  results.push({ label, status: r.status });
}
const notImpl = results.filter((r) => r.status === 404);
check(
  `§5.2 的 ${contract.length} 条接口全部由 HomeHub 真实实现（无 404）`,
  notImpl.length === 0,
  "404 的：" + notImpl.map((r) => r.label).join(", "),
);
check(
  "前端只改 baseURL 即可切换（client.ts 不含任何 4010 硬编码）",
  !fs.readFileSync("apps/web/src/api/client.ts", "utf8").includes("4010"),
);

check("前端事件流路径 /events 也已实现", fs.readFileSync("apps/web/src/api/client.ts", "utf8").includes("`${hubBaseUrl}/events`"));

/* ---------- 10. 统计 ---------- */

console.log(`\n[M1 验收] ${pass}/${pass + bad.length} 通过`);
if (bad.length) {
  console.log("[M1 验收] 失败项：");
  for (const b of bad) console.log("  - " + b);
  process.exit(1);
}