<script setup lang="ts">
/**
 * 附件预览层。
 * 按 kind 分流：图片/PDF/文本/音视频各有各的最佳展示方式，
 * 剩下的一律给"下载"而不是硬塞进 iframe（浏览器对二进制只能下载）。
 * 文本类走 blob → escape 后显示，不用 innerHTML，避免预览变成 XSS 入口。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Attachment } from "@homeclaw/contracts";
import AppIcon from "./AppIcon.vue";
import { attachmentUrl, formatBytes } from "@/chat/files";

const props = defineProps<{ items: Attachment[]; index: number }>();
const emit = defineEmits<{ close: []; step: [index: number] }>();

const url = ref<string | null>(null);
const text = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const panel = ref<HTMLElement | null>(null);
const root = ref<HTMLElement | null>(null);

const current = computed<Attachment | null>(() => props.items[props.index] ?? null);

const kind = computed(() => current.value?.kind ?? "file");
const canStep = computed(() => props.items.length > 1);

async function load() {
  const att = current.value;
  url.value = null;
  text.value = null;
  error.value = null;
  if (!att) return;

  // 下载/信息类不需要预取字节
  if (kind.value === "file") return;

  loading.value = true;
  try {
    const blobUrl = att.previewUrl ?? (await attachmentUrl(att.id));
    if (kind.value === "text") {
      const res = await fetch(blobUrl);
      text.value = await res.text();
    } else {
      url.value = blobUrl;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : "附件加载失败";
  } finally {
    loading.value = false;
  }
}

function step(delta: number) {
  const next = props.index + delta;
  if (next < 0 || next >= props.items.length) return;
  emit("step", next);
}

/** 下载：带票据的 blob 已经拿到，用临时 <a download> 落盘，不进历史记录 */
async function download() {
  const att = current.value;
  if (!att) return;
  try {
    const href = att.previewUrl ?? (await attachmentUrl(att.id));
    const a = document.createElement("a");
    a.href = href;
    a.download = att.name;
    a.click();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "下载失败";
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
  } else if (e.key === "ArrowLeft" && canStep.value) {
    step(-1);
  } else if (e.key === "ArrowRight" && canStep.value) {
    step(1);
  }
}

watch(() => [props.index, props.items], () => { void load(); }, { immediate: true, deep: true });
// 预览层要自己接键盘事件（Esc / 左右切换），必须先把焦点收进来
onMounted(() => root.value?.focus());
onBeforeUnmount(() => {
  // 只断开引用，blob URL 由 files.ts 的缓存统一回收
  url.value = null;
  text.value = null;
});
</script>

<template>
  <Teleport to="body">
    <div ref="root" class="preview" role="dialog" aria-modal="true" aria-label="附件预览" tabindex="-1" @click.self="emit('close')" @keydown="onKeydown">
      <header class="preview__bar">
        <span class="preview__name">{{ current?.name ?? "" }}</span>
        <span v-if="current" class="preview__size mono">{{ formatBytes(current.size) }}</span>
        <span v-if="canStep" class="preview__count mono">{{ index + 1 }} / {{ items.length }}</span>
        <button v-if="current" type="button" class="icon-btn" aria-label="下载附件" @click="download">
          <AppIcon name="download" :size="15" />
        </button>
        <button type="button" class="icon-btn" aria-label="关闭预览" @click="emit('close')">
          <AppIcon name="close" :size="15" />
        </button>
      </header>

      <div class="preview__stage">
        <button v-if="canStep && index > 0" type="button" class="preview__nav prev" aria-label="上一个附件" @click="step(-1)">
          <AppIcon name="chevron" :size="18" />
        </button>

        <div class="preview__body" ref="panel">
          <div v-if="loading" class="preview__hint">加载中…</div>
          <div v-else-if="error" class="preview__hint preview__hint--err">
            <AppIcon name="alert" :size="16" />
            <span>{{ error }}</span>
          </div>

          <img v-else-if="kind === 'image' && url" class="preview__image" :src="url" :alt="current?.name ?? ''" />
          <iframe v-else-if="kind === 'pdf' && url" class="preview__frame" :src="url" :title="current?.name ?? 'PDF'" />
          <audio v-else-if="kind === 'audio' && url" class="preview__audio" :src="url" controls />
          <video v-else-if="kind === 'video' && url" class="preview__video" :src="url" controls />
          <pre v-else-if="kind === 'text' && text !== null" class="preview__text mono">{{ text }}</pre>

          <div v-else class="preview__file">
            <span class="preview__file-icon"><AppIcon name="file" :size="26" /></span>
            <p class="preview__file-name">{{ current?.name }}</p>
            <p class="preview__file-hint">该类型无法内联预览，可下载后用本机应用打开。</p>
            <button type="button" class="primary" @click="download">
              <AppIcon name="download" :size="15" />
              <span>下载</span>
            </button>
          </div>
        </div>

        <button
          v-if="canStep && index < items.length - 1"
          type="button"
          class="preview__nav next"
          aria-label="下一个附件"
          @click="step(1)"
        >
          <AppIcon name="chevron" :size="18" />
        </button>
      </div>
    </div>
  </Teleport>
</template>