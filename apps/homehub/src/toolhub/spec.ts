/**
 * ToolSpec —— 工具的唯一描述形态。
 *
 * 为什么不用「直接写 JSON Schema」：
 *  1. JSON Schema 的样板（"type":"object","properties":{...}）每个工具约 25 tokens，
 *     35 个就吃掉 900 tokens，还没写一个参数；
 *  2. 参数枚举（房间词典）必须来自配置，不能手写三份；
 *  3. §4.2 的 2k token 上限是硬约束，必须能被测量、被测试守住。
 * 所以内部用紧凑 spec，序列化到 MCP 时再生成标准 JSON Schema。
 */

export type ParamType = "string" | "number" | "boolean" | "enum";

export type ParamSpec = {
  name: string;
  type: ParamType;
  /** enum 类型的取值来源：rooms / modes / levels / actions 等，序列化时从配置展开 */
  values?: readonly string[] | "rooms";
  desc?: string;
  required?: boolean;
  min?: number;
  max?: number;
};

export type ToolSpec = {
  name: string;
  /** 写「什么时候用」，不写「这是什么」（§4.3） */
  desc: string;
  params: ParamSpec[];
  /** L1 常驻 / L2 检索 */
  tier: "L1" | "L2";
  /** 供检索用的额外关键词（中文口语、同义词） */
  keywords?: string[];
  /** 执行时用哪一类处理器 */
  handler: HandlerKey;
};

export type HandlerKey =
  | "light.set" | "light.get"
  | "cover.set" | "cover.get"
  | "climate.set" | "climate.get"
  | "floor_heat.set" | "fan.set" | "fan.mode"
  | "env.room" | "env.home"
  | "security.status" | "presence.get"
  | "scene.list" | "scene.run"
  | "device.list" | "device.get" | "device.set" | "device.battery"
  | "sensor.query"
  | "media.set" | "media.volume"
  | "automation.list" | "automation.enable"
  | "plug.set" | "energy.usage"
  | "humidifier.set" | "purifier.set" | "purifier.air"
  | "heater.set" | "water_heater.set" | "water.quality"
  | "summary.get"
  | "meta.search" | "meta.call"
  /** L2 长尾：统一走 generic 处理器，行为由 spec 声明 */
  | "generic";

/**
 * token 估算。
 * 手上没有 tokenizer（环境禁止起子进程调 tiktoken），用可验证的保守估算：
 *  - 每个 CJK 字符计 1 token（BPE 对中文基本是字级）
 *  - 其余字符按 3.5 字符 / token（偏保守，实际通常 4）
 * 保守估计用于守住 2k 上限，偏大一点是安全的。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 3.5);
}

export function expandValues(p: ParamSpec, rooms: readonly string[]): readonly string[] | undefined {
  if (!p.values) return undefined;
  return p.values === "rooms" ? rooms : p.values;
}

/** 生成 MCP 要的标准 JSON Schema；只带必要字段，不带 $schema / additionalProperties 等样板 */
export function toJsonSchema(tool: ToolSpec, rooms: readonly string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of tool.params) {
    const node: Record<string, unknown> = {};
    const values = expandValues(p, rooms);

    if (p.type === "enum" && values) {
      node.type = "string";
      node.enum = values;
    } else if (p.type === "enum") {
      node.type = "string";
    } else {
      node.type = p.type;
    }

    if (p.min !== undefined) node.minimum = p.min;
    if (p.max !== undefined) node.maximum = p.max;
    if (p.desc) node.description = p.desc;

    properties[p.name] = node;
    if (p.required) required.push(p.name);
  }

  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

/** 一次 MCP tools/list 的完整载荷：逐字节等于模型看到的东西，预算就按它算 */
export function renderToolsList(
  tools: readonly ToolSpec[],
  rooms: readonly string[],
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return tools.map((t) => ({
    name: t.name,
    description: t.desc,
    inputSchema: toJsonSchema(t, rooms),
  }));
}

export function budgetOf(tools: readonly ToolSpec[], rooms: readonly string[]): number {
  return estimateTokens(JSON.stringify(renderToolsList(tools, rooms)));
}