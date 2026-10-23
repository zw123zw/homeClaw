import type { DeviceAdapter } from "./types.ts";
import type { HubConfig } from "../config.ts";
import { MockAdapter } from "./mock.ts";

/**
 * 适配器工厂：这是 L3→L4 唯一的接缝（seam）。
 * 一期只注册 mock；HaAdapter 在 M5 就绪后在此加一个分支，上层零改动。
 */
export function createAdapter(config: HubConfig): DeviceAdapter {
  switch (config.adapter) {
    case "ha":
      // M5 前明确失败，避免"以为连上了 HA 其实在跑 mock"的静默错误
      throw new Error("HaAdapter 尚未实现（M5）。请设置 ADAPTER=mock，或等待 HomeAssistant 就绪。");
    case "mock":
    default:
      return new MockAdapter(config.homeId, { profile: config.mockProfile });
  }
}