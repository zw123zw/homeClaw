<script setup lang="ts">
/**
 * 头像。
 *
 * 有自定义图就用图，没有就用文字首字母或品牌图标占位。
 * 文字占位的颜色由角色决定（用户 / 助手），不随机 ——
 * 随机色每次刷新都变，看起来像 bug。
 */
import { computed } from "vue";
import AppIcon from "./AppIcon.vue";

const props = withDefaults(
  defineProps<{
    src?: string;
    name?: string;
    role?: "user" | "assistant";
    size?: number;
  }>(),
  { src: "", name: "", role: "user", size: 26 },
);

const initial = computed(() => (props.name.trim()[0] ?? "?").toUpperCase());
</script>

<template>
  <span
    class="avatar"
    :class="role"
    :style="{ '--av-size': size + 'px' }"
    :aria-label="name || (role === 'user' ? '用户' : '助手')"
    role="img"
  >
    <img v-if="src" :src="src" :alt="name" />
    <AppIcon v-else-if="role === 'assistant'" name="brand" :size="size * 0.52" />
    <span v-else class="avatar__initial">{{ initial }}</span>
  </span>
</template>
