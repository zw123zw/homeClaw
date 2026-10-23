import type { ToolSpec } from "./spec.ts";

/**
 * L1 常驻工具（§4.2）。
 *
 * 三条撰写纪律（§4.3）：
 *  1. 描述写"什么时候用"，不写"这是什么"—— 模型是在选工具，不是在读文档；
 *  2. 每个工具唯一主语（房间 / 设备类），不给模型在相似工具间犹豫的机会；
 *  3. 房间等离散值一律枚举，不接受自由文本 —— 自由文本会让模型生成不存在的房间名。
 *
 * 数量与顺序是稳定契约：顺序变了 prompt cache 就失效（§4.2）。
 */
export const L1_TOOLS: ToolSpec[] = [
  /* ---- 灯 ---- */
  {
    name: "set_room_light", tier: "L1", handler: "light.set",
    desc: "用户要开灯、关灯、调亮度或色温时用；room=\"*\" 为全屋。",
    keywords: ["灯", "开灯", "关灯", "亮度", "暖光", "冷光", "色温", "亮一点", "暗一点"],
    params: [
      { name: "room", type: "enum", values: "rooms", required: true, desc: "* 为全屋" },
      { name: "level", type: "number", min: 0, max: 100, desc: "亮度百分比，0=关" },
      { name: "color_temp", type: "number", min: 1700, max: 6500, desc: "色温 K，2700=暖光，5000=冷白" },
    ],
  },
  {
    name: "get_room_light", tier: "L1", handler: "light.get",
    desc: "问某房间的灯开着没、多亮时用。",
    keywords: ["灯开着吗", "多亮", "灯的状态"],
    params: [{ name: "room", type: "enum", values: "rooms", required: true }],
  },

  /* ---- 窗帘 ---- */
  {
    name: "set_cover", tier: "L1", handler: "cover.set",
    desc: "开窗帘、关窗帘或开到某百分比时用。",
    keywords: ["窗帘", "拉开", "拉上", "开窗帘", "关窗帘", "遮光"],
    params: [
      { name: "room", type: "enum", values: "rooms", required: true },
      { name: "position", type: "number", min: 0, max: 100, desc: "开合百分比，100=全开，0=全关" },
    ],
  },
  {
    name: "get_cover", tier: "L1", handler: "cover.get",
    desc: "问窗帘开到多少时用。",
    keywords: ["窗帘开到多少", "窗帘状态"],
    params: [{ name: "room", type: "enum", values: "rooms", required: true }],
  },

  /* ---- 空调 ---- */
  {
    name: "set_climate", tier: "L1", handler: "climate.set",
    desc: "开/关空调、设温度或切模式时用。",
    keywords: ["空调", "温度", "制冷", "制热", "除湿", "送风", "几度", "冷", "热"],
    params: [
      { name: "room", type: "enum", values: "rooms", required: true },
      { name: "temp", type: "number", min: 16, max: 32, desc: "目标温度 °C" },
      { name: "mode", type: "enum", values: ["cool", "heat", "dry", "fan_only", "auto"], desc: "运行模式" },
      { name: "on", type: "boolean", desc: "false=关机" },
    ],
  },
  {
    name: "get_climate", tier: "L1", handler: "climate.get",
    desc: "问空调设定温度与模式时用。",
    keywords: ["空调几度", "空调模式"],
    params: [{ name: "room", type: "enum", values: "rooms", required: true }],
  },

  /* ---- 地暖 / 新风 ---- */
  {
    name: "set_floor_heat", tier: "L1", handler: "floor_heat.set",
    desc: "开/关地暖或设地暖温度时用。",
    keywords: ["地暖", "供暖", "地板加热"],
    params: [
      { name: "room", type: "enum", values: "rooms", desc: "缺省=全屋" },
      { name: "on", type: "boolean", required: true },
      { name: "temp", type: "number", min: 10, max: 35, desc: "目标温度 °C" },
    ],
  },
  {
    name: "set_fan", tier: "L1", handler: "fan.set",
    desc: "开新风、换气或调风量时用。",
    keywords: ["新风", "换气", "通风", "风量"],
    params: [
      { name: "room", type: "enum", values: "rooms", desc: "缺省=全屋" },
      { name: "on", type: "boolean", required: true },
      { name: "level", type: "enum", values: ["low", "mid", "high"] },
    ],
  },

  /* ---- 环境读数 ---- */
  {
    name: "get_room_climate", tier: "L1", handler: "env.room",
    desc: "问某房间实测温湿度时用。",
    keywords: ["多少度", "温度", "湿度", "热不热", "冷不冷", "干不干"],
    params: [{ name: "room", type: "enum", values: "rooms", required: true }],
  },
  {
    name: "get_home_environment", tier: "L1", handler: "env.home",
    desc: "问全屋整体温湿度时用。",
    keywords: ["家里环境", "全屋温湿度", "空气质量"],
    params: [],
  },

  /* ---- 安防 / 存在 ---- */
  {
    name: "get_security_status", tier: "L1", handler: "security.status",
    desc: "问门窗是否关好、安防状态时用。",
    keywords: ["安防", "门窗", "安全", "有没有人闯"],
    params: [],
  },
  {
    name: "get_presence", tier: "L1", handler: "presence.get",
    desc: "问家里或某房间有没有人时用。",
    keywords: ["有人吗", "在家吗", "有没有人", "在不在"],
    params: [{ name: "room", type: "enum", values: "rooms", desc: "缺省=全屋" }],
  },

  /* ---- 场景 ---- */
  {
    name: "list_scenes", tier: "L1", handler: "scene.list",
    desc: "问有哪些场景可用时用。",
    keywords: ["场景", "模式列表", "有什么模式"],
    params: [],
  },
  {
    name: "run_scene", tier: "L1", handler: "scene.run",
    desc: "执行回家/离家/观影等命名场景时用。",
    keywords: ["回家模式", "离家模式", "观影模式", "睡眠模式", "一键"],
    params: [{ name: "name", type: "string", required: true, desc: "场景名，如 回家模式" }],
  },

  /* ---- 设备查询 ---- */
  {
    name: "list_devices", tier: "L1", handler: "device.list",
    desc: "问有哪些设备、某房间或某类设备时用。",
    keywords: ["有哪些设备", "设备列表", "几个设备", "都什么设备"],
    params: [
      { name: "room", type: "enum", values: "rooms" },
      { name: "type", type: "enum", values: ["light", "cover", "climate", "fan", "switch", "sensor", "binary_sensor", "media_player", "vacuum", "lock", "camera", "energy"] },
    ],
  },
  {
    name: "get_device_state", tier: "L1", handler: "device.get",
    desc: "问某个已知 entity_id 设备的状态时用。",
    keywords: ["这个设备", "entity_id", "设备状态"],
    params: [{ name: "entity_id", type: "string", required: true, desc: "如 light.study_ceiling" }],
  },

  /* ---- 传感器 ---- */
  {
    name: "query_sensors", tier: "L1", handler: "sensor.query",
    desc: "问某类传感器最近有没有触发时用。",
    keywords: ["传感器", "人体传感", "记录", "变化", "最近"],
    params: [
      { name: "type", type: "enum", values: ["presence", "temperature", "humidity", "door", "water"] },
      { name: "room", type: "enum", values: "rooms" },
      { name: "since", type: "number", desc: "起始 Unix 秒；不给则取最近一小时" },
    ],
  },

  /* ---- 媒体 ---- */
  {
    name: "set_media", tier: "L1", handler: "media.set",
    desc: "开电视、关电视、静音或播放暂停时用。",
    keywords: ["电视", "音响", "静音", "播放", "暂停", "音乐"],
    params: [
      { name: "room", type: "enum", values: "rooms", required: true },
      { name: "action", type: "enum", values: ["on", "off", "mute", "unmute", "play", "pause"], required: true },
    ],
  },

  /* ---- 规则 ---- */
  {
    name: "list_automations", tier: "L1", handler: "automation.list",
    desc: "问有哪些自动化规则、是否启用时用。",
    keywords: ["自动化", "规则", "定时", "联动"],
    params: [],
  },
  {
    name: "enable_automation", tier: "L1", handler: "automation.enable",
    desc: "开启或关闭某条自动化规则时用。",
    keywords: ["关闭自动化", "开启自动化", "停用规则"],
    params: [
      { name: "id", type: "string", required: true },
      { name: "on", type: "boolean", required: true },
    ],
  },

  /* ---- 插座 / 能耗 ---- */
  {
    name: "set_plug", tier: "L1", handler: "plug.set",
    desc: "开/关插座或按名字找插座时用。",
    keywords: ["插座", "插排", "断电", "通电"],
    params: [
      { name: "room", type: "enum", values: "rooms" },
      { name: "name", type: "string", desc: "设备名关键词" },
      { name: "on", type: "boolean", required: true },
    ],
  },
  {
    name: "get_energy_usage", tier: "L1", handler: "energy.usage",
    desc: "问今天用电量或设备功耗时用。",
    keywords: ["耗电", "用电", "电量", "电费", "功率"],
    params: [{ name: "scope", type: "enum", values: ["home", "room", "device"], desc: "默认 home" }],
  },

  /* ---- 上下文摘要 ---- */
  {
    name: "get_home_summary", tier: "L1", handler: "summary.get",
    desc: "问家里概况；多步操作前先了解全局时用。",
    keywords: ["概况", "整体", "总结", "家里怎么样"],
    params: [],
  },

  /* ---- 元工具 ---- */
  {
    name: "search_tools", tier: "L1", handler: "meta.search",
    desc: "没有匹配到已加载工具时用，检索长尾工具（扫地机、晾衣架等）。",
    keywords: ["找不到工具", "搜索工具", "还有什么能做", "扫地机", "晾衣架"],
    params: [
      { name: "query", type: "string", required: true, desc: "用户的原始说法" },
      { name: "limit", type: "number", min: 1, max: 20, desc: "默认 8" },
    ],
  },
  {
    name: "call_tool", tier: "L1", handler: "meta.call",
    desc: "用 search_tools 拿到工具名后，执行该长尾工具。",
    keywords: ["执行工具", "调用"],
    params: [
      { name: "name", type: "string", required: true },
      { name: "args", type: "string", desc: "JSON 字符串形式的参数" },
    ],
  },
];

/**
 * L2 长尾工具（§4.2）：不常驻，靠 search_tools 检索注入。
 * 与 L1 的差别只有"何时进上下文"，执行路径完全一致（同一 Policy / Audit / 幂等）。
 */
export const L2_TOOLS: ToolSpec[] = [
  { name: "vacuum_clean", tier: "L2", handler: "generic", desc: "让扫地机打扫某个房间时用。", keywords: ["扫地机", "扫地机器人", "打扫", "清扫"], params: [{ name: "room", type: "enum", values: "rooms" }] },
  { name: "vacuum_start", tier: "L2", handler: "generic", desc: "开始扫地（不指定房间）时用。", keywords: ["开始扫地", "扫地机开始"], params: [] },
  { name: "vacuum_dock", tier: "L2", handler: "generic", desc: "让扫地机回充时用。", keywords: ["回充", "回基站", "扫地机回家"], params: [] },
  { name: "get_vacuum_history", tier: "L2", handler: "generic", desc: "问扫地机清扫记录时用。", keywords: ["清扫记录", "扫了几次", "扫地机历史"], params: [] },
  { name: "create_vacuum_schedule", tier: "L2", handler: "generic", desc: "给扫地机设定时清扫时用。", keywords: ["定时清扫", "扫地机定时"], params: [{ name: "at", type: "string", desc: "如 10:00" }, { name: "days", type: "string", desc: "如 每天 / 周一,周三" }] },
  { name: "set_clothes_rack", tier: "L2", handler: "generic", desc: "升降晾衣架时用。", keywords: ["晾衣架", "升降", "晒衣服"], params: [{ name: "action", type: "enum", values: ["up", "down", "stop"], required: true }] },
  { name: "set_fan_mode", tier: "L2", handler: "generic", desc: "切换新风模式（自动/静音/强力）时用。", keywords: ["新风模式", "静音", "自动模式", "强力"], params: [{ name: "mode", type: "enum", values: ["auto", "sleep", "strong", "manual"], required: true }] },
  { name: "set_media_volume", tier: "L2", handler: "generic", desc: "调音量时用。", keywords: ["音量", "声音大小"], params: [{ name: "volume", type: "number", min: 0, max: 100, required: true }] },
  { name: "set_humidifier", tier: "L2", handler: "generic", desc: "开加湿器或设目标湿度时用。", keywords: ["加湿器", "加湿", "湿度太低"], params: [{ name: "room", type: "enum", values: "rooms" }, { name: "on", type: "boolean" }, { name: "target", type: "number", min: 30, max: 80 }] },
  { name: "get_water_quality", tier: "L2", handler: "generic", desc: "问净水器水质/TDS 时用。", keywords: ["净水器", "水质", "TDS"], params: [{ name: "room", type: "enum", values: "rooms" }] },
  { name: "set_water_heater", tier: "L2", handler: "generic", desc: "调热水器温度或开关时用。", keywords: ["热水器", "洗澡水", "热水"], params: [{ name: "temp", type: "number", min: 35, max: 65 }, { name: "on", type: "boolean" }] },
  { name: "set_heater", tier: "L2", handler: "generic", desc: "开浴室暖风机或浴霸时用。", keywords: ["浴霸", "暖风机", "浴室加热"], params: [{ name: "room", type: "enum", values: "rooms" }, { name: "on", type: "boolean", required: true }] },
  { name: "set_air_purifier", tier: "L2", handler: "generic", desc: "开空气净化器或调档位时用。", keywords: ["净化器", "空气净化", "PM2.5"], params: [{ name: "level", type: "enum", values: ["low", "mid", "high", "max", "auto"] }, { name: "on", type: "boolean" }] },
  { name: "get_air_quality", tier: "L2", handler: "generic", desc: "问 PM2.5 或空气质量时用。", keywords: ["空气质量", "PM2.5", "雾霾"], params: [] },
  { name: "set_garage_door", tier: "L2", handler: "generic", desc: "开车库门或关车库门时用。", keywords: ["车库门", "车库"], params: [{ name: "action", type: "enum", values: ["open", "close", "stop"], required: true }] },
  { name: "get_device_battery", tier: "L2", handler: "generic", desc: "问某类设备电量时用。", keywords: ["电量", "电池", "续航"], params: [{ name: "type", type: "enum", values: ["lock", "sensor", "camera", "vacuum"] }] },
  { name: "get_camera_snapshot", tier: "L2", handler: "generic", desc: "看摄像头画面时用。", keywords: ["摄像头", "监控", "看门口"], params: [{ name: "room", type: "enum", values: "rooms" }] },
  { name: "set_device", tier: "L2", handler: "generic", desc: "点名某台灯/落地灯等长尾设备开关时用。", keywords: ["台灯", "落地灯", "照明", "某个设备"], params: [{ name: "room", type: "enum", values: "rooms" }, { name: "name", type: "string" }, { name: "on", type: "boolean" }] },
];

export const ALL_TOOLS: ToolSpec[] = [...L1_TOOLS, ...L2_TOOLS];

export function findTool(name: string): ToolSpec | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}