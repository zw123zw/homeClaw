<script setup lang="ts">
/**
 * 一条消息：头像 + 署名 + 内容。
 *
 * 布局是两列网格（头像列 + 内容列），顶部对齐：
 * 长消息滚动时头像不会跟着漂，扫读时也不用逐条读文字就能分清谁说的。
 *
 * assistant 走 Markdown 渲染（renderMarkdown 内部已 escape，这是全项目唯一允许 v-html 的出口）；
 * user 保持纯文本 —— 用户输入的原样回显比"猜他想要什么格式"更重要。
 */
import { computed } from "vue";
import type { Attachment } from "@homeclaw/contracts";
import type { ChatItem } from "@/chat/reducer";
import { useProfileStore } from "@/stores/profile";
import AppIcon from "./AppIcon.vue";
import ToolCard from "./ToolCard.vue";
import AttachmentCard from "./AttachmentCard.vue";
import UserAvatar from "./UserAvatar.vue";
import { renderMarkdown } from "@/chat/markdown";

const props = defineProps<{ item: ChatItem }>();
const emit = defineEmits<{ preview: [items: Attachment[], index: number] }>();

const profile = useProfileStore();

type Bubble = Extract<ChatItem, { kind: "user" | "assistant" }>;

/** 只有 user/assistant 会进到这里（tool 走 ToolCard），收窄一次省掉模板里的类型断言 */
const bubble = computed(() => (props.item.kind === "tool" ? null : (props.item as Bubble)));
const isUser = computed(() => bubble.value?.kind === "user");
/** 用户消息整体靠右：头像在右、气泡向右对齐；AI 靠左，和主流 IM 的阅读习惯一致 */
const html = computed(() => (bubble.value?.kind === "assistant" ? renderMarkdown(bubble.value.text) : ""));
const attachments = computed(() => bubble.value?.attachments ?? []);
const streaming = computed(() => (bubble.value?.kind === "assistant" ? bubble.value.streaming : false));
const error = computed(() => (bubble.value?.kind === "assistant" ? bubble.value.error : undefined));

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <ToolCard v-if="item.kind === 'tool'" :item="item" />

  <article v-else-if="bubble" class="msg" :class="bubble.kind">
    <UserAvatar
      class="msg__avatar"
      :class="{ right: isUser }"
      :role="isUser ? 'user' : 'assistant'"
      :src="isUser ? profile.state.avatar : ''"
      :name="isUser ? profile.state.nickname : profile.state.assistantName"
      :size="28"
    />

    <div class="msg__main">
      <header class="msg__head">
        <span class="msg__who">{{ isUser ? profile.state.nickname : profile.state.assistantName }}</span>
        <time class="msg-meta">{{ fmtTime(bubble.ts) }}</time>
      </header>

      <div v-if="attachments.length" class="msg-atts">
        <AttachmentCard
          v-for="(att, i) in attachments"
          :key="att.id"
          :attachment="att"
          @open="emit('preview', attachments, i)"
        />
      </div>

      <div class="bubble" :class="{ 'bubble--md': !isUser }">
        <template v-if="!isUser">
          <span class="md" v-html="html" /><span v-if="streaming" class="caret" aria-hidden="true" />
        </template>
        <template v-else-if="bubble.text">{{ bubble.text }}</template>
      </div>

      <div v-if="error" class="msg-error">
        <AppIcon name="alert" :size="14" />
        <span>{{ error }}</span>
      </div>
    </div>
  </article>
</template>