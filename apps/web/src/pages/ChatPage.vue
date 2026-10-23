<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { Attachment } from "@homeclaw/contracts";
import AppIcon from "@/components/AppIcon.vue";
import MessageItem from "@/components/MessageItem.vue";
import ModelPicker from "@/components/ModelPicker.vue";
import ComposerAttachments from "@/components/ComposerAttachments.vue";
import AttachmentPreview from "@/components/AttachmentPreview.vue";
import { useChatSession, type PendingAttachment } from "@/chat/useChatSession";
import { useModelStore } from "@/stores/models";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/api/client";

const props = defineProps<{ sessionId: string | null }>();
const emit = defineEmits<{ toast: [text: string, err?: boolean] }>();

const {
  state,
  connected,
  reconnecting,
  input,
  pending,
  readyAttachments,
  canSend,
  canStop,
  send,
  stop,
  open,
  loadingHistory,
  hasMoreHistory,
  loadOlder,
  addFiles,
  dropAttachment,
  deepThinking,
} = useChatSession();

/**
 * 规划内核是否就绪：决定"深度思考"开关显示还是显示"去设置"。
 *
 * 不让用户在没装运行时的机器上点一个永远不生效的开关 ——
 * 那会让人以为模型不行，而不是"这个能力还没装"。
 */
const hermes = useQuery({ queryKey: ["hermes-status"], queryFn: api.hermesStatus, staleTime: 30_000, retry: 0 });
const planningReady = computed(() => hermes.data.value?.status === "ready" && hermes.data.value?.enabled !== false);

const models = useModelStore();
const scroller = ref<HTMLElement | null>(null);
const atBottom = ref(true);
const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const preview = ref<{ items: Attachment[]; index: number } | null>(null);

watch(
  () => props.sessionId,
  async (id) => {
    if (id) await open(id);
  },
  { immediate: true },
);

watch(
  () => models.loaded,
  (loaded) => {
    if (!loaded) void models.refresh();
  },
  { immediate: true },
);

/** 只在用户已经在底部时自动滚动，避免打断向上翻阅历史 */
function onScroll() {
  const el = scroller.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

async function stickToBottom() {
  if (!atBottom.value) return;
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(() => state.value.items.length, stickToBottom);
/** 流式输出时也要跟随，否则文字增长会跑出可视区 */
watch(() => state.value.items.at(-1), stickToBottom, { deep: true });

async function pickFiles(list: FileList | File[] | null) {
  const files = list ? Array.from(list) : [];
  if (!files.length) return;
  const problems = await addFiles(files);
  if (problems.length) emit("toast", problems[0]!, true);
}

function onFilePick(e: Event) {
  const el = e.target as HTMLInputElement;
  void pickFiles(el.files);
  // 清空 value：同一个文件连选两次也要能触发 change
  el.value = "";
}

function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length) {
    e.preventDefault();
    void pickFiles(files);
  }
}

function onDragLeave(e: DragEvent) {
  // 指针移到子元素上也会触发 dragleave，只有真正离开整个聊天区才收起高亮
  const to = e.relatedTarget as Node | null;
  if (!to || !(e.currentTarget as Node).contains(to)) dragging.value = false;
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) void pickFiles(files);
}

async function onSubmit() {
  try {
    await send();
  } catch (err) {
    emit("toast", err instanceof Error ? err.message : "发送失败", true);
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void onSubmit();
  }
}

function openPending(item: PendingAttachment) {
  if (item.attachment) preview.value = { items: [item.attachment], index: 0 };
}

const emptyHint = computed(() => (models.list.length > 1 ? "可以先用下方选择器换模型。" : ""));
</script>

<template>
  <div class="chat" @dragover.prevent="dragging = true" @dragleave="onDragLeave" @drop.prevent="onDrop">
    <div
      ref="scroller"
      class="messages"
      tabindex="-1"
      aria-live="polite"
      aria-relevant="additions text"
      @scroll="onScroll"
    >
      <div v-if="loadingHistory && !state.items.length" class="empty">正在加载历史…</div>
      <div v-else-if="!state.items.length" class="empty">
        试试说「把客厅灯调到 30% 暖光」。<br />
        <span class="empty__hint">底层是本地 ToolHub；没配模型 key 时走内置规则模型，同样会真实改设备。{{ emptyHint }}</span>
      </div>

      <div v-if="hasMoreHistory" class="load-more">
        <button class="link-btn" type="button" :disabled="loadingHistory" @click="loadOlder">
          {{ loadingHistory ? "载入中…" : "载入更早的消息" }}
        </button>
      </div>
      <MessageItem
        v-for="item in state.items"
        :key="item.id"
        :item="item"
        @preview="(items, index) => (preview = { items, index })"
      />
    </div>

    <div class="composer-wrap">
      <ComposerAttachments
        :items="pending"
        @remove="dropAttachment"
        @preview="openPending"
      />

      <div class="composer" :class="{ dragging }">
        <input
          ref="fileInput"
          class="sr-only"
          type="file"
          multiple
          tabindex="-1"
          aria-hidden="true"
          @change="onFilePick"
        />
        <button
          type="button"
          class="icon-btn attach"
          aria-label="添加附件"
          @click="fileInput?.click()"
        >
          <AppIcon name="paperclip" :size="16" />
        </button>

        <label class="sr-only" for="chat-input">输入指令</label>
        <textarea
          id="chat-input"
          v-model="input"
          rows="1"
          placeholder="输入指令，Enter 发送 / Shift+Enter 换行；可拖入或粘贴文件"
          @keydown="onKeydown"
          @paste="onPaste"
        />

        <button v-if="canStop" class="danger send" type="button" aria-label="停止生成" @click="stop">
          <AppIcon name="stop" :size="17" />
        </button>
        <button
          class="primary send"
          type="button"
          :disabled="!canSend"
          aria-label="发送"
          @click="onSubmit"
        >
          <AppIcon name="send" :size="17" />
        </button>
      </div>

      <div class="composer-foot">
        <ModelPicker @toast="(t, e) => emit('toast', t, e)" />
        <button
          v-if="planningReady"
          type="button"
          class="think-toggle"
          :class="{ on: deepThinking }"
          :aria-pressed="deepThinking"
          title="复杂任务交给本地规划内核，分步执行并展示每一步"
          @click="deepThinking = !deepThinking"
        >
          <AppIcon name="cpu" :size="12" />
          <span>深度思考</span>
        </button>
        <span v-if="readyAttachments.length" class="composer-foot__hint mono">
          {{ readyAttachments.length }} 个附件待发送
        </span>
      </div>
    </div>

    <div v-if="reconnecting" class="conn-note">
      <AppIcon name="alert" :size="14" />
      <span>连接中断，正在重连并按 last_seq 补齐…</span>
    </div>
    <div v-else-if="connected" class="conn-note conn-note--quiet">
      <AppIcon name="wifi" :size="12" />
      <span>实时连接 · 游标 {{ state.lastLogSeq }}</span>
    </div>

    <AttachmentPreview
      v-if="preview"
      :items="preview.items"
      :index="preview.index"
      @step="(i) => preview && (preview.index = i)"
      @close="preview = null"
    />
  </div>
</template>