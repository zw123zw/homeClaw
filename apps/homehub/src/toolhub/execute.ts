import type { Entity, Origin, Scene } from "@homeclaw/contracts";
import type { CommandOutcome } from "../command.ts";
import type { ToolSpec } from "./spec.ts";

/**
 * 工具执行上下文。
 *
 * 故意不用 HomeRuntime 全量类型：执行器只需要"能读实体、能下命令、能读场景"三件事。
 * 接口窄 → 可以用 7 行假实现做单元测试，不必起 SQLite 与 Fastify。
 */
export type ToolContext = {
  homeId: string;
  rooms: () => string[];
  listEntities: () => Promise<Entity[]>;
  command: (input: {
    entityId: string;
    service: string;
    data?: Record<string, unknown>;
    origin: Origin;
    actor: string;
    traceId: string;
    idempotencyKey?: string;
  }) => Promise<CommandOutcome>;
  scenes: () => Scene[];
  /** 自动化规则（一期从 automations 表读） */
  automations: () => Array<{ id: string; enabled: boolean; when: unknown; then: unknown }>;
  setAutomationEnabled: (id: string, on: boolean) => boolean;
  /** 传感器历史（trigger_log） */
  sensorHistory: (q: { room?: string; since: number; limit: number }) => Array<{ entity_id: string; ts: number; outcome: string }>;
  /** 检索器，供 search_tools / call_tool 使用 */
  search: (query: string, limit: number) => Array<{ tool: ToolSpec; score: number }>;
  callTool: (name: string, args: Record<string, unknown>, traceId: string) => Promise<ToolResult>;
  now: () => number;
};

/** 工具结果：summary 是给模型看的一句话，data 是结构化明细 */
export type ToolResult = {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
  /** 部分成功（全屋操作里某几个离线）时为 true，调用方要据此告诉用户 */
  partial?: boolean;
  trace_id?: string;
};

const ok = (summary: string, data?: unknown, traceId?: string): ToolResult => ({
  ok: true,
  summary,
  data,
  trace_id: traceId,
});
const fail = (summary: string, error: string, extra: Partial<ToolResult> = {}): ToolResult => ({
  ok: false,
  summary,
  error,
  ...extra,
});

const isOn = (e: Entity) => e.state.on === true;

function roomLabel(room: string): string {
  return room === "*" ? "全屋" : room;
}

/** 把 CommandOutcome 翻译成工具结果：错误码必须原样传出去，不能被"操作失败"抹平 */
function fromOutcome(outcome: CommandOutcome, entity: Entity, what: string): ToolResult {
  if (outcome.ok) return ok(`${entity.name}：${what}`, { state: outcome.state, entity_id: entity.id }, outcome.traceId);
  return {
    ok: false,
    summary: `${entity.name} ${what}失败：${outcome.message}`,
    error: outcome.code,
    trace_id: outcome.traceId,
  };
}

/**
 * 一次工具调用可能要改多个实体（全屋灯、场景）。
 * 这里统一收集：全部成功 → ok；部分失败 → partial=true 且逐条报错，绝不谎报成功。
 */
/**
 * 批量操作的结果合并。
 * traceId 必须显式透传：多设备操作后只剩"摘要文本"就再也回不到审计，
 * 而多设备场景恰恰最需要事后追"到底是哪一台没动"。
 */
async function fanOut(
  targets: Entity[],
  run: (e: Entity) => Promise<ToolResult>,
  traceId: string,
): Promise<ToolResult> {
  const results: Array<{ entity: string; ok: boolean; summary: string; error?: string; trace_id?: string }> = [];
  for (const e of targets) {
    const r = await run(e);
    results.push({ entity: e.id, ok: r.ok, summary: r.summary, error: r.error, trace_id: r.trace_id });
  }
  const failed = results.filter((r) => !r.ok);
  const summaries = results.map((r) => r.summary).join("；");
  if (failed.length === 0) return { ok: true, summary: summaries, data: { results }, trace_id: traceId };
  return {
    ok: false,
    partial: failed.length < results.length,
    summary: summaries,
    error: failed.map((f) => `${f.entity}:${f.error}`).join(","),
    data: { results },
    trace_id: traceId,
  };
}

export type HandlerMap = Record<string, (args: Record<string, unknown>, ctx: ToolContext, traceId: string, spec: ToolSpec) => Promise<ToolResult>>;

const findInRoom = (list: Entity[], room: string, type: Entity["type"]): Entity[] =>
  list.filter((e) => e.type === type && (room === "*" || e.room === room));

export const HANDLERS: HandlerMap = {
  /* ---------------- 灯 ---------------- */

  "light.set": async (args, ctx, traceId) => {
    const room = String(args.room ?? "*");
    const level = args.level === undefined ? undefined : Number(args.level);
    const colorTemp = args.color_temp === undefined ? undefined : Number(args.color_temp);

    const lights = findInRoom(await ctx.listEntities(), room, "light");
    if (lights.length === 0) {
      return fail(`${roomLabel(room)}没有可控的灯`, "NOT_PRESENT");
    }

    return fanOut(lights, async (e) => {
      // level=0 必须走 turn_off：只把亮度设 0 会留下"开着但看不见"的矛盾状态
      if (level === 0) {
        return fromOutcome(
          await ctx.command({ entityId: e.id, service: "turn_off", origin: "ai", actor: "ai:hermes", traceId }),
          e, "已关闭",
        );
      }

      if (level !== undefined) {
        const data: Record<string, unknown> = { brightness_pct: level };
        const r = await ctx.command({ entityId: e.id, service: "turn_on", data, origin: "ai", actor: "ai:hermes", traceId });
        if (!r.ok) return fromOutcome(r, e, "调整亮度");
        if (colorTemp !== undefined) {
          return fromOutcome(
            await ctx.command({ entityId: e.id, service: "turn_on", data: { color_temp_kelvin: colorTemp }, origin: "ai", actor: "ai:hermes", traceId }),
            e, `亮度 ${level}%、色温 ${colorTemp}K`,
          );
        }
        return fromOutcome(r, e, `亮度 ${level}%`);
      }

      if (colorTemp !== undefined) {
        return fromOutcome(
          await ctx.command({ entityId: e.id, service: "turn_on", data: { color_temp_kelvin: colorTemp }, origin: "ai", actor: "ai:hermes", traceId }),
          e, `色温 ${colorTemp}K`,
        );
      }

      return fromOutcome(
        await ctx.command({ entityId: e.id, service: "turn_on", origin: "ai", actor: "ai:hermes", traceId }),
        e, "已打开",
      );
    }, traceId);
  },

  "light.get": async (args, ctx) => {
    const room = String(args.room ?? "*");
    const lights = findInRoom(await ctx.listEntities(), room, "light");
    if (lights.length === 0) return fail(`${roomLabel(room)}没有灯`, "NOT_PRESENT");
    const data = lights.map((e) => ({
      entity_id: e.id, name: e.name, room: e.room, on: isOn(e),
      brightness: e.state.brightness ?? null, color_temp: e.state.color_temp ?? null,
      available: e.available,
    }));
    const summary = data.map((d) => `${d.name}：${d.on ? `开 ${d.brightness}% ${d.color_temp}K` : "关"}`).join("；");
    return ok(summary, data);
  },

  /* ---------------- 窗帘 ---------------- */

  "cover.set": async (args, ctx, traceId) => {
    const room = String(args.room ?? "*");
    const pos = args.position === undefined ? undefined : Number(args.position);
    const covers = findInRoom(await ctx.listEntities(), room, "cover");
    if (covers.length === 0) return fail(`${roomLabel(room)}没有窗帘`, "NOT_PRESENT");

    return fanOut(covers, async (e) => {
      const service = pos === undefined ? "open_cover" : pos >= 100 ? "open_cover" : pos <= 0 ? "close_cover" : "set_position";
      const data = service === "set_position" ? { position: pos } : {};
      return fromOutcome(
        await ctx.command({ entityId: e.id, service, data, origin: "ai", actor: "ai:hermes", traceId }),
        e, service === "open_cover" ? "已打开" : service === "close_cover" ? "已关闭" : `开到 ${pos}%`,
      );
    }, traceId);
  },

  "cover.get": async (args, ctx) => {
    const room = String(args.room ?? "*");
    const covers = findInRoom(await ctx.listEntities(), room, "cover");
    if (covers.length === 0) return fail(`${roomLabel(room)}没有窗帘`, "NOT_PRESENT");
    const data = covers.map((e) => ({ entity_id: e.id, name: e.name, position: e.state.position ?? null, available: e.available }));
    return ok(data.map((d) => `${d.name}：${d.position}%`).join("；"), data);
  },

  /* ---------------- 空调 ---------------- */

  "climate.set": async (args, ctx, traceId) => {
    const room = String(args.room ?? "*");
    const clims = findInRoom(await ctx.listEntities(), room, "climate");
    if (clims.length === 0) return fail(`${roomLabel(room)}没有可控的空调`, "NOT_PRESENT");

    return fanOut(clims, async (e) => {
      if (args.on === false) {
        return fromOutcome(await ctx.command({ entityId: e.id, service: "turn_off", origin: "ai", actor: "ai:hermes", traceId }), e, "已关闭");
      }
      const steps: string[] = [];
      if (args.temp !== undefined) {
        const r = await ctx.command({ entityId: e.id, service: "set_temperature", data: { temperature: Number(args.temp) }, origin: "ai", actor: "ai:hermes", traceId });
        if (!r.ok) return fromOutcome(r, e, "设温度");
        steps.push(`${args.temp}°C`);
      }
      if (args.mode !== undefined) {
        const r = await ctx.command({ entityId: e.id, service: "set_hvac_mode", data: { mode: String(args.mode) }, origin: "ai", actor: "ai:hermes", traceId });
        if (!r.ok) return fromOutcome(r, e, "切模式");
        steps.push(String(args.mode));
      }
      if (steps.length === 0) {
        return fromOutcome(await ctx.command({ entityId: e.id, service: "turn_on", origin: "ai", actor: "ai:hermes", traceId }), e, "已打开");
      }
      return ok(`${e.name}：${steps.join(" ")}`);
    }, traceId);
  },

  "climate.get": async (args, ctx) => {
    const room = String(args.room ?? "*");
    const clims = findInRoom(await ctx.listEntities(), room, "climate");
    if (clims.length === 0) return fail(`${roomLabel(room)}没有空调`, "NOT_PRESENT");
    const data = clims.map((e) => ({ entity_id: e.id, name: e.name, on: isOn(e), mode: e.state.mode ?? null, target: e.state.temperature ?? null }));
    return ok(data.map((d) => `${d.name}：${d.on ? "开" : "关"} ${d.target ?? "-"}°C ${d.mode ?? ""}`.trim()).join("；"), data);
  },

  /* ---------------- 地暖 / 新风 ---------------- */

  "floor_heat.set": async (args, ctx, traceId) => {
    const room = String(args.room ?? "*");
    const list = await ctx.listEntities();
    const targets = list.filter((e) => (e.id.includes("floor_heat") || e.name.includes("地暖")) && (room === "*" || e.room === room));
    if (targets.length === 0) return fail(`地暖设备未接入（当前适配器内没有地暖实体）`, "NOT_PRESENT");

    return fanOut(targets, async (e) => {
      if (args.on === false) return fromOutcome(await ctx.command({ entityId: e.id, service: "turn_off", origin: "ai", actor: "ai:hermes", traceId }), e, "已关闭");
      if (args.temp !== undefined) {
        const r = await ctx.command({ entityId: e.id, service: "set_temperature", data: { temperature: Number(args.temp) }, origin: "ai", actor: "ai:hermes", traceId });
        return fromOutcome(r, e, `${args.temp}°C`);
      }
      return fromOutcome(await ctx.command({ entityId: e.id, service: "turn_on", origin: "ai", actor: "ai:hermes", traceId }), e, "已开启");
    }, traceId);
  },

  "fan.set": async (args, ctx, traceId) => {
    const room = String(args.room ?? "*");
    const list = await ctx.listEntities();
    const targets = list.filter((e) => e.type === "fan" && (room === "*" || e.room === room));
    if (targets.length === 0) return fail("新风设备未接入（当前适配器内没有 fan 实体）", "NOT_PRESENT");

    return fanOut(targets, async (e) => {
      if (args.on === false) return fromOutcome(await ctx.command({ entityId: e.id, service: "turn_off", origin: "ai", actor: "ai:hermes", traceId }), e, "已关闭");
      if (args.level !== undefined) {
        const r = await ctx.command({ entityId: e.id, service: "set_fan_mode", data: { level: String(args.level) }, origin: "ai", actor: "ai:hermes", traceId });
        return fromOutcome(r, e, `风量 ${args.level}`);
      }
      return fromOutcome(await ctx.command({ entityId: e.id, service: "turn_on", origin: "ai", actor: "ai:hermes", traceId }), e, "已开启");
    }, traceId);
  },

  /* ---------------- 环境读数 ---------------- */

  "env.room": async (args, ctx) => {
    const room = String(args.room ?? "*");
    const sensors = (await ctx.listEntities()).filter((e) => e.type === "sensor" && (room === "*" || e.room === room));
    if (sensors.length === 0) return fail(`${roomLabel(room)}没有环境传感器`, "NOT_PRESENT");
    const data = sensors.map((e) => ({ entity_id: e.id, room: e.room, temperature: e.state.temperature ?? null, humidity: e.state.humidity ?? null, battery: e.state.battery ?? null, available: e.available }));
    const summary = data.map((d) => `${d.room} ${d.temperature}°C ${d.humidity}%`).join("；");
    return ok(summary, data);
  },

  "env.home": async (_args, ctx) => {
    const sensors = (await ctx.listEntities()).filter((e) => e.type === "sensor");
    if (sensors.length === 0) return fail("没有环境传感器", "NOT_PRESENT");
    const temps = sensors.map((e) => Number(e.state.temperature)).filter((n) => Number.isFinite(n));
    const hums = sensors.map((e) => Number(e.state.humidity)).filter((n) => Number.isFinite(n));
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    const data = { rooms: sensors.map((e) => ({ room: e.room, temperature: e.state.temperature, humidity: e.state.humidity })), avg_temperature: avg(temps), avg_humidity: avg(hums) };
    return ok(`全屋平均 ${data.avg_temperature}°C、湿度 ${data.avg_humidity}%`, data);
  },

  /* ---------------- 安防 / 存在 ---------------- */

  "security.status": async (_args, ctx) => {
    const list = await ctx.listEntities();
    const locks = list.filter((e) => e.type === "lock");
    const doors = list.filter((e) => e.type === "binary_sensor" && /door|window|门窗/.test(e.id + e.name));
    if (locks.length === 0 && doors.length === 0) {
      // 诚实缺口：不能因为"没有门锁设备"就回答"一切正常"
      return ok("当前未接入门锁或门窗传感器，无法判断安防状态", { locks: [], doors: [], unsupported: true });
    }
    return ok(
      `门锁 ${locks.length} 个、门窗传感器 ${doors.length} 个；全部离线设备 ${list.filter((e) => !e.available).length} 个`,
      { locks: locks.map((l) => ({ id: l.id, locked: l.state.locked ?? null })), doors: doors.map((d) => ({ id: d.id, open: d.state.open ?? null })) },
    );
  },

  "presence.get": async (args, ctx) => {
    const room = String(args.room ?? "*");
    const list = (await ctx.listEntities()).filter((e) => e.type === "binary_sensor" && /presence|motion|人体/.test(e.id + e.name));
    if (list.length === 0) return ok("当前未接入人体存在传感器，无法判断有没有人", { unsupported: true, rooms: [] });
    const scoped = list.filter((e) => room === "*" || e.room === room);
    return ok(
      scoped.map((e) => `${e.room}：${e.state.on ? "有人" : "无人"}`).join("；"),
      scoped.map((e) => ({ room: e.room, occupied: e.state.on === true })),
    );
  },

  /* ---------------- 场景 ---------------- */

  "scene.list": async (_args, ctx) => {
    const scenes = ctx.scenes();
    return ok(scenes.map((s) => s.name).join("、"), scenes.map((s) => ({ id: s.id, name: s.name, actions: s.actions.length })));
  },

  "scene.run": async (args, ctx, traceId) => {
    const name = String(args.name ?? "").trim();
    const scene = ctx.scenes().find((s) => s.name === name) ?? ctx.scenes().find((s) => s.name.includes(name) || name.includes(s.name));
    if (!scene) return fail(`没有名为「${name}」的场景，可用：${ctx.scenes().map((s) => s.name).join("、")}`, "NOT_FOUND");

    const results: Array<{ entity: string; ok: boolean; error?: string }> = [];
    for (const action of scene.actions) {
      const r = await ctx.command({
        entityId: action.entity, service: action.service, data: action.data,
        origin: "ai", actor: "ai:hermes", traceId,
      });
      results.push({ entity: action.entity, ok: r.ok, error: r.ok ? undefined : r.message });
    }
    const failed = results.filter((r) => !r.ok);
    return {
      ok: failed.length === 0,
      partial: failed.length > 0 && failed.length < results.length,
      summary: failed.length === 0
        ? `已执行「${scene.name}」（${results.length} 个动作）`
        : `「${scene.name}」有 ${failed.length} 个动作失败：${failed.map((f) => `${f.entity}(${f.error})`).join("、")}`,
      data: { scene: scene.name, results },
      trace_id: traceId,
    };
  },

  /* ---------------- 设备查询 ---------------- */

  "device.list": async (args, ctx) => {
    const room = args.room === undefined ? undefined : String(args.room);
    const type = args.type === undefined ? undefined : String(args.type);
    const list = (await ctx.listEntities()).filter((e) =>
      (room ? e.room === room : true) && (type ? e.type === type : true));
    const data = list.map((e) => ({ entity_id: e.id, name: e.name, room: e.room, type: e.type, available: e.available }));
    const offline = data.filter((d) => !d.available).length;
    return ok(
      `共 ${data.length} 个设备${offline ? `（${offline} 个离线：${data.filter((d) => !d.available).map((d) => d.name).join("、")}）` : ""}`,
      data,
    );
  },

  "device.get": async (args, ctx) => {
    const id = String(args.entity_id ?? "");
    const e = (await ctx.listEntities()).find((x) => x.id === id || x.name === id);
    if (!e) return fail(`没有找到设备 ${id}`, "NOT_FOUND");
    return ok(`${e.name}（${e.room}）：${e.available ? JSON.stringify(e.state) : "离线"}`, {
      entity_id: e.id, name: e.name, room: e.room, type: e.type,
      available: e.available, state: e.state, capabilities: e.capabilities,
    });
  },

  "device.set": async (args, ctx, traceId) => {
    const room = args.room === undefined ? undefined : String(args.room);
    const name = args.name === undefined ? undefined : String(args.name);
    const list = (await ctx.listEntities()).filter((e) => (room ? e.room === room : true) && (name ? e.name.includes(name) : true));
    const targets = list.filter((e) => e.capabilities.includes("on_off") || e.state.on !== undefined);
    if (targets.length === 0) return fail(`没有匹配到可开关的设备（room=${room ?? "*"} name=${name ?? "*"}）`, "NOT_PRESENT");

    return fanOut(targets, async (e) =>
      fromOutcome(
        await ctx.command({ entityId: e.id, service: args.on === false ? "turn_off" : "turn_on", origin: "ai", actor: "ai:hermes", traceId }),
        e, args.on === false ? "已关闭" : "已打开",
      ), traceId);
  },

  "device.battery": async (args, ctx) => {
    const type = args.type === undefined ? undefined : String(args.type);
    const list = (await ctx.listEntities()).filter((e) => (type ? e.type === type : true));
    const withBattery = list.filter((e) => typeof e.state.battery === "number");
    if (withBattery.length === 0) return fail("没有支持电量上报的设备", "NOT_PRESENT");
    return ok(withBattery.map((e) => `${e.name} ${e.state.battery}%`).join("；"), withBattery.map((e) => ({ entity_id: e.id, battery: e.state.battery })));
  },

  /* ---------------- 传感器历史 ---------------- */

  "sensor.query": async (args, ctx) => {
    const since = args.since !== undefined ? Number(args.since) : ctx.now() - 3600;
    const rows = ctx.sensorHistory({ room: args.room === undefined ? undefined : String(args.room), since, limit: 50 });
    if (rows.length === 0) return ok("最近没有传感器事件记录", { rows: [] });
    return ok(`最近 ${rows.length} 条传感器事件`, { rows });
  },

  /* ---------------- 媒体 ---------------- */

  "media.set": async (args, ctx, traceId) => {
    const room = String(args.room ?? "*");
    const list = (await ctx.listEntities()).filter((e) => e.type === "media_player" && (room === "*" || e.room === room));
    if (list.length === 0) return fail("媒体设备未接入（当前适配器内没有 media_player）", "NOT_PRESENT");
    const action = String(args.action ?? "on");
    return fanOut(list, async (e) => {
      const service = action === "on" || action === "play" ? "turn_on" : action === "off" ? "turn_off" : "toggle";
      return fromOutcome(await ctx.command({ entityId: e.id, service, origin: "ai", actor: "ai:hermes", traceId }), e, action);
    }, traceId);
  },

  "media.volume": async (args, ctx, traceId) => {
    const list = (await ctx.listEntities()).filter((e) => e.type === "media_player");
    if (list.length === 0) return fail("媒体设备未接入", "NOT_PRESENT");
    return fanOut(list, async (e) =>
      fromOutcome(
        await ctx.command({ entityId: e.id, service: "set_brightness", data: { brightness_pct: Number(args.volume ?? 20) }, origin: "ai", actor: "ai:hermes", traceId }),
        e, `音量 ${args.volume}`,
      ), traceId);
  },

  /* ---------------- 自动化规则 ---------------- */

  "automation.list": async (_args, ctx) => {
    const rules = ctx.automations();
    if (rules.length === 0) return ok("当前没有配置自动化规则", []);
    return ok(rules.map((r) => `${r.id}：${r.enabled ? "启用" : "停用"}`).join("；"), rules);
  },

  "automation.enable": async (args, ctx) => {
    const id = String(args.id ?? "");
    const on = args.on !== false;
    const found = ctx.setAutomationEnabled(id, on);
    if (!found) return fail(`没有这条规则：${id}`, "NOT_FOUND");
    return ok(`规则 ${id} 已${on ? "启用" : "停用"}`);
  },

  /* ---------------- 插座 / 能耗 ---------------- */

  "plug.set": async (args, ctx, traceId) => {
    const room = args.room === undefined ? undefined : String(args.room);
    const name = args.name === undefined ? undefined : String(args.name);
    const list = (await ctx.listEntities()).filter((e) =>
      e.type === "switch" && (room ? e.room === room : true) && (name ? e.name.includes(name) : true));
    if (list.length === 0) return fail("插座设备未接入（当前适配器内没有 switch 实体）", "NOT_PRESENT");
    return fanOut(list, async (e) =>
      fromOutcome(await ctx.command({ entityId: e.id, service: args.on === false ? "turn_off" : "turn_on", origin: "ai", actor: "ai:hermes", traceId }), e, args.on === false ? "已断电" : "已通电"), traceId);
  },

  "energy.usage": async (_args, ctx) => {
    const list = (await ctx.listEntities()).filter((e) => e.type === "energy" || typeof e.state.power === "number");
    if (list.length === 0) return ok("当前没有接入电量计量设备", { unsupported: true });
    return ok(list.map((e) => `${e.name} ${e.state.power}W`).join("；"), list.map((e) => ({ entity_id: e.id, power: e.state.power })));
  },

  /* ---------------- 摘要 ---------------- */

  "summary.get": async (_args, ctx) => {
    const list = await ctx.listEntities();
    const byRoom = new Map<string, Entity[]>();
    for (const e of list) byRoom.set(e.room, [...(byRoom.get(e.room) ?? []), e]);
    const lightsOn = list.filter((e) => e.type === "light" && isOn(e));
    const offline = list.filter((e) => !e.available);
    const data = {
      rooms: [...byRoom.entries()].map(([room, es]) => ({ room, count: es.length })),
      lights_on: lightsOn.map((e) => e.name),
      offline: offline.map((e) => e.name),
      scenes: ctx.scenes().map((s) => s.name),
    };
    return ok(
      `${byRoom.size} 个房间 ${list.length} 个设备；` +
      `开着的灯 ${lightsOn.length} 个${lightsOn.length ? `（${lightsOn.map((e) => e.name).join("、")}）` : ""}；` +
      `离线 ${offline.length} 个；场景 ${ctx.scenes().length} 个`,
      data,
    );
  },

  /* ---------------- 元工具 ---------------- */

  "meta.search": async (args, ctx) => {
    const query = String(args.query ?? "");
    const limit = args.limit === undefined ? 8 : Number(args.limit);
    const hits = ctx.search(query, limit);
    if (hits.length === 0) return ok(`没有检索到与「${query}」相关的工具`, []);
    return ok(
      `检索到 ${hits.length} 个工具：${hits.map((h) => h.tool.name).join("、")}；用 call_tool 执行`,
      hits.map((h) => ({ name: h.tool.name, desc: h.tool.desc, params: h.tool.params.map((p) => p.name), score: Math.round(h.score * 100) / 100 })),
    );
  },

  "meta.call": async (args, ctx, traceId) => {
    const name = String(args.name ?? "");
    let parsed: Record<string, unknown> = {};
    if (typeof args.args === "string" && args.args.trim()) {
      try {
        parsed = JSON.parse(args.args) as Record<string, unknown>;
      } catch {
        return fail("args 必须是 JSON 字符串", "BAD_REQUEST");
      }
    } else if (args.args && typeof args.args === "object") {
      parsed = args.args as Record<string, unknown>;
    }
    return ctx.callTool(name, parsed, traceId);
  },

  /* ---------------- L2 通用 ---------------- */

  /**
   * L2 长尾工具的统一执行器。
   * 关键设计：设备不存在时返回 NOT_PRESENT（明确失败），
   * 绝不返回"已执行"——那会让模型对用户撒谎，也是评测里最容易漏掉的假成功。
   */
  generic: async (args, ctx, traceId, spec) => {
    const list = await ctx.listEntities();
    const room = args.room === undefined ? undefined : String(args.room);

    /* 已知在 mock 适配器里不存在的设备类：明确告知，不含糊 */
    const requires: Record<string, (e: Entity) => boolean> = {
      vacuum_clean: (e) => e.type === "vacuum",
      vacuum_start: (e) => e.type === "vacuum",
      vacuum_dock: (e) => e.type === "vacuum",
      get_vacuum_history: (e) => e.type === "vacuum",
      create_vacuum_schedule: (e) => e.type === "vacuum",
      set_clothes_rack: (e) => /clothes_rack|晾衣/.test(e.id + e.name),
      set_fan_mode: (e) => e.type === "fan",
      set_media_volume: (e) => e.type === "media_player",
      set_humidifier: (e) => /humidifier|加湿/.test(e.id + e.name),
      get_water_quality: (e) => /water|净水/.test(e.id + e.name),
      set_water_heater: (e) => /water_heater|热水器/.test(e.id + e.name),
      set_heater: (e) => /heater|浴霸/.test(e.id + e.name),
      set_air_purifier: (e) => /purifier|净化/.test(e.id + e.name),
      get_air_quality: (e) => /purifier|净化/.test(e.id + e.name),
      set_garage_door: (e) => /garage|车库/.test(e.id + e.name),
      get_device_battery: (e) => typeof e.state.battery === "number",
      get_camera_snapshot: (e) => e.type === "camera",
      set_device: (e) => e.capabilities.includes("on_off") || e.state.on !== undefined,
    };

    const matcher = requires[spec.name];
    const candidates = list.filter((e) => (matcher ? matcher(e) : true) && (room ? e.room === room : true));
    if (!matcher || candidates.length === 0) {
      return fail(`${spec.name} 对应的设备未接入（当前家庭里没有这类设备）`, "NOT_PRESENT");
    }

    if (spec.name === "get_vacuum_history" || spec.name === "get_air_quality" || spec.name === "get_water_quality") {
      return ok(`${spec.name} 数据`, candidates.map((e) => ({ entity_id: e.id, state: e.state })));
    }
    if (spec.name === "create_vacuum_schedule") {
      return fail("定时任务尚未接入设备侧，未创建", "UNSUPPORTED");
    }

    return fanOut(candidates, async (e) => {
      const service = args.on === false || args.action === "close" || args.action === "off" || args.action === "down"
        ? "turn_off"
        : args.action === "stop"
          ? "toggle"
          : "turn_on";
      return fromOutcome(
        await ctx.command({ entityId: e.id, service, origin: "ai", actor: "ai:hermes", traceId }),
        e, `${spec.name} 已执行`,
      );
    }, traceId);
  },
};

/** 执行入口：找不到 handler 说明目录与执行器不一致，必须报错而不是静默成功 */
export async function runTool(
  spec: ToolSpec,
  args: Record<string, unknown>,
  ctx: ToolContext,
  traceId: string,
): Promise<ToolResult> {
  const fn = HANDLERS[spec.handler];
  if (!fn) return fail(`工具 ${spec.name} 没有执行器（handler=${spec.handler}）`, "INTERNAL");
  try {
    return await fn(args, ctx, traceId, spec);
  } catch (err) {
    return fail(`工具执行异常：${err instanceof Error ? err.message : String(err)}`, "INTERNAL");
  }
}