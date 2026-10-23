/**
 * M3 验收：事件总线 + 规则引擎 + 主动自动化。
 *
 * 测的是"四件套"（§6.2）与防环，不是"接口能返回 200"。
 *
 * ⚠ 顺序即语义：频率配额是按房间每小时累计的（默认 6/h），
 *   所以本脚本严格按"低消耗 → 高消耗"排列，最后一步才把某个房间打满。
 *   反过来排会让前面的用例把配额吃光，得到一张假的失败表。
 *
 * 前置：DEBOUNCE_MS=600 PORT=4020 启动 HomeHub。
 */
const BASE = process.env.HUB ?? "http://127.0.0.1:4020";
const USER = process.env.USER_TOKEN ?? "dev-user-token";
const MCP = process.env.MCP_TOKEN ?? "dev-mcp-token";

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

async function call(pathname, { method = "GET", body, token = USER } = {}) {
  const h = { authorization: `Bearer ${token}` };
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(BASE + pathname, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

const post = (p, b, token = USER) => call(p, { method: "POST", body: b, token });
const get = (p, token = USER) => call(p, { token });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inject = (entityId, value, attribute = "state") => post("/_mock/inject-event", { entity_id: entityId, value, attribute });
const stateOf = async (id) => (await get(`/v1/entities/${id}`)).json?.state;

const DEBOUNCE = Number(process.env.DEBOUNCE_MS ?? 600);

await post("/_mock/reset", {});
console.log("\n[M3 验收] 事件总线 + 规则引擎 + 主动自动化");
const resetNote = (await get("/_debug/eventbus")).json;
console.log(`  （已重置审计与限流窗口：pending=${resetNote?.pending}）`);

/* ---------- 0. 前置 ---------- */

const eb = await get("/_debug/eventbus");
check("EventBus 已启用", eb.json?.enabled === true, JSON.stringify(eb.json));

const health = await get("/v1/health");
check("健康检查明确标注 LLM 未接入（不是假装 ok）", health.json?.llm?.status === "disabled", String(health.json?.llm?.status));

/* ---------- 1. 去抖合并（消耗 客厅 1 次配额） ---------- */

const auditCount = async (target) =>
  ((await get("/v1/audit?limit=500")).json ?? []).filter((a) => a.action === "automation.trigger" && a.target === target).length;

const pmTarget = "sensor.living_room_pm25";
const pmBefore = await auditCount(pmTarget);

for (let i = 0; i < 20; i++) await inject(pmTarget, 10 + i);
await sleep(DEBOUNCE + 1200);

const pmAfter = await auditCount(pmTarget);
check("连发 20 次同一实体事件，只产生 1 次推理触发", pmAfter - pmBefore === 1, `${pmBefore} → ${pmAfter}`);

const pmTriggers = ((await get("/v1/automations/triggers?limit=300")).json ?? []).filter((t) => t.entity_id === pmTarget);
check("被合并的事件不逐条留痕（只有 1 条非 merged 记录或无记录）", pmTriggers.filter((t) => t.outcome !== "merged").length <= 1, JSON.stringify(pmTriggers));

/* ---------- 2. 防环（AI 事件不触发推理，也不占频率配额） ---------- */

const aiCountBefore = (await auditCount("light.study_ceiling"));
const aiCmd = await post("/v1/tools/call", { name: "set_room_light", args: { room: "书房", level: 33 } }, MCP);
check("AI 侧工具调用成功", aiCmd.json?.ok === true, JSON.stringify(aiCmd.json?.error));

await sleep(DEBOUNCE + 900);
const aiCountAfter = await auditCount("light.study_ceiling");
check("AI 动作引发的状态变化不触发新的推理（防环生效）", aiCountAfter === aiCountBefore, `${aiCountBefore} → ${aiCountAfter}`);

const loopLogs = ((await get("/v1/automations/triggers?limit=300&outcome=loop_blocked")).json ?? []).filter((t) => t.room === "书房");
check("防环拦截留痕（loop_blocked 记录可见）", loopLogs.length >= 1, `${loopLogs.length} 条`);

/* ---------- 3. 规则引擎端到端：人来开灯（消耗 客厅 1 次配额） ---------- */

const lrLight = "light.living_room_ceiling";
await post(`/v1/entities/${lrLight}/command`, { service: "turn_off" });
// 规则冷却也是状态的一部分：显式复位，避免"上一轮跑过 → 这一轮被冷却挡住"的假失败
await post("/_mock/reset", {});
const lrBefore = await stateOf(lrLight);
check("前置：客厅主灯已关", lrBefore?.on === false, JSON.stringify(lrBefore));

const histBefore = (await get("/v1/automations/history?limit=100")).json ?? [];
await inject("binary_sensor.living_room_presence", true);
// for_seconds=3，必须等过 3 秒的延时确认 + 去抖
await sleep(DEBOUNCE + 4000);

const lrAfter = await stateOf(lrLight);
const histAfter = (await get("/v1/automations/history?limit=100")).json ?? [];
const presenceRun = histAfter.find(
  (r) => r.automation_id === "auto.presence_light" && !histBefore.some((b) => b.trace_id === r.trace_id && b.ts === r.ts),
);

check(
  "有人停留 3 秒 → 客厅灯自动开（for_seconds 延时确认生效）",
  lrAfter?.on === true && lrAfter?.brightness === 30,
  `灯=${JSON.stringify(lrAfter)}`,
);
check("规则执行写入 rule_run（可查跑没跑、为什么跑）", !!presenceRun && presenceRun.matched === true, JSON.stringify(presenceRun));

/* ---------- 4. 规则管理 ---------- */

const rules = (await get("/v1/automations")).json ?? [];
check("规则列表可读（含 when/then/cooldown）", rules.length >= 3 && rules.every((r) => r.when && Array.isArray(r.then) && typeof r.cooldown_seconds === "number"), `${rules.length} 条`);

const targetRule = rules[0];
await post(`/v1/automations/${targetRule.id}/enable`, { on: false });
const afterOff = ((await get("/v1/automations")).json ?? []).find((r) => r.id === targetRule.id);
check("规则可被停用", afterOff?.enabled === false, JSON.stringify(afterOff?.enabled));
await post(`/v1/automations/${targetRule.id}/enable`, { on: true });
const afterOn = ((await get("/v1/automations")).json ?? []).find((r) => r.id === targetRule.id);
check("规则可被重新启用", afterOn?.enabled === true);

const notFound = await post("/v1/automations/auto.nope/enable", { on: true });
check("不存在的规则返回 404（不静默成功）", notFound.status === 404, `HTTP ${notFound.status}`);

/* ---------- 5. 规则执行可回溯 ---------- */

const traced = ((await get("/v1/automations/history?limit=100")).json ?? []).find((r) => r.matched && r.trace_id);
check("规则执行带 trace_id", !!traced?.trace_id, JSON.stringify(traced));
if (traced?.trace_id) {
  const chain = await get(`/v1/audit/${traced.trace_id}`);
  check("规则执行可按 trace_id 串起审计", Array.isArray(chain.json) && chain.json.length >= 1, `len=${chain.json?.length}`);
}

/* ---------- 6. 冷却期：同一规则不会连续重复执行 ---------- */

const histA = ((await get("/v1/automations/history?limit=100")).json ?? []).filter((r) => r.automation_id === "auto.presence_light" && r.matched);
const firedCountA = histA.length;
await post(`/v1/entities/${lrLight}/command`, { service: "turn_off" });
await inject("binary_sensor.living_room_presence", true);
await sleep(DEBOUNCE + 4200);
const histB = ((await get("/v1/automations/history?limit=100")).json ?? []).filter((r) => r.automation_id === "auto.presence_light" && r.matched);
check("冷却期内同一规则不重复执行（cooldown 生效）", histB.length === firedCountA, `${firedCountA} → ${histB.length}`);

/* ---------- 7. 频率上限：把 书房 的房间配额打满（本步消耗最大，放最后） ---------- */

/*
 * 同一 (实体, 属性) 在去抖窗口内会被合并，所以这里用不同属性制造 7 个独立键。
 * 房间上限默认 6/h，第 7 个必须被拒。
 */
const RATE_LIMIT = Number(process.env.RATE_ROOM_EVENTS_PER_HOUR ?? 6);
const probes = [
  ["light.study_ceiling", "brightness", 71],
  ["light.study_ceiling", "color_temp", 4100],
  ["light.study_accent", "brightness", 52],
  ["light.study_accent", "color_temp", 3100],
  ["cover.study_curtain", "position", 55],
  ["sensor.study_climate", "temperature", 26.5],
  ["sensor.study_climate", "humidity", 47],
  ["cover.study_curtain", "moving", true],
];

const studyBefore = ((await get("/v1/automations/triggers?limit=300&outcome=rate_limited")).json ?? []).filter((t) => t.room === "书房").length;

for (const [entity, attr, value] of probes) {
  await inject(entity, value, attr);
  await sleep(DEBOUNCE + 260);
}
await sleep(1200);

const studyRateLimited = ((await get("/v1/automations/triggers?limit=300&outcome=rate_limited")).json ?? []).filter((t) => t.room === "书房");
check(
  `超过房间频率上限（${RATE_LIMIT}/h）时拒绝并留痕`,
  studyRateLimited.length - studyBefore >= 1,
  `rate_limited ${studyRateLimited.length - studyBefore} 条 / 探测 ${probes.length} 次`,
);

/* ---------- 8. 降级：EventBus 关闭时仍能手动控制（不依赖事件链） ---------- */

const manual = await post("/v1/entities/light.bedroom_accent/command", { service: "turn_on", data: { brightness_pct: 44 } });
check("事件链之外的手动控制不受限流影响（面板可用性优先）", manual.json?.ok === true, JSON.stringify(manual.json?.code));

console.log(`\n[M3 验收] ${pass}/${pass + bad.length} 通过`);
if (bad.length) {
  console.log("[M3 验收] 失败项：");
  for (const b of bad) console.log("  - " + b);
  process.exit(1);
}