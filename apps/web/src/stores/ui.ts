import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * 顶部只保留三个展示入口：对话、设备、场景。
 * 自动化与审计属于"配置/追溯"，放进设置中心，避免顶栏堆菜单。
 */
export type TabKey = "chat" | "devices" | "scenes";

/** 本地 UI 态（Pinia）：只存"当前在看什么"，不存服务端数据 */
export const useUiStore = defineStore("ui", () => {
  const currentSessionId = ref<string | null>(null);
  const activeTab = ref<TabKey>("chat");
  /** 设置面板开合：设置是覆盖层，不占导航位置，避免和"页面"混在一起 */
  const settingsOpen = ref(false);

  function setSession(id: string | null) {
    currentSessionId.value = id;
  }

  function openSettings() {
    settingsOpen.value = true;
  }

  function closeSettings() {
    settingsOpen.value = false;
  }

  return {
    currentSessionId,
    activeTab,
    settingsOpen,
    setSession,
    openSettings,
    closeSettings,
  };
});

