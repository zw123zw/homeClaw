<script setup lang="ts">
import { computed, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/api/client";
import AppIcon from "@/components/AppIcon.vue";

/**
 * 审计页（§7.2）：每一次设备操作、每一次被拒绝的调用，都能在这里追到。
 *
 * 为什么值得单独做一个页面而不只是接口：
 *  "不可静默失败"这条约束只有在失败**看得见**的时候才成立。
 *  一个只在日志里存在的拒绝，对用户等于没发生。
 */

const limit = ref(100);
const filter = ref<"all" | "deny">("all");

const audit = useQuery({
  queryKey: ["audit", limit],
  queryFn: () => api.audit({ limit: limit.value }),
  refetchInterval: 15_000,
});

const rows = computed(() => {
  const all = audit.data.value ?? [];
  return filter.value === "deny" ? all.filter((a) => a.decision === "deny") : all;
});

const denyCount = computed(() => (audit.data.value ?? []).filter((a) => a.decision === "deny").length);

const REASON: Record<string, string> = {
  ok: "正常",
  policy_whitelist: "实体不在白名单",
  policy_service: "服务不被允许",
  hard_deny: "硬拒绝清单（保险丝）",
  rate_limited: "频率超限",
  budget_exceeded: "预算超限",
  loop_blocked: "防环拦截",
  idempotent_replay: "幂等重放",
  adapter_error: "适配器错误",
};

function fmt(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

function paramsText(p: Record<string, unknown>): string {
  const entries = Object.entries(p).filter(([k]) => k !== "detail");
  if (entries.length === 0) return "-";
  return entries.map(([k, v]) => k + "=" + JSON.stringify(v)).join(" ");
}

async function exportJson() {
  const blob = new Blob([JSON.stringify(audit.data.value ?? [], null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "homeclaw-audit.json";
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title"><AppIcon name="audit" />审计</h1>
      <p class="page-sub">
        全量留痕：谁改了什么、走到哪一步被拦下。trace_id 可以把一次请求的多条记录串起来。
      </p>
    </div>

    <div class="row" style="margin-bottom: 14px">
      <button
        type="button"
        class="chip"
        :class="{ on: filter === 'all' }"
        :aria-pressed="filter === 'all'"
        @click="filter = 'all'"
      >
        全部 {{ audit.data.value?.length ?? 0 }}
      </button>
      <button
        type="button"
        class="chip"
        :class="{ on: filter === 'deny' }"
        :aria-pressed="filter === 'deny'"
        @click="filter = 'deny'"
      >
        仅拒绝 {{ denyCount }}
      </button>
      <button type="button" class="ghost" style="margin-left: auto" @click="exportJson">导出 JSON</button>
      <button type="button" class="icon-btn" aria-label="刷新" @click="audit.refetch()">
        <AppIcon name="refresh" />
      </button>
    </div>

    <div v-if="audit.isError.value" class="empty">审计加载失败：{{ audit.error.value?.message }}</div>
    <div v-else-if="!audit.data.value" class="empty">加载中…</div>
    <div v-else-if="rows.length === 0" class="empty">暂无记录</div>

    <div v-else class="card card--flush">
      <table class="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>来源</th>
            <th>动作</th>
            <th>目标</th>
            <th>参数</th>
            <th>裁决</th>
            <th>原因</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(a, i) in rows" :key="a.trace_id + '-' + i" :class="{ deny: a.decision === 'deny' }">
            <td class="mono">{{ fmt(a.ts) }}</td>
            <td><span class="badge" :class="a.actor.startsWith('ai') ? 'run' : 'ok'">{{ a.actor }}</span></td>
            <td class="mono">{{ a.action }}</td>
            <td class="mono">{{ a.target }}</td>
            <td class="mono dim" style="max-width: 260px; overflow: hidden; text-overflow: ellipsis">
              {{ paramsText(a.params) }}
            </td>
            <td>
              <span class="badge" :class="a.decision === 'allow' ? 'ok' : 'fail'">
                {{ a.decision === "allow" ? "放行" : "拒绝" }}
              </span>
            </td>
            <td class="dim">{{ REASON[a.reason] ?? a.reason }}</td>
            <td class="mono dim">{{ a.elapsed_ms }}ms</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
