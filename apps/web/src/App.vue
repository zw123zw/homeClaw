<script setup lang="ts">
/**
 * 应用外壳：顶部栏 + 满宽工作区。
 *
 * 只有三个展示入口（对话 / 设备 / 场景），其余全部收进设置：
 * 顶栏是"每天都点"的地方，配置项放进来只会稀释它的可扫读性。
 *
 * 设置用 TDesign 的 t-dialog（它已经处理好焦点陷阱、Esc、滚动锁、浮层层级），
 * 我们只在里面套自己的三组内容。
 */
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/api/client";
import { useUiStore, type TabKey } from "@/stores/ui";
import { platform } from "@/platform";
import AppIcon from "@/components/AppIcon.vue";
import SettingsCenter from "@/components/SettingsCenter.vue";
import ChatPage from "@/pages/ChatPage.vue";
import DevicesPage from "@/pages/DevicesPage.vue";
import ScenesPage from "@/pages/ScenesPage.vue";

const ui = useUiStore();
/** Electron 右上角有系统窗口控件，顶栏要预留出这段空间；网页版不需要 */
const desktop = platform().kind === "electron";
const toast = ref<{ text: string; err?: boolean } | null>(null);

function showToast(text: string, err = false) {
  toast.value = { text, err };
  window.setTimeout(() => (toast.value = null), 2600);
}

const NAV: { key: TabKey; label: string; icon: "chat" | "devices" | "scenes" }[] = [
  { key: "chat", label: "对话", icon: "chat" },
  { key: "devices", label: "设备", icon: "devices" },
  { key: "scenes", label: "场景", icon: "scenes" },
];

const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 15_000 });
const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });

const ready = ref(false);
watch(
  () => sessions.data.value,
  (list) => {
    if (!list || ready.value) return;
    if (list.length > 0) {
      ui.setSession(list[0]!.id);
      ready.value = true;
    } else {
      void api.createSession("新会话").then((s) => {
        ui.setSession(s.id);
        ready.value = true;
        void sessions.refetch();
      });
    }
  },
  { immediate: true },
);

async function newSession() {
  ui.activeTab = "chat";
  const s = await api.createSession("新会话");
  ui.setSession(s.id);
  await sessions.refetch();
}

const sessionOptions = computed(() =>
  (sessions.data.value ?? []).map((s) => ({ value: s.id, label: s.title })),
);

function pickSession(id: unknown) {
  if (typeof id === "string" && id) ui.setSession(id);
}

const healthTone = computed<"ok" | "warn" | "err">(() => {
  const h = health.data.value;
  if (!h) return "err";
  if (!h.ok) return "warn";
  return h.adapter.status === "ok" ? "ok" : "warn";
});

const healthText = computed(() => {
  const h = health.data.value;
  if (!h) return "连接中";
  if (!h.ok) return "服务异常";
  return h.adapter.status === "ok" ? "在线" : "适配器降级";
});
</script>

<template>
  <div class="shell" :class="{ desktop }">
    <div class="ambient" aria-hidden="true">
      <span class="ambient__glow ambient__glow--a" />
      <span class="ambient__glow ambient__glow--b" />
    </div>

    <header class="topbar">
      <div class="brand">
        <span class="mark"><AppIcon name="brand" :size="14" /></span>
        <span class="brand__name">HomeClaw</span>
      </div>

      <nav class="nav" aria-label="主导航">
        <button
          v-for="n in NAV"
          :key="n.key"
          type="button"
          class="nav__item"
          :class="{ active: ui.activeTab === n.key }"
          :aria-current="ui.activeTab === n.key ? 'page' : undefined"
          @click="ui.activeTab = n.key"
        >
          <AppIcon :name="n.icon" :size="16" />
          <span>{{ n.label }}</span>
        </button>
      </nav>

      <div class="topbar__actions">
        <template v-if="ui.activeTab === 'chat'">
          <t-select
            class="session-pick"
            :value="ui.currentSessionId ?? ''"
            :options="sessionOptions"
            :placeholder="sessionOptions.length ? '选择会话' : '载入会话…'"
            size="small"
            :popup-props="{ overlayClassName: 'session-pop' }"
            style="width: 150px"
            @change="pickSession"
          />
          <button type="button" class="icon-btn" aria-label="新建会话" @click="newSession">
            <AppIcon name="plus" :size="16" />
          </button>
        </template>

        <span class="statuspill" role="status" aria-live="polite">
          <span class="pulse" :class="healthTone" aria-hidden="true" />
          {{ healthText }}
        </span>
        <button type="button" class="icon-btn" aria-label="设置" @click="ui.openSettings()">
          <AppIcon name="settings" :size="17" />
        </button>
      </div>
    </header>

    <main class="view">
      <ChatPage
        v-if="ui.activeTab === 'chat'"
        :session-id="ui.currentSessionId"
        :key="ui.currentSessionId ?? 'none'"
        @toast="showToast"
      />
      <DevicesPage v-else-if="ui.activeTab === 'devices'" @toast="showToast" />
      <ScenesPage v-else @toast="showToast" />
    </main>

    <SettingsCenter :open="ui.settingsOpen" @close="ui.closeSettings()" @toast="showToast" />

    <div v-if="toast" class="toast" :class="{ err: toast.err }" role="status">
      {{ toast.text }}
    </div>
  </div>
</template>
