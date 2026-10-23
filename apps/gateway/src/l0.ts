/**
 * L0 确定性直通（§4.2）。
 *
 * 为什么值得单独实现一层：它吃掉 30–40% 的高频指令，延迟 <100ms、成本 0、
 * 行为 100% 可复现。更重要的是——它在 LLM 不可用时仍然工作，
 * 这是"断网还能开灯"这条承诺的全部实现。
 *
 * 设计取舍：只用规则，不用模型。所以宁可"保守不命中"也不能"猜错"——
 * 猜错会把"把书房灯调到 30%"执行成"关客厅窗帘"，而漏判只是升级到 L1/L2 走模型。
 */

export type L0Intent = {
  tool: string;
  args: Record<string, unknown>;
  /** 命中哪条规则（便于统计与调试） */
  rule: string;
};

/** 房间词典：由调用方从 HomeHub 实体列表注入，不写死 */
export type Rooms = string[];

const ROOM_ALIASES: Record<string, string[]> = {
  客厅: ["客厅", "起居室", "客堂"],
  主卧: ["主卧", "卧室", "大卧室", "主卧室"],
  书房: ["书房", "工作室", "办公室"],
  厨房: ["厨房"],
  浴室: ["浴室", "卫生间", "洗手间"],
  阳台: ["阳台"],
  门口: ["门口", "门厅", "玄关"],
};

/** 从文本里找出房间；"全屋/所有/全部/都"视为通配 */
function findRoom(text: string, rooms: Rooms): string | null {
  if (/全屋|全部|所有|每个房间|都关|都开/.test(text)) return "*";

  // 先精确匹配已有房间，避免"主卧"被"卧室"抢占
  const sorted = [...rooms].sort((a, b) => b.length - a.length);
  for (const r of sorted) if (text.includes(r)) return r;

  for (const [canonical, aliases] of Object.entries(ROOM_ALIASES)) {
    if (!rooms.includes(canonical)) continue;
    if (aliases.some((a) => text.includes(a))) return canonical;
  }
  return null;
}

/** 提取百分比：30% / 百分之三十 / 一半 / 全开 / 全关 */
function findPercent(text: string): number | null {
  const pct = text.match(/(\d{1,3})\s*[%％]/);
  if (pct) return clamp(Number(pct[1]), 0, 100);

  const cn = text.match(/百分之([一二三四五六七八九十百]+)/);
  if (cn) {
    const n = cnDigits(cn[1]!);
    if (n !== null) return clamp(n, 0, 100);
  }

  if (/一半|半开|50%/.test(text)) return 50;
  if (/全开|最大/.test(text)) return 100;
  if (/全关|关死|全闭/.test(text)) return 0;
  if (/一档|最低/.test(text)) return 10;
  return null;
}

/** 提取"亮度 60"这种没有百分号的写法 */
function findBareLevel(text: string): number | null {
  const m = text.match(/(?:亮度|调到|设为|调到)\s*(\d{1,3})(?!\s*[度°Kk%％])/);
  if (m) return clamp(Number(m[1]), 0, 100);
  return null;
}

/** 色温：3000K / 暖光 / 冷白 / 自然光 */
function findColorTemp(text: string): number | null {
  const k = text.match(/(\d{4})\s*[Kk]/);
  if (k) return clamp(Number(k[1]), 1700, 6500);
  if (/暖光|暖色|温馨/.test(text)) return 2700;
  if (/冷白|冷光|白光/.test(text)) return 5000;
  if (/自然光|中性光/.test(text)) return 4000;
  return null;
}

/** 温度：26度 / 26°C */
function findTemp(text: string): number | null {
  const m = text.match(/(-?\d{1,2})\s*(?:度|°C|℃)/);
  if (m) return Number(m[1]);
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function cnDigits(s: string): number | null {
  const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === "十") return 10;
  if (s === "百") return 100;
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a ? (map[a] ?? 0) : 1;
    const ones = b ? (map[b] ?? 0) : 0;
    return tens * 10 + ones;
  }
  if (s.length === 1) return map[s] ?? null;
  return null;
}

/**
 * 主入口。返回 null 表示"没把握"，调用方应升级到 L1/L2 走模型。
 * 注意顺序：先判设备类，再判动作——"把窗帘拉到 30%"不能因为含"30%"被当成调光。
 */
export function parseL0(raw: string, rooms: Rooms): L0Intent | null {
  const text = raw.trim();
  if (!text) return null;

  /*
   * 多意图必须交回模型。
   * "打开客厅灯并把空调调到26度" 同时命中灯与空调两类，
   * 若这里只返回第一条，用户会得到"已执行"，而空调根本没动 ——
   * 这是最难发现的一类缺陷：UI 显示成功、审计里有记录、设备状态却不对。
   */
  const categories = [
    /灯|照明|台灯|落地灯|氛围/,
    /窗帘|帘子|遮光帘/,
    /空调|冷气|暖气/,
    /地暖/,
    /新风|换气|通风/,
    /插座|插排/,
  ].filter((re) => re.test(text)).length;
  if (categories > 1) return null;

  const room = findRoom(text, rooms);
  const percent = findPercent(text);
  const bareLevel = findBareLevel(text);
  const colorTemp = findColorTemp(text);
  const temp = findTemp(text);

  const isOff = /关|关闭|关掉|熄灭|停止|断电/.test(text);
  const isOn = /开|打开|开启|亮起|通电/.test(text);

  /* ---- 窗帘：必须早于灯，否则"把窗帘拉到30%"会命中灯的百分比分支 ---- */
  if (/窗帘|帘子|遮光帘/.test(text)) {
    if (!room) return null;
    if (isOff || percent === 0) return { tool: "set_cover", args: { room, position: 0 }, rule: "cover.close" };
    if (isOn || percent === 100) {
      return percent !== null && percent !== 100
        ? { tool: "set_cover", args: { room, position: percent }, rule: "cover.position" }
        : { tool: "set_cover", args: { room, position: 100 }, rule: "cover.open" };
    }
    if (percent !== null) return { tool: "set_cover", args: { room, position: percent }, rule: "cover.position" };
    return null;
  }

  /* ---- 灯 ---- */
  if (/灯|照明|台灯|落地灯|氛围/.test(text)) {
    // "全屋关灯"必须在没有房间时也命中
    if (!room && !/全屋|全部|所有/.test(text)) return null;
    const target = room ?? "*";

    if (isOff) return { tool: "set_room_light", args: { room: target, level: 0 }, rule: "light.off" };

    const level = percent ?? bareLevel;
    const args: Record<string, unknown> = { room: target };
    if (level !== null) args.level = level;
    if (colorTemp !== null) args.color_temp = colorTemp;
    if (level === null && colorTemp === null) args.level = 100;
    return { tool: "set_room_light", args, rule: colorTemp !== null ? "light.color" : level !== null ? "light.level" : "light.on" };
  }

  /* ---- 空调 ---- */
  if (/空调|冷气|暖气/.test(text)) {
    if (!room) return null;
    if (isOff) return { tool: "set_climate", args: { room, on: false }, rule: "climate.off" };
    const args: Record<string, unknown> = { room };
    if (temp !== null) args.temp = temp;
    if (/除湿/.test(text)) args.mode = "dry";
    else if (/送风/.test(text)) args.mode = "fan_only";
    else if (/制热|暖风/.test(text)) args.mode = "heat";
    else if (/制冷|冷风/.test(text)) args.mode = "cool";
    if (Object.keys(args).length === 1) args.temp = 26;
    return { tool: "set_climate", args, rule: "climate.set" };
  }

  /* ---- 地暖 / 新风 / 插座 ---- */
  if (/地暖/.test(text)) {
    const args: Record<string, unknown> = { on: !isOff };
    if (room) args.room = room;
    if (temp !== null) args.temp = temp;
    return { tool: "set_floor_heat", args, rule: "floor_heat.set" };
  }
  if (/新风|换气|通风/.test(text)) {
    const args: Record<string, unknown> = { on: !isOff };
    if (room) args.room = room;
    if (/低|小/.test(text)) args.level = "low";
    if (/中/.test(text)) args.level = "mid";
    if (/高|强|大/.test(text)) args.level = "high";
    return { tool: "set_fan", args, rule: "fan.set" };
  }
  if (/插座|插排/.test(text)) {
    if (!room) return null;
    return { tool: "set_plug", args: { room, on: !isOff }, rule: "plug.set" };
  }

  return null;
}

/**
 * 一句话拆成多条指令：多步操作用。
 * 只在有明显连接词时拆，避免把"把客厅灯开到 30% 再关窗帘"拆错。
 */
export function splitMulti(text: string): string[] {
  const parts = text
    .split(/并且|然后|接着|，并|,并|再把|，然后/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [text];
}