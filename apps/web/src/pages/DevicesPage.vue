<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from "vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import type { Entity } from "@homeclaw/contracts";
import { api, ApiError, openDeviceStream } from "@/api/client";
import AppIcon from "@/components/AppIcon.vue";

const emit = defineEmits<{ toast: [text: string, err?: boolean] }>();
const qc = useQueryClient();

/**
 * 面板数据：轮询做兜底，事件流做主路径。
 * 两者并存是有意的——事件流断了（旧后端 / 代理切断）面板必须是"慢一点"而不是"永远不更新"。
 */
const entities = useQuery({ queryKey: ["entities"], queryFn: () => api.entities(), refetchInterval: 15_000 });

const live = ref<"connecting" | "open" | "off">("connecting");

/**
 * 事件到达即失效实体查询：交给 vue-query 合并（多个事件 100ms 内到达只打一次请求）。
 * 用 onMounted 而不是顶层 await —— 顶层 await 会把组件变成 async 组件，必须包 Suspense。
 */
let closeStream: (() => void) | null = null;
onMounted(async () => {
  closeStream = await openDeviceStream(
    (event) => {
      void qc.invalidateQueries({ queryKey: ["entities"] });
      if (event.kind === "availability_changed") {
        emit("toast", `${event.entity_id} ${event.new ? "已恢复在线" : "已离线"}`, !event.new);
      }
    },
    (state) => {
      live.value = state === "open" ? "open" : "off";
    },
  );
});
onScopeDispose(() => closeStream?.());

const rooms = computed(() => {
  const map = new Map<string, Entity[]>();
  for (const e of entities.data.value ?? []) {
    map.set(e.room, [...(map.get(e.room) ?? []), e]);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
});

const offlineCount = computed(() => (entities.data.value ?? []).filter((e) => !e.available).length);
const busy = ref<string | null>(null);

async function run(entity: Entity, service: string, data: Record<string, unknown> = {}) {
  busy.value = entity.id;
  try {
    await api.command(entity.id, { service, data });
    await qc.invalidateQueries({ queryKey: ["entities"] });
  } catch (err) {
    const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : "操作失败";
    emit("toast", msg, true);
  } finally {
    busy.value = null;
  }
}

const DEVICE_ICON: Record<string, "light" | "cover" | "sensor" | "plug" | "devices" | "temperature" | "vacuum" | "tv"> = {
  light: "light",
  cover: "cover",
  sensor: "sensor",
  binary_sensor: "sensor",
  switch: "plug",
  fan: "sensor",
  climate: "temperature",
  vacuum: "vacuum",
  media_player: "tv",
  lock: "devices",
  camera: "devices",
};

/** 设备类型的中文标签：面板上"climate"没人看得懂 */
const TYPE_LABEL: Record<string, string> = {
  light: "灯",
  cover: "窗帘",
  climate: "空调",
  fan: "新风",
  switch: "插座",
  sensor: "传感器",
  binary_sensor: "传感器",
  media_player: "影音",
  vacuum: "扫地机",
  lock: "门锁",
  camera: "摄像头",
  energy: "能耗",
};

function isOn(e: Entity): boolean {
  return e.state.on === true;
}

function stateText(e: Entity): string {
  if (!e.available) return "离线 · 无法控制";
  if (e.type === "light") {
    return isOn(e)
      ? `开 · ${String(e.state.brightness ?? "-")}% · ${String(e.state.color_temp ?? "-")}K`
      : "关";
  }
  if (e.type === "cover") return `开合 ${String(e.state.position ?? "-")}%`;
  if (e.type === "sensor") {
    // 传感器状态字段不统一：温湿度、PM2.5、电量都可能出现，按存在顺序拼
    const bits: string[] = [];
    if (e.state.temperature !== undefined) bits.push(`${e.state.temperature}°C`);
    if (e.state.humidity !== undefined) bits.push(`${e.state.humidity}%`);
    if (e.state.pm25 !== undefined) bits.push(`PM2.5 ${e.state.pm25}`);
    if (e.state.battery !== undefined) bits.push(`电量 ${e.state.battery}%`);
    return bits.length ? bits.join(" · ") : "-";
  }
  if (e.type === "climate") {
    const on = isOn(e);
    const temp = e.state.temperature !== undefined ? ` ${e.state.temperature}°C` : "";
    const mode = e.state.mode ? ` · ${String(e.state.mode)}` : "";
    return on ? `开${temp}${mode}` : "关";
  }
  if (e.type === "media_player") return isOn(e) ? `播放中 · 音量 ${String(e.state.volume ?? "-")}` : "关闭";
  if (e.type === "vacuum") {
    const battery = e.state.battery !== undefined ? ` · 电量 ${e.state.battery}%` : "";
    return (isOn(e) ? "清扫中" : "待机") + battery;
  }
  return isOn(e) ? "开" : "关";
}

/** 空调调温：一次 ±1°C，避免滑块在 16–30 之间乱跳 */
async function nudgeTemp(e: Entity, delta: number) {
  const cur = Number(e.state.temperature ?? 26);
  const next = Math.min(30, Math.max(16, cur + delta));
  await run(e, "set_temperature", { temperature: next });
}

async function setBrightness(e: Entity, event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  await run(e, "set_brightness", { brightness_pct: value });
}

const sliderId = (id: string) => `br-${id.replace(/\W/g, "_")}`;
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title"><AppIcon name="devices" :size="18" />设备</h1>
        <p class="page-sub">实时反映本机中枢的设备状态；事件流断开时自动退回轮询。</p>
      </div>
      <span class="live" :class="live" role="status" aria-live="polite">
        <span class="pulse" :class="live === 'open' ? 'ok' : live === 'connecting' ? 'warn' : 'err'" aria-hidden="true" />
        {{ live === "open" ? "实时事件流" : live === "connecting" ? "连接中" : "轮询模式" }}
      </span>
    </header>

    <div v-if="entities.isError.value" class="empty">设备加载失败：{{ entities.error.value?.message }}</div>
    <div v-else-if="!entities.data.value" class="empty">加载中…</div>
    <div v-else-if="!rooms.length" class="empty">还没有发现设备</div>

    <section v-for="[room, list] in rooms" :key="room" class="room-group">
      <h2 class="room-title">{{ room }} · {{ list.length }}</h2>
      <div class="device-grid">
        <article
          v-for="e in list"
          :key="e.id"
          class="device"
          :class="{ offline: !e.available, on: e.available && isOn(e) }"
          :aria-label="`${e.name}，${stateText(e)}`"
        >
          <div class="device__head">
            <AppIcon :name="DEVICE_ICON[e.type] ?? 'devices'" :size="15" />
            <span class="device__name">{{ e.name }}</span>
            <span class="device__type">{{ TYPE_LABEL[e.type] ?? e.type }}</span>
          </div>
          <div class="device__state">{{ stateText(e) }}</div>

          <div v-if="e.type === 'light' || e.type === 'switch'" class="row">
            <button
              type="button"
              :class="isOn(e) ? 'ghost' : 'primary'"
              :disabled="!e.available || busy === e.id"
              @click="run(e, isOn(e) ? 'turn_off' : 'turn_on')"
            >
              {{ isOn(e) ? "关闭" : "打开" }}
            </button>
            <button
              v-if="e.capabilities.includes('brightness')"
              type="button"
              class="ghost"
              :disabled="!e.available || busy === e.id"
              @click="run(e, 'set_brightness', { brightness_pct: 30 })"
            >
              30%
            </button>
          </div>

          <div v-if="e.type === 'light' && e.capabilities.includes('brightness')">
            <label class="sr-only" :for="sliderId(e.id)">{{ e.name }} 亮度</label>
            <input
              :id="sliderId(e.id)"
              class="slider"
              type="range"
              min="1"
              max="100"
              :value="Number(e.state.brightness ?? 50)"
              :disabled="!e.available || busy === e.id"
              @change="setBrightness(e, $event)"
            />
          </div>

          <div v-if="e.type === 'cover'" class="row">
            <button type="button" :disabled="!e.available || busy === e.id" @click="run(e, 'open_cover')">打开</button>
            <button type="button" :disabled="!e.available || busy === e.id" @click="run(e, 'close_cover')">关闭</button>
          </div>

          <div v-if="e.type === 'climate'" class="row">
            <button type="button" class="ghost" :disabled="!e.available || busy === e.id" @click="nudgeTemp(e, -1)">−1°</button>
            <span class="mono dim">{{ String(e.state.temperature ?? "-") }}°C</span>
            <button type="button" class="ghost" :disabled="!e.available || busy === e.id" @click="nudgeTemp(e, 1)">+1°</button>
            <button
              type="button"
              :class="isOn(e) ? 'ghost' : 'primary'"
              :disabled="!e.available || busy === e.id"
              @click="run(e, isOn(e) ? 'turn_off' : 'turn_on')"
            >
              {{ isOn(e) ? "关闭" : "打开" }}
            </button>
          </div>

          <div v-if="e.type === 'media_player' || e.type === 'vacuum'" class="row">
            <button
              type="button"
              :class="isOn(e) ? 'ghost' : 'primary'"
              :disabled="!e.available || busy === e.id"
              @click="run(e, isOn(e) ? 'turn_off' : 'turn_on')"
            >
              {{ isOn(e) ? "停止" : e.type === "vacuum" ? "开始" : "播放" }}
            </button>
          </div>
        </article>
      </div>
    </section>

    <p v-if="entities.data.value?.length" class="page-foot">
      共 {{ entities.data.value.length }} 个实体 · 离线 {{ offlineCount }}
    </p>
  </div>
</template>