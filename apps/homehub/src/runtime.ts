import type { DeviceAdapter } from "./adapter/types.ts";
import type { Db } from "./db/index.ts";
import type { Policy } from "./policy/index.ts";
import type { Audit } from "./audit/index.ts";
import type { Sessions } from "./sessions/index.ts";
import type { EventBus } from "./eventbus/index.ts";
import type { EventStream } from "./events/index.ts";
import type { CommandPipeline } from "./command.ts";
import type { ToolHub } from "./toolhub/index.ts";
import type { RuleEngine } from "./automation/engine.ts";
import type { Preferences } from "./preferences/index.ts";

import type { HubConfig } from "./config.ts";
import type { Entity, Scene } from "@homeclaw/contracts";

/**
 * HomeRuntime：一个 home 的全部运行时依赖。
 * 一期只实例化一个，但禁止全局单例 —— 所有模块按 home 注入，
 * 这样"M6 支持多 home"只是多 new 几次，而不是重构。
 */
export type HomeRuntime = {
  config: HubConfig;
  adapter: DeviceAdapter;
  db: Db;
  policy: Policy;
  audit: Audit;
  sessions: Sessions;
  eventBus: EventBus;
  /** 面板实时推送的扇出口（与 eventBus 并行消费 adapter 事件） */
  events: EventStream;
  pipeline: CommandPipeline;
  /** MCP 工具层：AI 访问 HomeHub 的唯一入口 */
  toolhub: ToolHub;
  /** 确定性规则引擎：与 LLM 并存，断网也必须能跑 */
  rules: RuleEngine;
  /** 场景执行器：HTTP 路由、规则引擎、ToolHub 三处共用同一实现 */
  runScene: (sceneIdOrName: string, traceId: string, actor: string) => Promise<{ ok: boolean; traceId: string; results: Array<{ entity: string; service: string; ok: boolean; error?: string; elapsed_ms: number }> }>;
  /** 用户偏好（记忆）：显式键值对，AI 只读、用户可改 */
  preferences: Preferences;

  /** 设备事件订阅的注销句柄 */
  unsubscribe: () => void;
  /** 场景读取：一期从种子加载，二期改为 DB */
  scenes: () => Scene[];
  /** 按实体取房间，EventBus 需要它做房间级限流 */
  roomOf: (entityId: string) => string | undefined;
  shutdown: () => void;
};

export function makeIds() {
  let counter = 0;
  return (prefix: string): string => {
    counter = (counter + 1) % 1_000_000;
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
  };
}

export function makeTraceIds() {
  return makeIds();
}

export type { Entity };