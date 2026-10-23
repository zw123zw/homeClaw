import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, type ModelProfile } from "@/api/client";

/**
 * 模型配置的共享态（L2 /v1/models）。
 *
 * 为什么放 Pinia 而不是各页面自己拉：
 *  输入框下方的切换器和设置里的模型列表必须是同一份数据，
 *  否则"设置里改了 active，输入框还显示旧模型"这种不一致几乎必然出现。
 *
 * 注意 activeId 可以是 null：默认没有任何预置模型，用户没配就是"没有模型"。
 */
export const useModelStore = defineStore("models", () => {
  const list = ref<ModelProfile[]>([]);
  const activeId = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const loaded = ref(false);

  const active = computed(() => list.value.find((m) => m.id === activeId.value) ?? null);
  const hasModels = computed(() => list.value.length > 0);

  async function refresh() {
    loading.value = true;
    try {
      const res = await api.models();
      list.value = res.models;
      activeId.value = res.active_id;
      error.value = null;
      loaded.value = true;
    } catch (err) {
      // 网关没起时不能把整个输入区卡死：保留上次结果，只记错误
      error.value = err instanceof Error ? err.message : "模型列表读取失败";
    } finally {
      loading.value = false;
    }
  }

  async function activate(id: string) {
    const prev = activeId.value;
    activeId.value = id;
    try {
      await api.activateModel(id);
      error.value = null;
    } catch (err) {
      activeId.value = prev;
      error.value = err instanceof Error ? err.message : "切换模型失败";
      throw err;
    }
  }

  return { list, activeId, active, hasModels, loading, error, loaded, refresh, activate };
});