import type { DeviceEvent } from "@homeclaw/contracts";
import type { Db } from "../db/index.ts";
import type { CommandPipeline } from "../command.ts";
import type { Audit } from "../audit/index.ts";
import { matchRule, type MatchResult, type Rule, type RuleThen } from "./rules.ts";

/**
 * 规则引擎（§6.4）。
 *
 * 定位：与 LLM 并存的确定性执行路径。
 * - 关掉 LLM，它必须照常工作（M3 验收项）；
 * - 高频重复场景（人来开灯）不该每次花一次模型调用；
 * - 用户要"可预期"，所以规则的每次匹配与执行都必须留痕。
 *
 * 执行路径与 AI 完全一致：走 CommandPipeline（幂等 → 策略 → 适配器 → 审计），
 * origin=rule，事件因此天然被 EventBus 的防环逻辑挡住。
 */
export type RuleRunResult = {
  ruleId: string;
  matched: boolean;
  ok: boolean;
  reason?: MatchResult extends { match: false; reason: infer R } ? R : never;
  detail?: string;
  results: Array<{ action: string; ok: boolean; error?: string }>;
};

type RuleEngineDeps = {
  db: Db;
  homeId: string;
  pipeline: CommandPipeline;
  audit: Audit;
  now: () => number;
  newId: (prefix: string) => string;
  /** 读实体当前状态：for_seconds 的延时确认要复查，不能只看历史事件 */
  getEntityState: (entityId: string) => Promise<Record<string, unknown> | undefined>;
  /** 场景执行器：由 bootstrap 注入，避免规则引擎直接依赖 scenes 缓存 */
  runScene: (name: string, traceId: string, actor: string) => Promise<{ ok: boolean; results: Array<{ entity: string; ok: boolean; error?: string }> }>;
};

export class RuleEngine {
  private readonly deps: RuleEngineDeps;
  /**
   * for_seconds 的延时确认（§6.4）。
   *
   * 为什么必须有它：单个设备事件自身的"持续时长"恒为 0，
   * 只有去抖窗口里连续多次变化才会有长度。所以 for_seconds: 3 这种规则
   * 如果只靠 matchRule 判事件时长，永远不会命中 —— 而"有人停留 3 秒才开灯"
   * 恰恰是这类规则最常见的用法。
   *
   * 正确语义：事件到达后等 N 秒，重新读实体状态，仍然满足条件才执行。
   * key = ruleId + entityId，同一组合只保留一个待确认任务，避免抖动把定时器堆满。
   */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: RuleEngineDeps) {
    this.deps = deps;
  }

  /** 关机时必须清理：否则进程退出前还会去读一个已关闭的数据库 */
  dispose(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  /** 一期把默认规则写进库；已存在的不覆盖（用户可能已经改过开关） */
  seed(rules: Array<Omit<Rule, "home_id" | "last_fired_at">>): void {
    for (const r of rules) {
      this.deps.db.run(
        `INSERT OR IGNORE INTO automations
          (home_id, automation_id, enabled, when_json, then_json, cooldown_seconds, last_fired_at)
         VALUES (?,?,?,?,?,?, NULL)`,
        this.deps.homeId, r.id, r.enabled ? 1 : 0, JSON.stringify(r.when), JSON.stringify(r.then), r.cooldown_seconds,
      );
    }
  }

  list(): Rule[] {
    const rows = this.deps.db.all<{
      automation_id: string; enabled: number; when_json: string; then_json: string;
      cooldown_seconds: number; last_fired_at: number | null;
    }>(
      "SELECT automation_id, enabled, when_json, then_json, cooldown_seconds, last_fired_at FROM automations WHERE home_id = ? ORDER BY automation_id",
      this.deps.homeId,
    );
    return rows.map((r) => ({
      id: r.automation_id,
      home_id: this.deps.homeId,
      enabled: r.enabled === 1,
      when: JSON.parse(r.when_json),
      then: JSON.parse(r.then_json),
      cooldown_seconds: r.cooldown_seconds,
      last_fired_at: r.last_fired_at,
    }));
  }

  /**
   * 一次设备事件 → 所有匹配规则。
   *
   * 关键：规则失败不影响其他规则继续跑（一条规则写错了不该让整个家变傻），
   * 但每条失败都要落 rule_run，否则"为什么灯没亮"永远查不出来。
   */
  async handleEvent(event: DeviceEvent, ctx: { durationSeconds: number; hour?: number }): Promise<RuleRunResult[]> {
    const rules = this.list();
    if (rules.length === 0) return [];

    const now = this.deps.now();
    const hour = ctx.hour ?? new Date(now * 1000).getHours();
    const out: RuleRunResult[] = [];

    for (const rule of rules) {
      const m = matchRule(rule, event, { durationSeconds: ctx.durationSeconds, hour, now });

      if (!m.match) {
        // for_seconds 走延时确认，而不是直接丢弃
        if (m.reason === "duration" && rule.when.for_seconds) {
          this.scheduleConfirm(rule, event);
          continue;
        }
        // 只在"本来是候选"的情况下记日志：日期/时间不匹配的规则每天都会命中几万次，全记是噪音
        if (m.reason !== "disabled" && m.reason !== "entity" && m.reason !== "attribute" && m.reason !== "value") {
          this.logRun(rule.id, event.trace_id ?? this.deps.newId("tr"), false, true, `skipped:${m.reason}`);
        }
        continue;
      }

      const traceId = this.deps.newId("tr");
      const results: Array<{ action: string; ok: boolean; error?: string }> = [];

      for (const action of rule.then) {
        const r = await this.runAction(rule, action, traceId);
        results.push(r);
      }

      const ok = results.every((r) => r.ok);
      this.deps.db.run(
        "UPDATE automations SET last_fired_at = ? WHERE home_id = ? AND automation_id = ?",
        now, this.deps.homeId, rule.id,
      );
      this.logRun(rule.id, traceId, true, ok, ok ? undefined : results.filter((r) => !r.ok).map((r) => r.error).join("; "));

      this.deps.audit.record({
        homeId: this.deps.homeId,
        traceId,
        actor: `rule:${rule.id}`,
        action: "automation.run",
        target: rule.when.entity ?? "*",
        params: { event: { entity_id: event.entity_id, old: event.old, new: event.new }, actions: rule.then.length },
        decision: "allow",
        reason: ok ? "ok" : "adapter_error",
        result: ok ? "ok" : "error",
        origin: "rule",
        elapsedMs: 0,
      });

      out.push({ ruleId: rule.id, matched: true, ok, results });
    }

    return out;
  }

  private async runAction(rule: Rule, action: RuleThen, traceId: string): Promise<{ action: string; ok: boolean; error?: string }> {
    try {
      if (action.action === "scene.run") {
        const r = await this.deps.runScene(action.name, traceId, `rule:${rule.id}`);
        return { action: `scene.run:${action.name}`, ok: r.ok, error: r.ok ? undefined : "场景中有动作失败" };
      }

      if (action.delay_ms) await new Promise((res) => setTimeout(res, action.delay_ms));

      const outcome = await this.deps.pipeline.execute({
        entityId: action.entity,
        service: action.service,
        data: action.data,
        // origin=rule：EventBus 会直接丢弃这次变化产生的事件，天然防环
        origin: "rule",
        actor: `rule:${rule.id}`,
        traceId,
      });

      return {
        action: `entity.command:${action.entity}:${action.service}`,
        ok: outcome.ok,
        error: outcome.ok ? undefined : `${outcome.code}:${outcome.message}`,
      };
    } catch (err) {
      return { action: action.action, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 延时确认：等 for_seconds 后复查实体状态是否仍满足 when.to。
   * 中途设备又变了（比如人走开），就不执行 —— 这正是"停留 N 秒"的语义。
   */
  private scheduleConfirm(rule: Rule, event: DeviceEvent): void {
    /*
     * 冷却检查必须在这里也做一遍，不能只依赖 matchRule：
     * for_seconds 的判定发生在冷却判定之前（它先返回 duration 就短路了），
     * 漏掉这里就会出现"冷却期内的第二次触发照样执行"——规则语义里最不该破的一条。
     */
    if (rule.last_fired_at && this.deps.now() - rule.last_fired_at < rule.cooldown_seconds) {
      this.logRun(rule.id, event.trace_id ?? this.deps.newId("tr"), false, true, "skipped:cooldown");
      return;
    }

    const key = `${rule.id}#${event.entity_id}`;
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing);

    const waitMs = (rule.when.for_seconds ?? 0) * 1000;
    const timer = setTimeout(() => {
      this.pending.delete(key);
      void this.confirmAndRun(rule, event).catch((err) => console.error("[rules] 延时确认异常：", err));
    }, waitMs);

    // 定时器不应拖住进程退出
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.pending.set(key, timer);
  }

  private async confirmAndRun(rule: Rule, event: DeviceEvent): Promise<void> {
    // 定时器排队期间别的路径可能已经触发过这条规则，复核一次
    const fresh = this.list().find((r) => r.id === rule.id);
    if (!fresh || !fresh.enabled) {
      this.logRun(rule.id, event.trace_id ?? this.deps.newId("tr"), false, true, "skipped:disabled_before_confirm");
      return;
    }
    if (fresh.last_fired_at && this.deps.now() - fresh.last_fired_at < fresh.cooldown_seconds) {
      this.logRun(rule.id, event.trace_id ?? this.deps.newId("tr"), false, true, "skipped:cooldown");
      return;
    }

    let current: unknown;
    try {
      const state = await this.deps.getEntityState(event.entity_id);
      current = state?.[event.attribute ?? "state"];
    } catch {
      current = undefined;
    }

    // 复查：状态已经变了就不再执行（人走开了、灯灭了）
    if (rule.when.to !== undefined && JSON.stringify(current) !== JSON.stringify(rule.when.to)) {
      this.logRun(rule.id, event.trace_id ?? this.deps.newId("tr"), false, true, "skipped:state_changed_before_confirm");
      return;
    }

    const traceId = this.deps.newId("tr");
    const results: Array<{ action: string; ok: boolean; error?: string }> = [];
    for (const action of rule.then) results.push(await this.runAction(rule, action, traceId));

    const ok = results.every((r) => r.ok);
    this.deps.db.run(
      "UPDATE automations SET last_fired_at = ? WHERE home_id = ? AND automation_id = ?",
      this.deps.now(), this.deps.homeId, rule.id,
    );
    this.logRun(rule.id, traceId, true, ok, ok ? "confirmed" : results.filter((r) => !r.ok).map((r) => r.error).join("; "));

    this.deps.audit.record({
      homeId: this.deps.homeId, traceId, actor: `rule:${rule.id}`, action: "automation.run",
      target: rule.when.entity ?? "*",
      params: { entity_id: event.entity_id, for_seconds: rule.when.for_seconds, actions: rule.then.length },
      decision: "allow", reason: ok ? "ok" : "adapter_error", result: ok ? "ok" : "error",
      origin: "rule", elapsedMs: 0,
    });
  }

  private logRun(automationId: string, traceId: string, matched: boolean, ok: boolean, detail?: string): void {
    try {
      this.deps.db.run(
        "INSERT INTO rule_run (home_id, automation_id, trace_id, matched, ok, detail, ts) VALUES (?,?,?,?,?,?,?)",
        this.deps.homeId, automationId, traceId, matched ? 1 : 0, ok ? 1 : 0, detail ?? null, this.deps.now(),
      );
    } catch (err) {
      console.error("[rule-engine] rule_run 写入失败：", err);
    }
  }

  /** 最近执行记录：面板与运维查"规则到底跑没跑" */
  history(limit = 50): Array<{ automation_id: string; trace_id: string; matched: boolean; ok: boolean; detail: string | null; ts: number }> {
    return this.deps.db
      .all<{ automation_id: string; trace_id: string; matched: number; ok: number; detail: string | null; ts: number }>(
        "SELECT automation_id, trace_id, matched, ok, detail, ts FROM rule_run WHERE home_id = ? ORDER BY ts DESC, id DESC LIMIT ?",
        this.deps.homeId, limit,
      )
      .map((r) => ({ ...r, matched: r.matched === 1, ok: r.ok === 1 }));
  }
}

/** 一期默认规则（§6.4 的最小集）：默认全部关闭，由用户/面板显式开启 */
export const DEFAULT_RULES: Array<Omit<Rule, "home_id" | "last_fired_at">> = [
  {
    id: "auto.presence_light",
    enabled: true,
    // 有人进客厅并持续 3 秒 → 开客厅主灯 30%。最高频的确定性场景，
    // 每花一次模型调用都是浪费（§6.4 的第二条理由）。
    when: { kind: "state_changed", entity: "binary_sensor.living_room_presence", to: true, for_seconds: 3 },
    then: [{ action: "entity.command", entity: "light.living_room_ceiling", service: "turn_on", data: { brightness_pct: 30 } }],
    cooldown_seconds: 300,
  },
  {
    id: "auto.night_dim",
    enabled: true,
    // 22:00–06:00 之间开客厅主灯 → 直接压到 10%，避免深夜刺眼。
    // 覆盖跨夜时段，是"时段窗口"这条能力最容易被写错的地方。
    when: { kind: "state_changed", entity: "light.living_room_ceiling", to: true, time_between: [22, 6] },
    then: [{ action: "entity.command", entity: "light.living_room_ceiling", service: "set_brightness", data: { brightness_pct: 10 } }],
    cooldown_seconds: 600,
  },
  {
    id: "auto.offline_audit",
    enabled: true,
    // 设备离线是安全相关事件：即使没有可执行的 then，也必须留痕（二期接通知）。
    // 用 kind 限定事件类型，否则"关灯"（new=false）会被误判成离线。
    when: { kind: "availability_changed", to: false },
    then: [],
    cooldown_seconds: 60,
  },
];
