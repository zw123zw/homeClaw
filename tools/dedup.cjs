const fs = require("fs");

// ---- 1) mock-server/store.ts：改用 contracts 的共享实现 ----
let p = "apps/mock-server/src/store.ts";
let t = fs.readFileSync(p, "utf8");

// 删掉本地 applyService 整个函数
t = t.replace(/\/\*\* 把服务名翻译为状态变更；Mock 只覆盖一期会用到的服务 \*\/\nexport function applyService[\s\S]*?\n}\n\n/, "");

// 改为从 contracts 重导出，保持既有 import 不变
t = t.replace(
  'import type { Entity, AuditEntry, Message, Session } from "@homeclaw/contracts";',
  'import type { Entity, AuditEntry, Message, Session } from "@homeclaw/contracts";\nimport { applyService as applyServiceShared } from "@homeclaw/contracts";'
);
t = t.replace(
  'export const scenes = SCENES;',
  `export const scenes = SCENES;

/** 薄包装：补上当前时间戳，业务语义全部委托给 contracts 的单一实现 */
export function applyService(entity: Entity, service: string, data: Record<string, unknown>): Entity {
  return applyServiceShared(entity, service, data, NOW());
}`
);

// 种子数据改为引用 contracts
t = t.replace(
  'import { HOME_ID, NOW, SCENES, createEntities } from "./fixtures.ts";',
  'import { HOME_ID, SEED_SCENES as SCENES, createEntities, nowSeconds as NOW } from "@homeclaw/contracts";'
);

fs.writeFileSync(p, t, "utf8");
console.log("mock-server/store.ts deduped");

// ---- 2) homehub/adapter/mock.ts：改用共享实现 ----
p = "apps/homehub/src/adapter/mock.ts";
t = fs.readFileSync(p, "utf8");

// 删除本地 applyService 实现
t = t.replace(/\/\*\* Mock 支持的服务集合，与一期语义工具覆盖范围一致 \*\/\nexport function applyService[\s\S]*?\n  return next;\n}\n\n/, "");

t = t.replace(
  'import { NOW, SEED_ENTITIES, SEED_SCENES } from "./seed.ts";',
  'import { applyService as applyServiceShared, createEntities, diffState, nowSeconds, SEED_SCENES } from "@homeclaw/contracts";'
);

t = t.replace(
`  constructor(homeId: string) {
    for (const seed of SEED_ENTITIES) {
      this.entities.set(seed.id, { ...seed, home_id: homeId, state: { ...seed.state }, updated_at: NOW() });
    }
  }`,
`  constructor(homeId: string) {
    this.entities = createEntities(homeId);
  }`
);

t = t.replace(
`    let next: Entity;
    try {
      next = applyService(entity, cmd.service, cmd.data);
    } catch (err) {`,
`    let next: Entity;
    try {
      next = applyServiceShared(entity, cmd.service, cmd.data, nowSeconds());
    } catch (err) {`
);

t = t.replace(
`    // 状态差异 → 事件（真实适配器由 HA 上报，这里主动补发以对齐语义）
    for (const [attr, value] of Object.entries(next.state)) {
      if (JSON.stringify(entity.state[attr]) === JSON.stringify(value)) continue;
      this.emit({
        id: \`e_\${Date.now().toString(36)}\${Math.random().toString(36).slice(2, 6)}\`,
        home_id: next.home_id,
        entity_id: next.id,
        kind: "state_changed",
        attribute: attr,
        old: entity.state[attr],
        new: value,
        // 关键：origin 由调用方声明，AI 引发的会被 EventBus 硬阻断
        origin: cmd.origin,
        trace_id: cmd.trace_id,
        ts: NOW(),
      });
    }`,
`    // 状态差异 → 事件（真实适配器由 HA 上报，这里主动补发以对齐语义）
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
    }`
);

t = t.replaceAll("ts: NOW(),", "ts: nowSeconds(),");
t = t.replaceAll("entity.updated_at = NOW();", "entity.updated_at = nowSeconds();");
t = t.replaceAll("updated_at: NOW(),", "updated_at: nowSeconds(),");
t = t.replaceAll('id: `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,', "id: eventId(),");
t = t.replace("export { SEED_SCENES };", `export { SEED_SCENES };

function eventId(): string {
  return "e_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}`);

fs.writeFileSync(p, t, "utf8");
console.log("homehub/adapter/mock.ts deduped");
