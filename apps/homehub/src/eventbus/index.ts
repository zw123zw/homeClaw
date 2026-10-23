import type { DeviceEvent } from "@homeclaw/contracts";

export type TriggerDecision =
  | { fired: true; firstEvent: DeviceEvent; lastEvent: DeviceEvent; finalValue: unknown }
  | { fired: false; reason: "loop_blocked" | "merged" | "rate_limited" | "budget_exceeded" | "disabled" };

/** 去抖窗口内同一 (entity, attribute) 的聚合状态 */
type Pending = {
  firstEvent: DeviceEvent;
  lastEvent: DeviceEvent;
  timers: ReturnType<typeof setTimeout>;
};

export type EventBusConfig = {
  /** 全局开关 */
  enabled: boolean;
  /** 去抖窗口（毫秒）：同实体同属性在窗口内只触发一次 */
  debounceMs: number;
  /** 频率上限 */
  limit: { perRoomPerHour: number; globalPerHour: number };
  /** 预算上限：返回 false 表示已超限 */
  hasBudget: () => boolean;
};

/**
 * EventBus：把设备事件转化为「一次值得花模型调用」的触发器。
 *
 * 四件套（§6.2）都在这里落地：
 *  1. 开关      —— enabled + 规则级 enabled
 *  2. 去抖合并  —— debounceMs 窗口，记 firstEvent 以保留"持续了多久"
 *  3. 频率上限  —— 房间 / 全局每小时
 *  4. 防环      —— origin=ai 直接丢弃
 *  5. 预算上限  —— 交给 hasBudget 回调，超限不触发
 */
export class EventBus {
  private pending = new Map<string, Pending>();
  private roomHits = new Map<string, number[]>();
  private globalHits: number[] = [];

  private readonly cfg: EventBusConfig;
  private readonly onTrigger: (d: Extract<TriggerDecision, { fired: true }>) => void;
  private readonly onDecision: (e: DeviceEvent, d: TriggerDecision) => void;
  private readonly now: () => number;

  constructor(
    cfg: EventBusConfig,
    onTrigger: (d: Extract<TriggerDecision, { fired: true }>) => void,
    onDecision: (e: DeviceEvent, d: TriggerDecision) => void,
    now: () => number,
  ) {
    this.cfg = cfg;
    this.onTrigger = onTrigger;
    this.onDecision = onDecision;
    this.now = now;
  }

  get isEnabled(): boolean {
    return this.cfg.enabled;
  }

  /** 设备事件入口。所有过滤都在这里，下游只看到"该触发"的事件 */
  ingest(event: DeviceEvent, roomOf: (entityId: string) => string | undefined): void {
    if (!this.cfg.enabled) {
      this.onDecision(event, { fired: false, reason: "disabled" });
      return;
    }

    // 防环：AI 或规则自己造成的状态变化，绝不能再触发一轮 AI
    if (event.origin === "ai" || event.origin === "rule") {
      this.onDecision(event, { fired: false, reason: "loop_blocked" });
      return;
    }

    // 只关心状态变化；可用性变化不触发推理
    if (event.kind !== "state_changed") return;

    const key = `${event.entity_id}#${event.attribute ?? "state"}`;
    const existing = this.pending.get(key);

    if (existing) {
      // 合并：更新终值，保留 firstEvent —— 缺了它就判断不出"持续了多久"
      existing.lastEvent = event;
      this.onDecision(event, { fired: false, reason: "merged" });
      return;
    }

    const timer = setTimeout(() => this.flush(key, roomOf), this.cfg.debounceMs);
    this.pending.set(key, { firstEvent: event, lastEvent: event, timers: timer });
  }

  /** 窗口结束：做频率与预算校验，通过则提交一次触发 */
  private flush(key: string, roomOf: (entityId: string) => string | undefined): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);

    const now = this.now();
    const room = roomOf(p.lastEvent.entity_id) ?? "__unknown__";

    if (!this.withinRate(room, now)) {
      this.onDecision(p.lastEvent, { fired: false, reason: "rate_limited" });
      return;
    }
    if (!this.cfg.hasBudget()) {
      this.onDecision(p.lastEvent, { fired: false, reason: "budget_exceeded" });
      return;
    }

    this.recordHit(room, now);
    this.onTrigger({
      fired: true,
      firstEvent: p.firstEvent,
      lastEvent: p.lastEvent,
      // 终值取最后一次事件的新值，持续时长由 firstEvent.ts → lastEvent.ts 表达
      finalValue: p.lastEvent.new,
    });
  }

  private withinRate(room: string, now: number): boolean {
    const hour = 3_600_000;
    this.globalHits = this.globalHits.filter((t) => now - t < hour);
    const roomList = (this.roomHits.get(room) ?? []).filter((t) => now - t < hour);
    this.roomHits.set(room, roomList);

    return (
      this.globalHits.length < this.cfg.limit.globalPerHour &&
      roomList.length < this.cfg.limit.perRoomPerHour
    );
  }

  private recordHit(room: string, now: number): void {
    this.globalHits.push(now);
    this.roomHits.set(room, [...(this.roomHits.get(room) ?? []), now]);
  }

  /**
   * 测试用：清空速率窗口与待发任务。
   * 只给 /_mock 路由用 —— 生产环境绝不能靠"重置限流"绕过保护。
   */
  reset(): void {
    this.dispose();
    this.roomHits.clear();
    this.globalHits = [];
  }

  /** 测试与关停用：丢弃所有待发任务 */
  dispose(): void {
    for (const p of this.pending.values()) clearTimeout(p.timers);
    this.pending.clear();
  }

  /** 仅用于测试观察 */
  get pendingCount(): number {
    return this.pending.size;
  }
}