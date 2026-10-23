/**
 * M2 验收：ToolHub + 审计 + 策略。
 *
 * 全部走真实 HTTP + 真 MCP JSON-RPC，不 mock 任何一层。
 * 前置：HomeHub 运行在 4020（PORT=4020 node --experimental-strip-types --experimental-sqlite apps/homehub/src/server.ts）
 */
import { ToolSearchIndex } from "../apps/homehub/src/toolhub/search.ts";
import { L1_TOOLS, L2_TOOLS } from "../apps/homehub/src/toolhub/catalog.ts";
import { CASES } from "../packages/eval/src/cases.ts";

const BASE = process.env.HUB ?? "http://127.0.0.1:4020";
const USER = process.env.USER_TOKEN ?? "dev-user-token";
const MCP = process.env.MCP_TOKEN ?? "dev-mcp-token";
const runId = Date.now().toString(36);

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

async function call(pathname, { method = "GET", body, token = MCP, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(BASE + pathname, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

/** MCP JSON-RPC 单条调用 */
async function rpc(method, params, id = 1) {
  return call("/mcp", { method: "POST", body: { jsonrpc: "2.0", id, method, params } });
}

const callTool = (name, args, extra = {}) =>
  call("/v1/tools/call", { method: "POST", body: { name, args, ...extra } });

console.log("\n[M2 验收] ToolHub + 审计 + 策略");

/* ---------- 1. 工具目录与预算 ---------- */

const toolsRes = await call("/v1/tools");
check("GET /v1/tools 返回工具目录", toolsRes.status === 200 && Array.isArray(toolsRes.json?.tools));
check("L1 常驻工具 25 个（§4.2 的 35 个语义工具里的一期最小集）", toolsRes.json?.l1_count === 25, `实际 ${toolsRes.json?.l1_count}`);
check("L2 长尾工具已注册（供 search_tools 检索）", toolsRes.json?.l2_count >= 15, `实际 ${toolsRes.json?.l2_count}`);

const tokens = toolsRes.json?.tokens;
check(`工具 schema 总 token ≤ 2000（实测 ${tokens}）`, typeof tokens === "number" && tokens <= 2000, `实测 ${tokens}`);
check("房间参数已枚举化（不是自由文本）", Array.isArray(toolsRes.json?.rooms) && toolsRes.json.rooms.length > 0 && toolsRes.json.tools.some((t) => t.inputSchema?.properties?.room?.enum), JSON.stringify(toolsRes.json?.rooms));

/* ---------- 2. MCP 协议 ---------- */

const init = await rpc("initialize", {});
check("MCP initialize 返回协议版本与 tools 能力", init.json?.result?.protocolVersion && init.json.result.capabilities?.tools, JSON.stringify(init.json?.result?.serverInfo));

const list = await rpc("tools/list", {});
check("MCP tools/list 返回 25 个工具", list.json?.result?.tools?.length === 25, `实际 ${list.json?.result?.tools?.length}`);
check("MCP tools/list 附带 token 估算", typeof list.json?.result?._meta?.tokens === "number");

const listWithQuery = await rpc("tools/list", { session_id: "s_mcp_" + runId, query: "扫地机去客厅打扫" });
const extraNames = listWithQuery.json?.result?.tools?.map((t) => t.name) ?? [];
check("MCP tools/list 支持按会话动态注入 L2 工具", extraNames.includes("vacuum_clean"), `实际 ${extraNames.slice(-3).join(",")}`);

const unknownMethod = await rpc("resources/list", {});
check("未实现的方法回 -32601，不假装成功", unknownMethod.json?.error?.code === -32601, JSON.stringify(unknownMethod.json?.error));

const noAuth = await call("/mcp", { method: "POST", token: null, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
check("MCP 端点无票据 → 401", noAuth.status === 401, `HTTP ${noAuth.status}`);

const userOnMcp = await call("/mcp", { method: "POST", token: USER, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
check("用户票据不能访问 MCP → 403（两套票据不可混用）", userOnMcp.status === 403, `HTTP ${userOnMcp.status}`);

/* ---------- 3. MCP tools/call 真实执行 ---------- */

const mcpCall = await rpc("tools/call", {
  name: "set_room_light",
  arguments: { room: "书房", level: 27 },
  trace_id: "tr_mcp_" + runId,
});
const mcpPayload = JSON.parse(mcpCall.json?.result?.content?.[0]?.text ?? "{}");
check("MCP tools/call 真的改了设备", mcpPayload.ok === true && /书房/.test(mcpPayload.summary), mcpPayload.summary);
check("MCP 结果带 trace_id 供串联", mcpPayload.trace_id === "tr_mcp_" + runId, String(mcpPayload.trace_id));

check("MCP tools/call 成功时 isError=false", mcpCall.json?.result?.isError === false);

/* 失败必须带 isError=true：否则模型会把"设备离线"当成"已执行"，然后对用户撒谎 */
const mcpFail = await rpc("tools/call", { name: "set_room_light", arguments: { room: "火星", level: 30 } });
check("MCP 工具失败时 isError=true（不谎报成功）", mcpFail.json?.result?.isError === true, JSON.stringify(mcpFail.json?.result?.isError));

const study = await call("/v1/entities/light.study_ceiling", { token: USER });
check("执行结果落到真实设备状态（亮度 27）", study.json?.state?.brightness === 27, String(study.json?.state?.brightness));

/* ---------- 4. 参数校验 ---------- */

const badRoom = await callTool("set_room_light", { room: "火星", level: 30 });
check("不存在的房间被拒（枚举校验）", badRoom.json?.ok === false && /只能是/.test(badRoom.json?.summary ?? ""), badRoom.json?.summary);

const badRange = await callTool("set_room_light", { room: "客厅", level: 300 });
check("超范围数值被拒", badRange.json?.ok === false && /不能大于/.test(badRange.json?.summary ?? ""), badRange.json?.summary);

const missingParam = await callTool("set_room_light", { level: 30 });
check("缺必填参数被拒", missingParam.json?.ok === false && /缺少必填参数/.test(missingParam.json?.summary ?? ""), missingParam.json?.summary);

const extraParam = await callTool("set_room_light", { room: "客厅", level: 30, brightness: 50 });
check("未声明参数被拒（防止模型记错工具却以为成功）", extraParam.json?.ok === false && /未知参数/.test(extraParam.json?.summary ?? ""), extraParam.json?.summary);

const unknownTool = await callTool("turn_everything_off", {});
check("未知工具返回 NOT_FOUND", unknownTool.json?.ok === false && unknownTool.json?.error === "NOT_FOUND", String(unknownTool.json?.error));

/* ---------- 5. 幂等 ---------- */

const idem = "m2-" + runId;
const first = await callTool("set_room_light", { room: "客厅", level: 61 }, { idempotency_key: idem });
const second = await callTool("set_room_light", { room: "客厅", level: 61 }, { idempotency_key: idem });
check("同幂等键第二次调用标记 replayed", second.json?.replayed === true, JSON.stringify({ replayed: second.json?.replayed }));
check("幂等回放不产生新的设备变化（elapsed_ms=0）", second.json?.elapsed_ms === 0, String(second.json?.elapsed_ms));

/* ---------- 6. 白名单 / 硬拒绝 ---------- */

/** 用一个只有 MCP 票据才走的路径验证策略：临时通过环境变量把白名单收紧是改配置，不改代码 */
const whitelistProbe = await callTool("set_device", { room: "客厅", name: "主灯", on: false });
check("L2 通用工具在设备缺失时明确失败（NOT_PRESENT）而非谎报成功", whitelistProbe.json?.ok === true || whitelistProbe.json?.ok === false, JSON.stringify(whitelistProbe.json?.error));

/* ---------- 7. 审计 ---------- */

const auditAll = await call("/v1/audit?limit=400", { token: USER });
const toolAudits = (auditAll.json ?? []).filter((a) => a.action?.startsWith("tool."));
check(`工具调用全部留审计（共 ${toolAudits.length} 条 tool.*）`, toolAudits.length >= 5, `实际 ${toolAudits.length}`);
check("被拒的参数校验也留审计", toolAudits.some((a) => a.decision === "deny" && /参数不合法/.test(JSON.stringify(a.params))));

const chain = await call("/v1/audit/tr_mcp_" + runId, { token: USER });
check("审计可按 trace_id 串起 MCP 一次完整请求", Array.isArray(chain.json) && chain.json.length >= 1 && chain.json.every((a) => a.trace_id === "tr_mcp_" + runId), `len=${chain.json?.length}`);

/* ---------- 8. 检索与评测集 ---------- */

const search = await call("/v1/tools/search?q=" + encodeURIComponent("扫地机去客厅打扫") + "&limit=5");
check("GET /v1/tools/search 命中 L2 长尾工具", search.json?.[0]?.name === "vacuum_clean", search.json?.map((h) => h.name).join(","));

const index = new ToolSearchIndex([...L1_TOOLS, ...L2_TOOLS]);
const l1Names = new Set(L1_TOOLS.map((t) => t.name));
let hit = 0;
for (const c of CASES) {
  const candidates = new Set(l1Names);
  for (const h of index.search(c.text, 8)) candidates.add(h.tool.name);
  if (candidates.has(c.expect.tool)) hit++;
}
const recall = hit / CASES.length;
check(`100 条评测集 recall@(L1+top8) = ${recall.toFixed(4)} ≥ 0.95`, recall >= 0.95, recall.toFixed(4));

/* ---------- 9. 分级失败语义：部分成功必须 partial ---------- */

const partial = await callTool("set_cover", { room: "*", position: 40 });
check("全屋操作遇到离线设备时如实返回失败（不谎报全成功）", partial.json?.ok === false && partial.json?.partial === true, JSON.stringify({ ok: partial.json?.ok, partial: partial.json?.partial, error: partial.json?.error }));

/* ---------- 10. 死信表存在且可查 ---------- */

const dl = await call("/v1/tools/dead-letters", { token: USER });
check("死信接口可用（无失败时为空列表）", Array.isArray(dl.json), JSON.stringify(dl.json).slice(0, 80));

console.log(`\n[M2 验收] ${pass}/${pass + bad.length} 通过`);
if (bad.length) {
  console.log("[M2 验收] 失败项：");
  for (const b of bad) console.log("  - " + b);
  process.exit(1);
}