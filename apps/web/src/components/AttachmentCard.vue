<script setup lang="ts">
/**
 * 消息里的附件卡片。
 * 图片直接显示缩略图；其他类型显示图标 + 文件名 + 体积。
 * 点击不自己开预览，而是把索引抛给父级 —— 一条消息有多个附件时要支持左右切换，
 * 预览层必须知道"这是第几个"，这个信息只有父级（持有整个列表）才有。
 */
import { onMounted, ref, watch } from "vue";
import type { Attachment } from "@homeclaw/contracts";
import AppIcon from "./AppIcon.vue";
import { attachmentUrl, formatBytes, isImage } from "@/chat/files";

const props = defineProps<{ attachment: Attachment }>();
const emit = defineEmits<{ open: [] }>();

const thumb = ref<string | null>(null);
const failed = ref(false);

async function load() {
  failed.value = false;
  // 本地乐观消息带 previewUrl，直接用它，省一次往返
  if (props.attachment.previewUrl) {
    thumb.value = props.attachment.previewUrl;
    return;
  }
  if (!isImage(props.attachment.mime)) return;
  try {
    thumb.value = await attachmentUrl(props.attachment.id);
  } catch {
    failed.value = true;
  }
}

onMounted(load);
watch(() => [props.attachment.id, props.attachment.previewUrl], load);
</script>

<template>
  <button
    v-if="isImage(attachment.mime)"
    type="button"
    class="att att--image"
    :aria-label="`预览图片 ${attachment.name}`"
    @click="emit('open')"
  >
    <img v-if="thumb" class="att__thumb" :src="thumb" :alt="attachment.name" loading="lazy" />
    <span v-else class="att__thumb att__thumb--placeholder">
      <AppIcon :name="failed ? 'alert' : 'image'" :size="18" />
    </span>
    <span class="att__meta">
      <span class="att__name">{{ attachment.name }}</span>
      <span class="att__size mono">{{ formatBytes(attachment.size) }}</span>
    </span>
  </button>

  <button v-else type="button" class="att att--file" :aria-label="`预览 ${attachment.name}`" @click="emit('open')">
    <span class="att__icon" :data-kind="attachment.kind">
      <AppIcon :name="attachment.kind === 'pdf' ? 'pdf' : attachment.kind === 'audio' ? 'audio' : attachment.kind === 'video' ? 'video' : attachment.kind === 'text' ? 'text' : 'file'" :size="16" />
    </span>
    <span class="att__meta">
      <span class="att__name">{{ attachment.name }}</span>
      <span class="att__size mono">{{ formatBytes(attachment.size) }}</span>
    </span>
  </button>
</template>