import type { Entity } from "@homeclaw/contracts";
import type { HubConfig, PolicyConfig } from "../config.ts";

export type PolicyDecision =
  | { allow: true }
  | {
      allow: false;
      reason: "policy_whitelist" | "policy_service" | "hard_deny" | "rate_limited" | "budget_exceeded";
      detail: string;
    };

/** 通配匹配：支持 `lock.*` 这类前缀规则 */
function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

function anyMatch(patterns: string[], value: string): boolean {
  return patterns.some((p) => matches(p, value));
}

/** 一小时滑动窗口调用计数。内存实现：盒子重启清零，代价可接受 */
class SlidingWindow {
  private hits = new Map<string, number[]>();
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  private live(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, list);
    return list;
  }

  count(key: string, now: number): number {
    return this.live(key, now).length;
  }

  record(key: string, now: number): void {
    this.live(key, now).push(now);
  }
}

/**
 * Policy：唯一决定「这条 Command 能不能执行」的地方。
 * 检查顺序很重要 —— 硬拒绝必须最先，否则白名单里误加了门锁也拦不住。
 */
export class Policy {
  private readonly entityWindow = new SlidingWindow(3_600_000);
  private readonly roomWindow = new SlidingWindow(3_600_000);
  private readonly globalWindow = new SlidingWindow(3_600_000);

  private readonly cfg: PolicyConfig;

  constructor(cfg: PolicyConfig) {
    this.cfg = cfg;
  }

  /** 硬拒绝清单：确定性保险丝，不进模型判断（§7.2） */
  isHardDenied(entityId: string): boolean {
    return anyMatch(this.cfg.hardDeny, entityId);
  }

  checkEntityAndService(entity: Entity, service: string): PolicyDecision {
    if (this.isHardDenied(entity.id)) {
      return { allow: false, reason: "hard_deny", detail: `${entity.id} 在硬拒绝清单内` };
    }
    if (this.cfg.entityWhitelist.length > 0 && !anyMatch(this.cfg.entityWhitelist, entity.id)) {
      return { allow: false, reason: "policy_whitelist", detail: `${entity.id} 不在实体白名单` };
    }
    if (this.cfg.serviceWhitelist.length > 0 && !anyMatch(this.cfg.serviceWhitelist, service)) {
      return { allow: false, reason: "policy_service", detail: `服务 ${service} 不在白名单` };
    }
    return { allow: true };
  }

  /** 频率上限：实体 / 房间 / 全局三层，任意一层超限即拒 */
  checkRate(entity: Entity, now: number): PolicyDecision {
    const { perEntityPerHour, perRoomPerHour, globalPerHour } = this.cfg.rateLimit;

    if (this.entityWindow.count(entity.id, now) >= perEntityPerHour) {
      return { allow: false, reason: "rate_limited", detail: `${entity.id} 每小时上限 ${perEntityPerHour}` };
    }
    if (this.roomWindow.count(entity.room, now) >= perRoomPerHour) {
      return { allow: false, reason: "rate_limited", detail: `房间 ${entity.room} 每小时上限 ${perRoomPerHour}` };
    }
    if (this.globalWindow.count("__global__", now) >= globalPerHour) {
      return { allow: false, reason: "rate_limited", detail: `全局每小时上限 ${globalPerHour}` };
    }
    return { allow: true };
  }

  /** 只有真正放行后才记数，被拒的请求不占配额 */
  recordUsage(entity: Entity, now: number): void {
    this.entityWindow.record(entity.id, now);
    this.roomWindow.record(entity.room, now);
    this.globalWindow.record("__global__", now);
  }
}

export function createPolicy(config: HubConfig): Policy {
  return new Policy(config.policy);
}