<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChatItem } from "@/chat/reducer";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{ item: Extract<ChatItem, { kind: "tool" }> }>();
const expanded = ref(false);

/** 三态：执行中 / 成功 / 失败。文字 + 颜色 + 圆点三重编码，不只靠颜色 */
const state = computed(() => {
  if (props.item.ok === undefined) return { label: "执行中", cls: "run" };
  return props.item.ok ? { label: "成功", cls: "ok" } : { label: "失败", cls: "fail" };
});

const argsText = computed(() => JSON.stringify(props.item.args ?? {}, null, 2));
</script>

<template>
  <div class="card tool-card">
    <div class="tool-card__head">
      <span class="badge" :class="state.cls">{{ state.label }}</span>
      <span class="tool-card__name">{{ item.tool }}</span>
      <span v-if="item.elapsedMs !== undefined" class="dim mono">{{ item.elapsedMs }}ms</span>
      <button
        class="icon-btn"
        type="button"
        style="margin-left: auto"
        :aria-expanded="expanded"
        :aria-label="expanded ? '收起参数' : '展开参数'"
        @click="expanded = !expanded"
      >
        <AppIcon name="chevron" :size="14" />
      </button>
    </div>
    <div v-if="item.summary" class="dim" style="margin-top: 6px">{{ item.summary }}</div>
    <div v-show="expanded" class="tool-card__body">
      <div class="dim" style="font-size: 11px; margin-bottom: 4px">参数</div>
      <pre class="tool-card__args mono">{{ argsText }}</pre>
    </div>
  </div>
</template>