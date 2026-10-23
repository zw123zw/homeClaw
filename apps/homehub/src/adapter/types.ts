import type { DeviceEvent, Entity, EntityState, ServiceCommand, ServiceResult } from "@homeclaw/contracts";

export type Unsubscribe = () => void;

/**
 * L3 → L4 的唯一契约（§3.4）。
 * 一期用 MockAdapter，二期换 HaAdapter，上层代码零改动。
 */
export interface DeviceAdapter {
  readonly kind: "mock" | "ha";
  listEntities(homeId: string): Promise<Entity[]>;
  getState(entityId: string): Promise<EntityState>;
  /** 带幂等键：重复提交不应重复执行 */
  callService(cmd: ServiceCommand): Promise<ServiceResult>;
  subscribeEvents(homeId: string, cb: (e: DeviceEvent) => void): Promise<Unsubscribe>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}