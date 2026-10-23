<script setup lang="ts">
/**
 * 输入框里的待发送附件条。
 * 三种状态都要能一眼看出来：上传中（转圈）/ 就绪（可点开预览）/ 失败（红字重试）。
 * 失败项保留在列表里而不是直接消失，否则用户不知道刚才那个文件到底传没传上去。
 */
import type { PendingAttachment } from "@/chat/useChatSession";
import AppIcon from "./AppIcon.vue";
import { formatBytes } from "@/chat/files";

defineProps<{ items: PendingAttachment[] }>();
const emit = defineEmits<{ remove: [key: string]; preview: [item: PendingAttachment] }>();
</script>

<template>
  <div v-if="items.length" class="composer-atts">
    <div v-for="item in items" :key="item.key" class="cat" :class="item.status">
      <button
        type="button"
        class="cat__main"
        :disabled="item.status !== 'ready'"
        :aria-label="item.status === 'ready' ? `预览 ${item.name}` : item.name"
        @click="emit('preview', item)"
      >
        <img v-if="item.previewUrl" class="cat__thumb" :src="item.previewUrl" :alt="item.name" />
        <span v-else class="cat__icon"><AppIcon name="file" :size="14" /></span>
        <span class="cat__meta">
          <span class="cat__name">{{ item.name }}</span>
          <span class="cat__sub mono">
            <template v-if="item.status === 'uploading'">上传中…</template>
            <template v-else-if="item.status === 'error'">{{ item.error }}</template>
            <template v-else>{{ formatBytes(item.size) }}</template>
          </span>
        </span>
        <span v-if="item.status === 'uploading'" class="cat__spin" aria-hidden="true" />
      </button>
      <button type="button" class="cat__x" :aria-label="`移除 ${item.name}`" @click="emit('remove', item.key)">
        <AppIcon name="close" :size="12" />
      </button>
    </div>
  </div>
</template>