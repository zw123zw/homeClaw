<script setup lang="ts">
/**
 * 设置中心。
 *
 * 四组：个人 / 模型 / 智能体 / 外观，另有一组"状态"用于排障。
 *  - 自动化是规则编辑，字段多、操作频繁，塞进弹窗里既挤又难用，已放回场景页；
 *  - 智能体（深度规划内核）是"装一次基本不动"的配置，与模型分开：改模型不该有动到运行时的风险。
 *
 * 面板本体用 TDesign 的 t-dialog：焦点陷阱、Esc、滚动锁、浮层层级都由它处理。
 * 审计弹窗必须 v-if 挂载：两个 dialog 同时存在会互相抢 zIndex，
 * 导致「按 Esc 关不掉最上层」这种诡异问题。
 */
import { computed, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/api/client";
import { platform } from "@/platform";
import { THEMES, useThemeStore, type ThemeKey } from "@/stores/theme";
import AppIcon from "./AppIcon.vue";
import ModelConfig from "./ModelConfig.vue";
import AgentSettings from "./AgentSettings.vue";
import ProfileSettings from "./ProfileSettings.vue";
import AuditPage from "@/pages/AuditPage.vue";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; toast: [text: string, err?: boolean] }>();

type Section = "profile" | "models" | "agent" | "appearance" | "status";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "profile", label: "个人" },
  { key: "models", label: "模型" },
  { key: "agent", label: "智能体" },
  { key: "appearance", label: "外观" },
  { key: "status", label: "状态" },
];

const section = ref<Section>("profile");
const theme = useThemeStore();
/** 运行状态折叠区 */

/** 审计弹窗：排障用的深挖工具，不占设置分类 */
const auditOpen = ref(false);

const health = useQuery({
  queryKey: ["health"],
  queryFn: api.health,
  enabled: computed(() => props.open),
  refetchInterval: 10_000,
});

function onVisibleChange(visible: boolean) {
  if (visible) return;
  auditOpen.value = false;
  emit("close");
}

function onAuditVisibleChange(visible: boolean) {
  if (!visible) auditOpen.value = false;
}

function chooseTheme(key: ThemeKey) {
  theme.setTheme(key);
}

const rows = computed(() => {
  const h = health.data.value;
  if (!h) return [];
  return [
    { k: "中枢版本", v: h.version },
    { k: "设备适配器", v: h.adapter.detail || h.adapter.status },
    { k: "推理网关", v: h.gateway.detail || h.gateway.status },
    { k: "语言模型", v: h.llm.detail || h.llm.status },
    { k: "数据库", v: h.db?.detail || h.db?.status || "-" },
    { k: "深度规划", v: h.hermes ? `${h.hermes.status} · ${h.hermes.detail}` : "-" },
    { k: "内置工具", v: h.tools ? `${h.tools.status} · ${h.tools.detail}` : "-" },
  ];
});

async function openLogs() {
  const ok = await platform().openLogs();
  emit("toast", ok ? "已打开日志目录" : "网页版无法打开本机目录", !ok);
}

const version = platform().version;
</script>

<template>
  <t-dialog
    :visible="open"
    header="设置"
    :footer="false"
    width="680px"
    placement="center"
    attach="body"
    :close-on-overlay-click="true"
    dialog-class-name="settings"
    @update:visible="onVisibleChange"
  >
    <template #body>
      <nav class="settings__tabs" aria-label="设置分类">
        <button
          v-for="s in SECTIONS"
          :key="s.key"
          type="button"
          class="settings__tab"
          :class="{ active: section === s.key }"
          :aria-current="section === s.key ? 'page' : undefined"
          @click="section = s.key"
        >
          {{ s.label }}
        </button>
      </nav>

      <div class="settings__panel">
        <ProfileSettings
          v-if="section === 'profile'"
          class="settings__body"
          @toast="(t: string, e?: boolean) => emit('toast', t, e)"
        />

        <ModelConfig
          v-else-if="section === 'models'"
          class="settings__body"
          @toast="(t: string, e?: boolean) => emit('toast', t, e)"
        />

        <AgentSettings
          v-else-if="section === 'agent'"
          class="settings__body"
          :active="section === 'agent'"
          @toast="(t: string, e?: boolean) => emit('toast', t, e)"
        />

        <div v-else-if="section === 'appearance'" class="settings__body">
          <header class="group__head">
            <h3 class="group__title">主题</h3>
            <p class="group__desc">暗色 / 亮色各三套。全部按 WCAG AA 校验过正文与状态色对比度。</p>
          </header>

          <div class="theme-grid">
            <button
              v-for="t in THEMES"
              :key="t.key"
              type="button"
              class="theme-card"
              :class="{ active: theme.current === t.key }"
              :aria-pressed="theme.current === t.key"
              @click="chooseTheme(t.key)"
            >
              <span class="theme-card__preview" :data-theme-preview="t.key" aria-hidden="true">
                <span class="theme-card__bar" />
                <span class="theme-card__line" />
                <span class="theme-card__line short" />
                <span class="theme-card__dot" />
              </span>
              <span class="theme-card__text">
                <span class="theme-card__name">{{ t.label }}</span>
                <span class="theme-card__hint">{{ t.hint }}</span>
              </span>
              <span v-if="theme.current === t.key" class="theme-card__check">
                <AppIcon name="check" :size="13" />
              </span>
            </button>
          </div>
        </div>

        <div v-else-if="section === 'status'" class="settings__body">
          <header class="group__head">
            <h3 class="group__title">运行状态</h3>
            <p class="group__desc">各组件实时健康状态与排障入口。</p>
          </header>

          <div class="kv-row"><span class="kv-row__k">中枢版本</span><span class="mono dim">v{{ version }}</span></div>
          <template v-for="r in rows" :key="r.k">
            <div class="kv-row">
              <span class="kv-row__k">{{ r.k }}</span>
              <span class="mono dim">{{ r.v }}</span>
            </div>
          </template>
          <div v-if="!rows.length" class="kv-row">
            <span class="kv-row__k">连接</span>
            <span class="dim">正在获取…</span>
          </div>

          <div class="diag__acts">
            <button type="button" class="chip" @click="openLogs">
              <AppIcon name="logs" :size="13" />
              <span>日志目录</span>
            </button>
            <button type="button" class="chip" @click="health.refetch()">
              <AppIcon name="refresh" :size="13" />
              <span>{{ health.isFetching.value ? "检测中…" : "重新检测" }}</span>
            </button>
            <button type="button" class="chip" @click="auditOpen = true">
              <AppIcon name="audit" :size="13" />
              <span>审计记录</span>
            </button>
          </div>
        </div>
      </div>
    </template>
  </t-dialog>

  <!-- v-if 挂载：避免两个 dialog 同时存在抢 zIndex，导致 Esc 关不掉最上层 -->
  <t-dialog
    v-if="open && auditOpen"
    :visible="auditOpen"
    header="审计记录"
    :footer="false"
    width="min(1040px, 92vw)"
    placement="center"
    attach="body"
    dialog-class-name="audit-dialog"
    :close-on-overlay-click="true"
    @update:visible="onAuditVisibleChange"
  >
    <template #body>
      <AuditPage />
    </template>
  </t-dialog>
</template>
