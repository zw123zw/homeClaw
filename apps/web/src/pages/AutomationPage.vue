<script setup lang="ts">
/**
 * 自动化视图（场景页的第二个 tab）。
 *
 * 上半部分是规则编辑（AutomationConfig：字段化编辑器，改完立即 PATCH），
 * 下半部分是"最近触发"与"事件总线裁决"两张表 ——
 * 规则引擎会在用户没下指令时动设备，如果不能看到"这条规则刚才触发过 / 为什么没触发"，
 * 用户只会觉得灯自己在乱开关。可解释性是这个功能能用的前提。
 */
import { computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/api/client";
import AppIcon from "@/components/AppIcon.vue";
import AutomationConfig from "@/components/AutomationConfig.vue";

const emit = defineEmits<{ toast: [text: string, err?: boolean] }>();

const history = useQuery({
  queryKey: ["automation-history"],
  queryFn: () => api.automationHistory(30),
  refetchInterval: 20_000,
});
const triggers = useQuery({
  queryKey: ["automation-triggers"],
  queryFn: () => api.automationTriggers(50),
  refetchInterval: 20_000,
});

const outcomeText: Record<string, { label: string; cls: string }> = {
  merged: { label: "合并", cls: "ok" },
  debounced: { label: "去抖", cls: "ok" },
  loop_blocked: { label: "防环拦截", cls: "ok" },
  rate_limited: { label: "限流拒绝", cls: "fail" },
  fired: { label: "已触发", cls: "run" },
  unknown_room: { label: "未知房间", cls: "fail" },
};

const recent = computed(() => triggers.data.value ?? []);

function fmt(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title"><AppIcon name="automation" :size="18" />自动化</h1>
        <p class="page-sub">
          规则由 HomeHub 本地执行，不依赖模型。断网、断 LLM 时这些规则仍然生效（§6.4）。
        </p>
      </div>
    </header>

    <AutomationConfig @toast="(t, e) => emit('toast', t, e)" />

    <section class="auto-section">
      <h2 class="section-title">最近触发</h2>
      <p class="page-sub">
        包含被拦截的事件。出现「防环拦截」是好事：说明 AI 自己改的设备状态没有反过来再触发一次推理。
      </p>
      <div v-if="!history.data.value?.length" class="empty">还没有触发记录</div>
      <div v-else class="card card--flush">
        <table class="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>规则</th>
              <th>结果</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(h, i) in history.data.value" :key="'h' + i">
              <td class="mono">{{ fmt(h.ts) }}</td>
              <td class="mono">{{ h.automation_id }}</td>
              <td>
                <span class="badge" :class="h.matched ? 'ok' : 'run'">{{ h.matched ? "命中" : "未命中" }}</span>
              </td>
              <td class="dim">{{ h.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="auto-section">
      <h2 class="section-title">事件总线裁决</h2>
      <p class="page-sub">每个设备事件进 EventBus 后的去向（§6.3）。</p>
      <div v-if="!recent.length" class="empty">还没有事件</div>
      <div v-else class="card card--flush">
        <table class="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>实体</th>
              <th>房间</th>
              <th>裁决</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(t, i) in recent" :key="'t' + i">
              <td class="mono">{{ fmt(t.ts) }}</td>
              <td class="mono">{{ t.entity_id }}</td>
              <td>{{ t.room ?? "-" }}</td>
              <td>
                <span class="badge" :class="outcomeText[t.outcome]?.cls ?? 'run'">
                  {{ outcomeText[t.outcome]?.label ?? t.outcome }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
