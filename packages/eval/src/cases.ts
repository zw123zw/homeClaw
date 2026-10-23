/**
 * 100 条真实口语指令评测集（§4.4）。
 * 一期先落地 schema + 分类骨架，M2 接入真实 ToolHub 后填入检索结果并跑回归。
 * 字段说明：
 *  - expect.tool: 期望命中的语义工具名（L1 常驻工具）
 *  - expect.args: 期望的关键参数（只校验列出的字段，允许模型补充额外字段）
 *  - path: 期望处理路径，L0=确定性直通，L1=常驻工具，L2=检索长尾
 */
export type EvalCase = {
  id: string;
  text: string;
  /** 所属房间，用于检查实体解析是否正确 */
  room?: string;
  path: "L0" | "L1" | "L2";
  expect: { tool: string; args?: Record<string, unknown> };
  tags?: string[];
};

const light = (id: string, text: string, room: string, args: Record<string, unknown>, path: EvalCase["path"] = "L0"): EvalCase => ({
  id, text, room, path, expect: { tool: "set_room_light", args }, tags: ["light"],
});

const cover = (id: string, text: string, room: string, args: Record<string, unknown>, path: EvalCase["path"] = "L0"): EvalCase => ({
  id, text, room, path, expect: { tool: "set_cover", args }, tags: ["cover"],
});

const query = (id: string, text: string, tool: string, args?: Record<string, unknown>): EvalCase => ({
  id, text, path: "L1", expect: { tool, args }, tags: ["query"],
});

export const CASES: EvalCase[] = [
  // --- L0 高频确定性直通（30 条）---
  light("l01", "开灯", "客厅", { room: "客厅", level: 100 }),
  light("l02", "把客厅灯打开", "客厅", { room: "客厅", level: 100 }),
  light("l03", "客厅灯关掉", "客厅", { room: "客厅", level: 0 }),
  light("l04", "关客厅灯", "客厅", { room: "客厅", level: 0 }),
  light("l05", "客厅灯调到30%", "客厅", { room: "客厅", level: 30 }),
  light("l06", "把客厅灯调到30%暖光", "客厅", { room: "客厅", level: 30, color_temp: 2700 }),
  light("l07", "卧室灯太亮了，调暗点", "主卧", { room: "主卧", level: 30 }),
  light("l08", "书房灯开到一半", "书房", { room: "书房", level: 50 }),
  light("l09", "客厅主灯全开", "客厅", { room: "客厅", level: 100 }),
  light("l10", "主卧的氛围灯打开", "主卧", { room: "主卧", level: 100 }),
  cover("l11", "打开客厅窗帘", "客厅", { room: "客厅", position: 100 }),
  cover("l12", "把客厅窗帘拉上", "客厅", { room: "客厅", position: 0 }),
  cover("l13", "卧室窗帘关一下", "主卧", { room: "主卧", position: 0 }),
  cover("l14", "书房窗帘开到一半", "书房", { room: "书房", position: 50 }),
  { id: "l15", text: "客厅空调调到26度", room: "客厅", path: "L0", expect: { tool: "set_climate", args: { room: "客厅", temp: 26 } }, tags: ["climate"] },
  { id: "l16", text: "把空调温度设成24度", room: "客厅", path: "L0", expect: { tool: "set_climate", args: { temp: 24 } }, tags: ["climate"] },
  { id: "l17", text: "卧室空调开到28度", room: "主卧", path: "L0", expect: { tool: "set_climate", args: { room: "主卧", temp: 28 } }, tags: ["climate"] },
  { id: "l18", text: "全部灯关掉", path: "L0", expect: { tool: "set_room_light", args: { room: "*", level: 0 } }, tags: ["light", "batch"] },
  { id: "l19", text: "所有灯都关了吧", path: "L0", expect: { tool: "set_room_light", args: { room: "*", level: 0 } }, tags: ["light", "batch"] },
  { id: "l20", text: "客厅灯亮度调到60", path: "L0", room: "客厅", expect: { tool: "set_room_light", args: { room: "客厅", level: 60 } }, tags: ["light"] },
  { id: "l21", text: "客厅灯色温调到3000K", path: "L0", room: "客厅", expect: { tool: "set_room_light", args: { room: "客厅", color_temp: 3000 } }, tags: ["light"] },
  { id: "l22", text: "书房灯打开，亮度20", path: "L0", room: "书房", expect: { tool: "set_room_light", args: { room: "书房", level: 20 } }, tags: ["light"] },
  { id: "l23", text: "主卧灯关了", room: "主卧", path: "L0", expect: { tool: "set_room_light", args: { room: "主卧", level: 0 } }, tags: ["light"] },
  { id: "l24", text: "客厅氛围灯开到40%", room: "客厅", path: "L0", expect: { tool: "set_room_light", args: { room: "客厅", level: 40 } }, tags: ["light"] },
  { id: "l25", text: "把书房的窗帘关死", room: "书房", path: "L0", expect: { tool: "set_cover", args: { room: "书房", position: 0 } }, tags: ["cover"] },
  { id: "l26", text: "地暖开到22度", path: "L0", expect: { tool: "set_floor_heat", args: { on: true, temp: 22 } }, tags: ["floor_heat"] },
  { id: "l27", text: "关掉地暖", path: "L0", expect: { tool: "set_floor_heat", args: { on: false } }, tags: ["floor_heat"] },
  { id: "l28", text: "新风打开", path: "L0", expect: { tool: "set_fan", args: { on: true } }, tags: ["fan"] },
  { id: "l29", text: "客厅插座断电", room: "客厅", path: "L0", expect: { tool: "set_plug", args: { room: "客厅", on: false } }, tags: ["plug"] },
  { id: "l30", text: "书房灯调成暖光", room: "书房", path: "L0", expect: { tool: "set_room_light", args: { room: "书房", color_temp: 2700 } }, tags: ["light"] },

  // --- L1 常驻语义工具（40 条）---
  query("q01", "客厅现在多少度", "get_room_climate", { room: "客厅" }),
  query("q02", "主卧温度多少", "get_room_climate", { room: "主卧" }),
  query("q03", "家里环境怎么样", "get_home_environment"),
  query("q04", "客厅灯现在开着吗", "get_room_light", { room: "客厅" }),
  query("q05", "书房窗帘开到多少了", "get_cover", { room: "书房" }),
  query("q06", "空调现在设的几度", "get_climate", { room: "客厅" }),
  query("q07", "家里有哪些灯", "list_devices", { type: "light" }),
  query("q08", "客厅都有什么设备", "list_devices", { room: "客厅" }),
  query("q09", "主卧有几个设备", "list_devices", { room: "主卧" }),
  query("q10", "所有设备列一下", "list_devices"),
  query("q11", "书房主灯的状态", "get_device_state", { entity_id: "light.study_ceiling" }),
  query("q12", "有个设备离线了，是哪个", "list_devices"),
  query("q13", "家里有人吗", "get_presence"),
  query("q14", "客厅有人吗", "get_presence", { room: "客厅" }),
  query("q15", "安防状态怎么样", "get_security_status"),
  query("q16", "门窗都关好了吗", "get_security_status"),
  query("q17", "有哪些场景可以用", "list_scenes"),
  query("q18", "执行回家模式", "run_scene", { name: "回家模式" }),
  query("q19", "我要出门了，用离家模式", "run_scene", { name: "离家模式" }),
  query("q20", "打开观影模式", "run_scene", { name: "观影模式" }),
  query("q21", "睡觉了，切睡眠模式", "run_scene", { name: "睡眠模式" }),
  query("q22", "今天湿度怎么样", "get_home_environment"),
  query("q23", "客厅湿度多少", "get_room_climate", { room: "客厅" }),
  query("q24", "最近有人体传感器触发吗", "query_sensors", { type: "presence" }),
  query("q25", "这个小时温度变化", "query_sensors", { type: "temperature" }),
  query("q26", "客厅的温度记录", "query_sensors", { room: "客厅", type: "temperature" }),
  query("q27", "现在家里一共多少设备", "get_home_summary"),
  query("q28", "家里概况", "get_home_summary"),
  query("q29", "有哪些自动化规则", "list_automations"),
  query("q30", "把回家开灯的规则关掉", "enable_automation", { on: false }),
  query("q31", "开一下客厅音响", "set_media", { room: "客厅", action: "play" }),
  query("q32", "客厅音乐停了", "set_media", { room: "客厅", action: "pause" }),
  query("q33", "今天用了多少电", "get_energy_usage"),
  query("q34", "客厅的用电量", "get_energy_usage", { scope: "客厅" }),
  query("q35", "空调开制冷模式26度", "set_climate", { room: "客厅", temp: 26, mode: "cool" }),
  query("q36", "把客厅空调风量调小", "set_climate", { room: "客厅", fan: "low" }),
  query("q37", "书房灯和客厅灯都调暗一点", "set_room_light", { room: "*", level: 30 }),
  query("q38", "主卧灯调成睡前亮度", "set_room_light", { room: "主卧", level: 10 }),
  query("q39", "客厅窗帘和灯一起关了", "set_room_light", { room: "客厅", level: 0 }),
  query("q40", "全屋关灯关窗帘", "set_room_light", { room: "*", level: 0 }),

  // --- L2 检索式长尾（30 条）---
  { id: "x01", text: "让扫地机去打扫客厅", path: "L2", expect: { tool: "vacuum_clean", args: { room: "客厅" } }, tags: ["vacuum"] },
  { id: "x02", text: "扫地机器人回充", path: "L2", expect: { tool: "vacuum_dock" }, tags: ["vacuum"] },
  { id: "x03", text: "开始扫地", path: "L2", expect: { tool: "vacuum_start" }, tags: ["vacuum"] },
  { id: "x04", text: "晾衣架降下来", path: "L2", expect: { tool: "set_clothes_rack", args: { action: "down" } }, tags: ["rack"] },
  { id: "x05", text: "晾衣架收上去", path: "L2", expect: { tool: "set_clothes_rack", args: { action: "up" } }, tags: ["rack"] },
  { id: "x06", text: "新风切到自动模式", path: "L2", expect: { tool: "set_fan_mode", args: { mode: "auto" } }, tags: ["fan"] },
  { id: "x07", text: "新风开静音", path: "L2", expect: { tool: "set_fan_mode", args: { mode: "sleep" } }, tags: ["fan"] },
  { id: "x08", text: "客厅电视打开", path: "L2", expect: { tool: "set_media", args: { room: "客厅", action: "on" } }, tags: ["media"] },
  { id: "x09", text: "电视音量调到20", path: "L2", expect: { tool: "set_media_volume", args: { volume: 20 } }, tags: ["media"] },
  { id: "x10", text: "把客厅音响静音", path: "L2", expect: { tool: "set_media", args: { room: "客厅", action: "mute" } }, tags: ["media"] },
  { id: "x11", text: "主卧的加湿器打开", path: "L2", expect: { tool: "set_humidifier", args: { room: "主卧", on: true } }, tags: ["humidifier"] },
  { id: "x12", text: "加湿器湿度设到50", path: "L2", expect: { tool: "set_humidifier", args: { target: 50 } }, tags: ["humidifier"] },
  { id: "x13", text: "厨房的净水器现在水质如何", path: "L2", expect: { tool: "get_water_quality", args: { room: "厨房" } }, tags: ["water"] },
  { id: "x14", text: "热水器温度调到45度", path: "L2", expect: { tool: "set_water_heater", args: { temp: 45 } }, tags: ["water_heater"] },
  { id: "x15", text: "浴室浴霸打开", path: "L2", expect: { tool: "set_heater", args: { room: "浴室", on: true } }, tags: ["heater"] },
  { id: "x16", text: "空气净化器开到最大", path: "L2", expect: { tool: "set_air_purifier", args: { level: "max" } }, tags: ["purifier"] },
  { id: "x17", text: "净化器现在 PM2.5 多少", path: "L2", expect: { tool: "get_air_quality" }, tags: ["purifier"] },
  { id: "x18", text: "车库门打开", path: "L2", expect: { tool: "set_garage_door", args: { action: "open" } }, tags: ["garage"] },
  { id: "x19", text: "车库门关上", path: "L2", expect: { tool: "set_garage_door", args: { action: "close" } }, tags: ["garage"] },
  { id: "x20", text: "让窗帘慢慢开，用三分钟", path: "L2", expect: { tool: "set_cover", args: { position: 100 } }, tags: ["cover"] },
  { id: "x21", text: "空调除湿模式", path: "L2", expect: { tool: "set_climate", args: { mode: "dry" } }, tags: ["climate"] },
  { id: "x22", text: "空调开送风", path: "L2", expect: { tool: "set_climate", args: { mode: "fan_only" } }, tags: ["climate"] },
  { id: "x23", text: "地暖分房间开，只开主卧", path: "L2", expect: { tool: "set_floor_heat", args: { room: "主卧", on: true } }, tags: ["floor_heat"] },
  { id: "x24", text: "书房的台灯打开", path: "L2", expect: { tool: "set_device", args: { room: "书房" } }, tags: ["light"] },
  { id: "x25", text: "智能门锁电量多少", path: "L2", expect: { tool: "get_device_battery", args: { type: "lock" } }, tags: ["lock"] },
  { id: "x26", text: "看看门口的摄像头", path: "L2", expect: { tool: "get_camera_snapshot", args: { room: "门口" } }, tags: ["camera"] },
  { id: "x27", text: "客厅的落地灯关掉", path: "L2", expect: { tool: "set_device", args: { room: "客厅" } }, tags: ["light"] },
  { id: "x28", text: "阳台晾衣架照明打开", path: "L2", expect: { tool: "set_device", args: { room: "阳台" } }, tags: ["light"] },
  { id: "x29", text: "扫地机今天扫了几次", path: "L2", expect: { tool: "get_vacuum_history" }, tags: ["vacuum"] },
  { id: "x30", text: "给扫地机设个每天上午十点的定时", path: "L2", expect: { tool: "create_vacuum_schedule" }, tags: ["vacuum", "schedule"] },
];