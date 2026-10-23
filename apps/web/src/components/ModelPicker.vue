<script setup lang="ts">
/**
 * 输入框下方的模型切换器。
 *
 * 三种状态都必须明确：
 *  - 一个模型都没有 → 不渲染（提示由空状态文案承担，不占输入区一行）；
 *  - 只有一个 → 只读文字，让人知道现在用的是哪个；
 *  - 多个 → TDesign 的 t-select（键盘、读屏、浮层定位都由框架负责）。
 */
import { computed } from "vue";
import { useModelStore } from "@/stores/models";
import AppIcon from "./AppIcon.vue";

const emit = defineEmits<{ toast: [text: string, err?: boolean] }>();
const models = useModelStore();

const multiple = computed(() => models.list.length > 1);
const current = computed(() => models.active);
const options = computed(() => models.list.map((m) => ({ value: m.id, label: m.name })));

async function pick(value: unknown) {
  const id = typeof value === "string" ? value : "";
  if (!id || id === models.activeId) return;
  try {
    await models.activate(id);
  } catch (err) {
    emit("toast", err instanceof Error ? err.message : "切换模型失败", true);
  }
}
</script>

<template>
  <div v-if="models.list.length" class="model-pick">
    <AppIcon name="cpu" :size="13" />
    <t-select
      v-if="multiple"
      class="model-pick__sel"
      :value="models.activeId ?? undefined"
      :options="options"
      size="small"
      :borderless="true"
      :popup-props="{ overlayClassName: 'model-pop' }"
      style="width: auto; min-width: 110px"
      @change="pick"
    />
    <span v-else class="model-pick__name">{{ current?.name ?? "" }}</span>
    <span v-if="models.error" class="model-pick__err" :title="models.error">连接异常</span>
  </div>
</template>
