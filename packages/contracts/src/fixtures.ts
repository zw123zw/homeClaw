import type { Entity, Scene } from "@homeclaw/contracts";

export const HOME_ID = "h_demo0001";

export const nowSeconds = () => Math.floor(Date.now() / 1000);

type Seed = {
  id: string;
  name: string;
  room: string;
  type: Entity["type"];
  capabilities: Entity["capabilities"];
  state: Record<string, unknown>;
  available?: boolean;
};

/** 12 个实体 = 3 房间 × (主灯 / 氛围灯 / 窗帘 / 温湿度)，其中 1 个刻意离线 */
export const SEEDS: Seed[] = [
  { id: "light.living_room_ceiling", name: "客厅主灯", room: "客厅", type: "light",
    capabilities: ["on_off", "brightness", "color_temp"], state: { on: true, brightness: 80, color_temp: 4000 } },
  { id: "light.living_room_accent", name: "客厅氛围灯", room: "客厅", type: "light",
    capabilities: ["on_off", "brightness", "color_temp", "color"], state: { on: false, brightness: 40, color_temp: 2700 } },
  { id: "cover.living_room_curtain", name: "客厅窗帘", room: "客厅", type: "cover",
    capabilities: ["position"], state: { position: 100, moving: false } },
  { id: "sensor.living_room_climate", name: "客厅温湿度", room: "客厅", type: "sensor",
    capabilities: ["temperature", "battery"], state: { temperature: 24.5, humidity: 52, battery: 91 } },

  { id: "light.bedroom_ceiling", name: "主卧主灯", room: "主卧", type: "light",
    capabilities: ["on_off", "brightness", "color_temp"], state: { on: false, brightness: 60, color_temp: 3500 } },
  { id: "light.bedroom_accent", name: "主卧氛围灯", room: "主卧", type: "light",
    capabilities: ["on_off", "brightness", "color_temp", "color"], state: { on: false, brightness: 20, color_temp: 2200 } },
  { id: "cover.bedroom_curtain", name: "主卧窗帘", room: "主卧", type: "cover",
    capabilities: ["position"], state: { position: 0, moving: false }, available: false },
  { id: "sensor.bedroom_climate", name: "主卧温湿度", room: "主卧", type: "sensor",
    capabilities: ["temperature", "battery"], state: { temperature: 23.1, humidity: 49, battery: 76 } },

  { id: "light.study_ceiling", name: "书房主灯", room: "书房", type: "light",
    capabilities: ["on_off", "brightness", "color_temp"], state: { on: true, brightness: 100, color_temp: 5000 } },
  { id: "light.study_accent", name: "书房氛围灯", room: "书房", type: "light",
    capabilities: ["on_off", "brightness", "color_temp", "color"], state: { on: true, brightness: 55, color_temp: 3000 } },
  { id: "cover.study_curtain", name: "书房窗帘", room: "书房", type: "cover",
    capabilities: ["position"], state: { position: 60, moving: false } },
  { id: "sensor.study_climate", name: "书房温湿度", room: "书房", type: "sensor",
    capabilities: ["temperature", "battery"], state: { temperature: 25.2, humidity: 45, battery: 64 } },
];

/**
 * 完整设备档（profile="full"）：在 12 个基础实体之外，补上空调 / 电视 / 扫地机 / 插座。
 *
 * 为什么不把它们并进 SEEDS：
 *  - §3.4 与 M0/M1 的验收都按"3 房间 × 4 = 12 个实体"断言面板容量，
 *    随手加两个实体就把"设备面板"的契约悄悄改了；
 *  - 但 M4 要验收"打开客厅灯并把空调调到 26 度"，没有空调这条永远过不了。
 * 所以做成显式档位：默认 basic（12 个，面板契约不变），
 * 需要验证多设备类推理时设 MOCK_PROFILE=full。
 */
export const EXTRA_SEEDS: Seed[] = [
  { id: "climate.living_room_ac", name: "客厅空调", room: "客厅", type: "climate",
    capabilities: ["on_off", "temperature", "mode"], state: { on: false, temperature: 26, mode: "cool" } },
  { id: "media_player.living_room_tv", name: "客厅电视", room: "客厅", type: "media_player",
    capabilities: ["on_off", "media"], state: { on: false, volume: 20 } },
  { id: "vacuum.living_room_robot", name: "客厅扫地机", room: "客厅", type: "vacuum",
    capabilities: ["on_off", "battery"], state: { on: false, battery: 88 } },
  { id: "switch.study_plug", name: "书房插座", room: "书房", type: "switch",
    capabilities: ["on_off", "power"], state: { on: true, power: 12.4 } },
];

export type EntitiesProfile = "basic" | "full";

export function createEntities(homeId: string = HOME_ID, opts: { profile?: EntitiesProfile } = {}): Map<string, Entity> {
  const ts = nowSeconds();
  const seeds = opts.profile === "full" ? [...SEEDS, ...EXTRA_SEEDS] : SEEDS;
  return new Map(
    seeds.map((s) => [
      s.id,
      {
        id: s.id,
        home_id: homeId,
        name: s.name,
        room: s.room,
        type: s.type,
        capabilities: s.capabilities,
        state: { ...s.state },
        available: s.available ?? true,
        updated_at: ts,
      } satisfies Entity,
    ]),
  );
}

export const SEED_SCENES: Scene[] = [
  {
    id: "scene.arrive_home", home_id: HOME_ID, name: "回家模式", icon: "home",
    actions: [
      { action: "entity.command", entity: "light.living_room_ceiling", service: "turn_on", data: { brightness_pct: 80 } },
      { action: "entity.command", entity: "light.living_room_accent", service: "turn_on", data: { brightness_pct: 40 } },
      { action: "entity.command", entity: "cover.living_room_curtain", service: "open_cover", data: {} },
    ],
  },
  {
    id: "scene.leave_home", home_id: HOME_ID, name: "离家模式", icon: "door",
    actions: [
      { action: "entity.command", entity: "light.living_room_ceiling", service: "turn_off", data: {} },
      { action: "entity.command", entity: "light.living_room_accent", service: "turn_off", data: {} },
      { action: "entity.command", entity: "light.bedroom_ceiling", service: "turn_off", data: {} },
      { action: "entity.command", entity: "light.study_ceiling", service: "turn_off", data: {} },
    ],
  },
  {
    id: "scene.movie", home_id: HOME_ID, name: "观影模式", icon: "film",
    actions: [
      { action: "entity.command", entity: "cover.living_room_curtain", service: "close_cover", data: {} },
      { action: "entity.command", entity: "light.living_room_ceiling", service: "turn_off", data: {} },
      { action: "entity.command", entity: "light.living_room_accent", service: "turn_on", data: { brightness_pct: 15 } },
    ],
  },
  {
    id: "scene.sleep", home_id: HOME_ID, name: "睡眠模式", icon: "moon",
    actions: [
      { action: "entity.command", entity: "light.living_room_ceiling", service: "turn_off", data: {} },
      { action: "entity.command", entity: "light.study_ceiling", service: "turn_off", data: {} },
      { action: "entity.command", entity: "cover.bedroom_curtain", service: "close_cover", data: {} },
    ],
  },
];