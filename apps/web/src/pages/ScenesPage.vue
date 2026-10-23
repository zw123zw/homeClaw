<script setup lang="ts">
/**
 * 场景页：场景（常用一键操作）+ 自动化（配置一次长期生效）。
 *
 * 为什么不给自动化单独的顶栏入口：顶栏只放"天天要点"的东西。
 * 自动化是配置类功能，放进同一页的第二个视图，既不多占顶栏，也不会让人找不到。
 * 分段控件用 TDesign 的 t-radio-group（variant=default-filled），
 * 和设置里的 tab 同一套视觉语言。
 */
import { computed, ref } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { Scene } from "@homeclaw/contracts";
import { api } from "@/api/client";
import AppIcon from "@/components/AppIcon.vue";
import AutomationPage from "./AutomationPage.vue";

const emit = defineEmits<{ toast: [text: string, err?: boolean] }>();
const qc = useQueryClient();

type View = "scenes" | "automation";
const view = ref<View>("scenes");
const isScenes = computed(() => view.value === "scenes");

const scenes = useQuery({ queryKey: ["scenes"], queryFn: api.scenes });
const running = ref<string | null>(null);

const runScene = useMutation({
  mutationFn: (id: string) => api.runScene(id),
  onSuccess: async (res) => {
    const failed = res.results.filter((r) => !r.ok);
    emit("toast", failed.length ? `场景部分失败：${failed.length} 个动作未执行` : "场景执行成功", failed.length > 0);
    await qc.invalidateQueries({ queryKey: ["entities"] });
  },
  onError: (err) => emit("toast", err instanceof Error ? err.message : "执行失败", true),
});

async function run(s: Scene) {
  running.value = s.id;
  try {
    await runScene.mutateAsync(s.id);
  } finally {
    running.value = null;
  }
}
</script>

<template>
  <AutomationPage v-if="!isScenes" @toast="(t, e) => emit('toast', t, e)" />

  <div v-else class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title"><AppIcon name="scenes" />场景</h1>
        <p class="page-sub">一次动作改多台设备。场景在本地执行，断网也生效。</p>
      </div>
      <div class="segmented" role="tablist" aria-label="场景与自动化">
        <button
          type="button"
          class="segmented__item"
          :class="{ active: isScenes }"
          role="tab"
          :aria-selected="isScenes"
          @click="view = 'scenes'"
        >
          场景
        </button>
        <button
          type="button"
          class="segmented__item"
          :class="{ active: !isScenes }"
          role="tab"
          :aria-selected="!isScenes"
          @click="view = 'automation'"
        >
          自动化
        </button>
      </div>
    </header>

    <div v-if="scenes.isLoading.value" class="empty">加载中…</div>
    <div v-else-if="scenes.isError.value" class="empty">场景加载失败</div>
    <div v-else-if="!(scenes.data.value ?? []).length" class="empty">
      暂无场景
      <br />
      <span class="empty__hint">可以在 HomeHub 里定义场景，一次下发改多台设备。</span>
    </div>
    <div v-else class="scene-grid">
      <article v-for="s in scenes.data.value ?? []" :key="s.id" class="scene">
        <div class="scene__name"><AppIcon name="scenes" :size="15" />{{ s.name }}</div>
        <div class="scene__meta">{{ s.actions.length }} 个动作</div>
        <button class="primary" type="button" :disabled="running === s.id" @click="run(s)">
          {{ running === s.id ? "执行中…" : "一键执行" }}
        </button>
      </article>
    </div>
  </div>
</template>
