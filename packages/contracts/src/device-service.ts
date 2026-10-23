import type { Entity } from "./entity.ts";

/**
 * 服务语义的唯一实现（深模块）：
 * 调用方只需知道「服务名 + 参数」，这里承担全部状态推导规则。
 * MockAdapter 与 mock-server 共用同一份，避免两份规则漂移。
 */
export class UnsupportedServiceError extends Error {
  constructor(service: string) {
    super(`不支持的服务: ${service}`);
    this.name = "UnsupportedServiceError";
  }
}

export class InvalidServiceDataError extends Error {
  constructor(field: string) {
    super(`缺少参数: ${field}`);
    this.name = "InvalidServiceDataError";
  }
}

/**
 * 纯函数：返回新的 Entity，不修改入参。
 * 抛错而不是静默失败：调用方据此区分「设备拒绝」和「网络故障」。
 */
export function applyService(
  entity: Entity,
  service: string,
  data: Record<string, unknown>,
  now: number,
): Entity {
  const next: Entity = { ...entity, state: { ...entity.state }, updated_at: now };

  switch (service) {
    case "turn_on":
      next.state.on = true;
      if (typeof data.brightness_pct === "number") next.state.brightness = data.brightness_pct;
      if (typeof data.color_temp_kelvin === "number") next.state.color_temp = data.color_temp_kelvin;
      break;

    case "turn_off":
      next.state.on = false;
      break;

    case "toggle":
      next.state.on = !next.state.on;
      break;

    case "set_brightness":
      if (typeof data.brightness_pct !== "number") throw new InvalidServiceDataError("brightness_pct");
      next.state.brightness = data.brightness_pct;
      // 0% 等同于关闭，避免出现"亮着但亮度为 0"的矛盾状态
      next.state.on = data.brightness_pct > 0;
      break;

    case "set_position":
      if (typeof data.position !== "number") throw new InvalidServiceDataError("position");
      next.state.position = data.position;
      break;

    case "open_cover":
      next.state.position = 100;
      break;

    case "close_cover":
      next.state.position = 0;
      break;

    case "set_temperature":
      if (typeof data.temperature !== "number") throw new InvalidServiceDataError("temperature");
      next.state.temperature = data.temperature;
      break;

    case "set_hvac_mode":
      if (typeof data.mode !== "string") throw new InvalidServiceDataError("mode");
      next.state.mode = data.mode;
      break;

    case "set_fan_mode":
      if (typeof data.mode !== "string" && typeof data.level !== "string") {
        throw new InvalidServiceDataError("mode/level");
      }
      next.state.mode = data.mode ?? data.level;
      next.state.on = true;
      break;

    default:
      throw new UnsupportedServiceError(service);
  }

  return next;
}

/** 一次服务调用会产生哪些状态字段变化，用于生成 DeviceEvent */
export function diffState(before: Entity["state"], after: Entity["state"]): Array<{ attribute: string; old: unknown; new: unknown }> {
  const changes: Array<{ attribute: string; old: unknown; new: unknown }> = [];
  for (const [attribute, value] of Object.entries(after)) {
    if (JSON.stringify(before[attribute]) === JSON.stringify(value)) continue;
    changes.push({ attribute, old: before[attribute], new: value });
  }
  return changes;
}