import type { DeviceEvent, Entity, EntityState, ServiceCommand, ServiceResult } from "@homeclaw/contracts";
import type { DeviceAdapter, Unsubscribe } from "./types.ts";
import { applyService as applyServiceShared, createEntities, diffState, nowSeconds, SEED_SCENES } from "@homeclaw/contracts";

export type MockEntity = Entity;

/**
 * MockAdapter（§3.4）：HA 未就绪时的顶替实现。
 * 关键要求：
 *  - callService 真实改变状态并产生事件（用于验证防环与去抖）
 *  - 支持 injectEvent 注入传感器事件，模拟真实触发
 *  - 状态变更必须带 origin，让 EventBus 能判定是否为 AI 引发的（防环依据）
 */
export class MockAdapter implements DeviceAdapter {
  readonly kind = "mock" as const;

  private entities = new Map<string, Entity>();
  private listeners = new Set<(e: DeviceEvent) => void>();
  /** 幂等记录：同 key 的事件只生效一次 */
  private applied = new Map<string, EntityState>();

  private readonly homeId: string;

  constructor(homeId: string, opts: { profile?: "basic" | "full" } = {}) {
    this.homeId = homeId;
    this.entities = createEntities(homeId, { profile: opts.profile ?? "basic" });

    // 影子事件源：真实 HA 里这些传感器通常已有，但 MockAdapter 的 12 实体契约不含它们。
    // 预声明房间，是为了让 §6.4 的示例规则（人来开灯、门窗、水浸）能在这里跑通。
    this.declareShadow("binary_sensor.living_room_presence", "客厅", "客厅人体存在");
    this.declareShadow("binary_sensor.bedroom_door", "主卧", "主卧门窗");
    this.declareShadow("sensor.living_room_pm25", "客厅", "客厅 PM2.5");
  }

  async listEntities(_homeId: string): Promise<Entity[]> {
    return [...this.entities.values()];
  }

  async getState(entityId: string): Promise<EntityState> {
    const e = this.entities.get(entityId);
    if (e) return { ...e.state };

    // 影子事件源：状态存在于 shadows，同样可读（规则引擎的 for_seconds 复查依赖它）
    const shadow = this.shadows.get(entityId);
    if (shadow) return { ...shadow.state };

    throw new Error(`实体不存在: ${entityId}`);
  }

  async callService(cmd: ServiceCommand): Promise<ServiceResult> {
    const started = performance.now();

    // 幂等：同一 key 直接返回上次结果，不重复产生事件
    const prev = this.applied.get(cmd.idempotency_key);
    if (prev) {
      return { ok: true, state: prev, elapsed_ms: 0 };
    }

    const entity = this.entities.get(cmd.entity_id);
    if (!entity) return { ok: false, elapsed_ms: 0, error: `实体不存在: ${cmd.entity_id}` };
    if (!entity.available) return { ok: false, elapsed_ms: 0, error: `${entity.name} 当前离线` };

    let next: Entity;
    try {
      next = applyServiceShared(entity, cmd.service, cmd.data, nowSeconds());
    } catch (err) {
      return { ok: false, elapsed_ms: Math.round(performance.now() - started), error: err instanceof Error ? err.message : "执行失败" };
    }

    this.entities.set(entity.id, next);
    this.applied.set(cmd.idempotency_key, next.state);

    // 状态差异 → 事件（真实适配器由 HA 上报，这里主动补发以对齐语义）
    for (const change of diffState(entity.state, next.state)) {
      this.emit({
        id: eventId(),
        home_id: next.home_id,
        entity_id: next.id,
        kind: "state_changed",
        attribute: change.attribute,
        old: change.old,
        new: change.new,
        // 关键：origin 由调用方声明，AI 引发的会被 EventBus 硬阻断
        origin: cmd.origin,
        trace_id: cmd.trace_id,
        ts: nowSeconds(),
      });
    }

    return { ok: true, state: next.state, elapsed_ms: Math.round(performance.now() - started) };
  }

  async subscribeEvents(_homeId: string, cb: (e: DeviceEvent) => void): Promise<Unsubscribe> {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async healthCheck() {
    return { ok: true, detail: `mock / ${this.entities.size} entities` };
  }

  /**
   * 注入传感器事件，等价于真实设备上报。
   *
   * 未建模的实体（如 binary_sensor.living_room_presence）走"影子事件源"：
   * 只记录状态、只发事件，**不进 listEntities**。
   *
   * 为什么要这样而不是直接造一个实体：
   *  §3.4 约定 MockAdapter 内置 12 个实体（3 房间 × 4），面板与验收都按 12 个断言。
   *  注入一个人体传感器就变成 13 个，会把"设备面板"变成"测试脚手架"。
   *  而真实世界里，事件本来就可能来自未建模的设备（HA 里临时接的一个传感器），
   *  所以"事件源可以不在实体表里"是符合现实的语义，不是取巧。
   */
  injectEvent(entityId: string, newValue: unknown, attribute = "state"): DeviceEvent {
    const entity = this.entities.get(entityId);

    if (!entity) {
      const shadow = this.shadows.get(entityId);
      const oldValue = shadow?.state[attribute];
      const next: Entity = {
        id: entityId,
        home_id: this.homeId,
        name: shadow?.name ?? entityId,
        room: shadow?.room ?? "客厅",
        type: "binary_sensor",
        capabilities: ["detect"],
        state: { ...(shadow?.state ?? {}), [attribute]: newValue },
        available: true,
        updated_at: nowSeconds(),
      };
      this.shadows.set(entityId, { name: next.name, room: next.room, state: next.state });

      const ev: DeviceEvent = {
        id: eventId(), home_id: this.homeId, entity_id: entityId,
        kind: "state_changed", attribute, old: oldValue, new: newValue,
        origin: "device", ts: nowSeconds(),
      };
      this.emit(ev);
      return ev;
    }

    const oldValue = entity.state[attribute];
    entity.state = { ...entity.state, [attribute]: newValue };
    entity.updated_at = nowSeconds();

    const ev: DeviceEvent = {
      id: eventId(),
      home_id: entity.home_id,
      entity_id: entityId,
      kind: "state_changed",
      attribute,
      old: oldValue,
      new: newValue,
      origin: "device",
      ts: nowSeconds(),
    };
    this.emit(ev);
    return ev;
  }

  /** 影子事件源：只服务事件注入，不出现在实体列表里 */
  private shadows = new Map<string, { name: string; room: string; state: Record<string, unknown> }>();

  /** 幽灵事件源也允许声明房间，否则房间级限流会把它算进 __unknown__ */
  declareShadow(entityId: string, room: string, name: string): void {
    if (this.entities.has(entityId)) return;
    this.shadows.set(entityId, { name, room, state: this.shadows.get(entityId)?.state ?? {} });
  }

  listShadows(): Array<{ id: string; room: string; name: string }> {
    return [...this.shadows.entries()].map(([id, v]) => ({ id, room: v.room, name: v.name }));
  }

  setAvailable(entityId: string, available: boolean): void {
    const entity = this.entities.get(entityId);
    if (!entity) return;
    entity.available = available;
    entity.updated_at = nowSeconds();
    this.emit({
      id: eventId(),
      home_id: entity.home_id,
      entity_id: entityId,
      kind: "availability_changed",
      old: !available,
      new: available,
      origin: "device",
      ts: nowSeconds(),
    });
  }

  private emit(e: DeviceEvent): void {
    for (const cb of this.listeners) {
      try { cb(e); } catch { /* 单个订阅者异常不影响其他订阅者 */ }
    }
  }
}

export { SEED_SCENES };

function eventId(): string {
  return "e_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}