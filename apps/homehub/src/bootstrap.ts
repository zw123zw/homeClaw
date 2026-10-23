import type { HubConfig } from "./config.ts";
import { Db } from "./db/index.ts";
import { createAdapter } from "./adapter/factory.ts";
import { createPolicy } from "./policy/index.ts";
import { Audit } from "./audit/index.ts";
import { Sessions } from "./sessions/index.ts";
import { EventBus } from "./eventbus/index.ts";
import { EventStream } from "./events/index.ts";
import { CommandPipeline } from "./command.ts";
import { ToolHub } from "./toolhub/index.ts";
import { RuleEngine, DEFAULT_RULES } from "./automation/engine.ts";
import { Preferences } from "./preferences/index.ts";
import { createSceneRunner } from "./scenes/index.ts";
import { makeIds, type HomeRuntime } from "./runtime.ts";
import { SEED_SCENES, nowSeconds } from "@homeclaw/contracts";

export type RuntimeOptions = {
  /** 测试用：允许把去抖窗口调小 */
  overrides?: Partial<{ debounceMs: number; eventBusEnabled: boolean; rulesEnabled: boolean }>;
};

/**
 * 组装一个 home 的运行时。
 *
 * 依赖顺序是显式的，不能调换：
 *   DB → adapter → policy → audit → sessions → pipeline
 *   → sceneRunner → eventBus → rules → toolhub
 *
 * 为什么 eventBus 在 rules 之前：eventBus 的去抖产出"一次值得处理的触发"，
 * rules 与 LLM 都是这条触发的下游消费者。反过来接会让规则看到每一次原始抖动。
 */
export function createRuntime(config: HubConfig, opts: RuntimeOptions = {}): HomeRuntime {
  const newId = makeIds();
  const db = new Db(config.dbPath);
  const adapter = createAdapter(config);
  const policy = createPolicy(config);
  const audit = new Audit(db, nowSeconds);
  const sessions = new Sessions(db, config.homeId, nowSeconds);
  const preferences = new Preferences(db, config.homeId, nowSeconds);
  const events = new EventStream();

  const pipeline = new CommandPipeline({
    db, homeId: config.homeId, adapter, policy, audit, now: nowSeconds, newId,
  });

  // 设备 → 房间映射缓存：EventBus 每次触发都要用，不能每次 listEntities
  const roomByEntity = new Map<string, string>();
  let scenesCache: typeof SEED_SCENES | null = null;
  const scenes = () => {
    scenesCache ??= SEED_SCENES.filter((s) => s.home_id === config.homeId);
    return scenesCache;
  };

  const roomOf = (entityId: string): string | undefined => roomByEntity.get(entityId);

  // 场景执行器：HTTP / ToolHub / 规则引擎三处共用
  const runScene = createSceneRunner({ scenes, pipeline });

  /* ---------------- 规则引擎 ----------------
     必须在 eventBus 之前构造，因为 eventBus 的触发回调要调用它。
     构造后立即 seed 默认规则：规则表为空会让"关掉 LLM 后系统还能动"这条验收无从执行。 */
  const rules = new RuleEngine({
    db, homeId: config.homeId, pipeline, audit, now: nowSeconds, newId,
    getEntityState: async (entityId) => {
      try {
        return await adapter.getState(entityId);
      } catch {
        // 实体不存在（例如影子事件源）时返回 undefined，让 for_seconds 复查走"不执行"分支
        return undefined;
      }
    },
    runScene: async (name, traceId, actor) => {
      const r = await runScene(name, traceId, actor);
      return { ok: r.ok, results: r.results.map((x) => ({ entity: x.entity, ok: x.ok, error: x.error })) };
    },
  });
  rules.seed(DEFAULT_RULES);

  const rulesEnabled = opts.overrides?.rulesEnabled ?? (process.env.RULES_ENABLED !== "false");

  const eventBus = new EventBus(
    {
      enabled: opts.overrides?.eventBusEnabled ?? (process.env.EVENTBUS_ENABLED !== "false"),
      debounceMs: opts.overrides?.debounceMs ?? Number(process.env.DEBOUNCE_MS ?? 10_000),
      limit: {
        perRoomPerHour: Number(process.env.RATE_ROOM_EVENTS_PER_HOUR ?? 6),
        globalPerHour: Number(process.env.RATE_GLOBAL_EVENTS_PER_HOUR ?? 60),
      },
      // 预算检查：一期从 usage 表读当日累计
      hasBudget: () => {
        const day = new Date().toISOString().slice(0, 10);
        const row = db.one<{ tokens: number; cny_milli: number }>(
          "SELECT tokens, cny_milli FROM usage WHERE home_id = ? AND day = ?",
          config.homeId, day,
        );
        const tokens = row?.tokens ?? 0;
        const cny = (row?.cny_milli ?? 0) / 1000;
        return tokens < config.policy.budget.dailyTokens && cny < config.policy.budget.dailyCny;
      },
    },
    /*
     * 触发回调：一次"值得处理"的事件已经过防环 / 去抖 / 频率 / 预算四道闸门。
     * 下游有两类消费者：
     *   1. 规则引擎 —— 确定性，永远执行（LLM 关掉也要跑，§6.4）；
     *   2. LLM 推理 —— M4 接入，这里只记录，不假装已经推给 Gateway。
     */
    (trigger) => {
      const durationSec = trigger.lastEvent.ts - trigger.firstEvent.ts;

      audit.record({
        homeId: config.homeId,
        traceId: trigger.lastEvent.trace_id ?? newId("tr"),
        actor: "system:eventbus",
        action: "automation.trigger",
        target: trigger.lastEvent.entity_id,
        params: {
          attribute: trigger.lastEvent.attribute,
          from: trigger.firstEvent.old,
          to: trigger.finalValue,
          // 持续时长是 LLM 判断"有人进来多久了"的必要信息，不能只看终值
          duration_seconds: durationSec,
          merged_events: durationSec > 0 ? "multiple" : "single",
        },
        decision: "allow",
        reason: "ok",
        result: "ok",
        origin: "device",
        elapsedMs: 0,
      });

      if (!rulesEnabled) return;

      // 规则执行是异步的：不阻塞事件循环，但失败必须自己落库（rule_run），不能静默
      void rules
        .handleEvent(trigger.lastEvent, { durationSeconds: durationSec })
        .catch((err) => console.error("[rules] 规则执行异常：", err));
    },
    // 每次裁决都留痕，便于统计"多少事件被去抖/限流挡住"
    (event, decision) => {
      if (decision.fired) return;
      if (decision.reason === "merged") return; // 合并是正常路径，不逐条记
      db.run(
        "INSERT INTO trigger_log (home_id, entity_id, room, ts, outcome) VALUES (?,?,?,?,?)",
        config.homeId, event.entity_id, roomOf(event.entity_id) ?? null, nowSeconds(), decision.reason,
      );
    },
    nowSeconds,
  );

  // 初始化房间映射，并订阅设备事件；同一份事件同时喂给 EventBus 与面板流
  void adapter.listEntities(config.homeId).then((list) => {
    for (const e of list) roomByEntity.set(e.id, e.room);
    // MockAdapter 的影子事件源也要有房间，否则房间级限流会把它们算作 __unknown__
    const shadows = (adapter as unknown as { listShadows?: () => Array<{ id: string; room: string }> }).listShadows?.() ?? [];
    for (const sh of shadows) roomByEntity.set(sh.id, sh.room);
  });

  let unsubscribe: () => void = () => {};
  void adapter.subscribeEvents(config.homeId, (event) => {
    if (!roomByEntity.has(event.entity_id)) {
      // 事件先于 listEntities 到达时不能留空房间：房间级限流会把它算进 __unknown__
      void adapter.listEntities(config.homeId).then((list) => {
        for (const e of list) roomByEntity.set(e.id, e.room);
      });
    }
    events.publish(event);
    eventBus.ingest(event, roomOf);

    // 规则引擎也要看到"可用性变化"这类不进 EventBus 的事件（离线审计规则依赖它）
    if (rulesEnabled && event.kind !== "state_changed") {
      void rules.handleEvent(event, { durationSeconds: 0 }).catch(() => {});
    }
  }).then((fn) => {
    unsubscribe = fn;
  });

  const base = {
    config,
    adapter,
    db,
    policy,
    audit,
    sessions,
    preferences,
    eventBus,
    events,
    pipeline,
    rules,
    runScene,
    unsubscribe: () => unsubscribe(),
    scenes,
    roomOf,
    shutdown: () => {
      unsubscribe();
      eventBus.dispose();
      rules.dispose();
      db.close();
    },
  };

  // 依赖顺序：base（DB/adapter/policy/audit/pipeline/eventbus/rules）→ toolhub → 完整 rt
  const toolhub = new ToolHub(base);
  void toolhub.warmup();

  return { ...base, toolhub };
}