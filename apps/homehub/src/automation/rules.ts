import type { DeviceEvent } from "@homeclaw/contracts";

/**
 * 规则引擎的数据模型（§6.4）。
 *
 * 为什么规则要落库而不是写死在代码：
 *  1. 断网/断 LLM 时系统仍要能执行基本自动化，规则必须能在没有模型的情况下跑；
 *  2. 用户需要"可预期"的行为，代码里的 if 无法向用户展示；
 *  3. 二期要让 LLM 把自然语言翻译成规则并落库，落库格式现在就得定下来。
 */

export type RuleWhen = {
  /** 只匹配某类事件；不给则只看 state_changed（availability 变更默认不驱动规则） */
  kind?: "state_changed" | "availability_changed" | "triggered";
  /** 空表示任意实体；支持 `lock.*` 这种前缀通配 */
  entity?: string;
  /** 期望变到的值；不给则任意变化都匹配 */
  to?: unknown;
  /** 从哪个值变来；不给则不限制 */
  from?: unknown;
  /** 只看某个属性（state / brightness / position ...） */
  attribute?: string;
  /** 持续时长（秒）：值班到"来了多久"这类判断用 */
  for_seconds?: number;
  /** 值为数值时的比较（如 temperature > 28） */
  gt?: number;
  lt?: number;
  /** 只在某个时间段生效（0-23 小时，含左不含右；支持跨夜如 22→6） */
  time_between?: [number, number];
};

export type RuleThen =
  | { action: "entity.command"; entity: string; service: string; data?: Record<string, unknown>; delay_ms?: number }
  | { action: "scene.run"; name: string };

export type Rule = {
  id: string;
  home_id: string;
  enabled: boolean;
  when: RuleWhen;
  then: RuleThen[];
  cooldown_seconds: number;
  last_fired_at?: number | null;
};

/** 匹配结果必须带"为什么没命中"，否则规则不生效时无从排查 */
export type MatchResult =
  | { match: true }
  | { match: false; reason: "disabled" | "entity" | "attribute" | "value" | "duration" | "range" | "time" };

function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

/** 跨夜时段也要正确：22→6 表示 22,23,0..5 */
export function inTimeWindow(hour: number, window: [number, number]): boolean {
  const [from, to] = window;
  if (from === to) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * 单条规则的匹配。
 * 时间参数显式传入而不是内部读 Date：规则引擎必须能被确定性测试，
 * 否则"晚上才生效"这类规则在 CI 里会被当前时钟随机决定成败。
 */
export function matchRule(
  rule: Rule,
  event: DeviceEvent,
  ctx: { durationSeconds: number; hour: number; now: number },
): MatchResult {
  if (!rule.enabled) return { match: false, reason: "disabled" };

  const when = rule.when;

  // 事件类型先判：availability_changed 的 new=false 与"关灯"的 new=false 语义完全不同，
  // 不区分会得到"设备一关灯就以为它离线"这种荒谬规则。
  const wantKind = when.kind ?? "state_changed";
  if (event.kind !== wantKind) return { match: false, reason: "attribute" };

  if (when.entity && !matches(when.entity, event.entity_id)) {
    return { match: false, reason: "entity" };
  }

  if (when.attribute && event.attribute !== when.attribute) {
    return { match: false, reason: "attribute" };
  }

  if (when.to !== undefined && !sameValue(when.to, event.new)) {
    return { match: false, reason: "value" };
  }

  if (when.from !== undefined && !sameValue(when.from, event.old)) {
    return { match: false, reason: "value" };
  }

  if (when.gt !== undefined || when.lt !== undefined) {
    const n = typeof event.new === "number" ? event.new : Number(event.new);
    if (!Number.isFinite(n)) return { match: false, reason: "range" };
    if (when.gt !== undefined && !(n > when.gt)) return { match: false, reason: "range" };
    if (when.lt !== undefined && !(n < when.lt)) return { match: false, reason: "range" };
  }

  if (when.for_seconds !== undefined && ctx.durationSeconds < when.for_seconds) {
    return { match: false, reason: "duration" };
  }

  if (when.time_between && !inTimeWindow(ctx.hour, when.time_between)) {
    return { match: false, reason: "time" };
  }

  // 冷却期：防抖只解决"同一事件重复"，冷却解决"反复变化反复执行"
  if (rule.last_fired_at && ctx.now - rule.last_fired_at < rule.cooldown_seconds) {
    return { match: false, reason: "time" };
  }

  return { match: true };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  // 布尔与字符串混用很常见（"true" vs true），统一按字符串比较一次
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b);
  return JSON.stringify(a) === JSON.stringify(b);
}