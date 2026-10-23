<script setup lang="ts">
/**
 * 设置 · 个人。
 *
 * 昵称决定用户头像的文字占位与消息署名；助手名给 AI 换个称呼。
 * 头像选图后立刻压到 128px 再存 localStorage，避免大图把存储撑爆。
 * 这些只影响本机显示，不写中枢、不上传。
 */
import { ref } from "vue";
import { toAvatarDataUrl, useProfileStore } from "@/stores/profile";
import AppIcon from "./AppIcon.vue";
import UserAvatar from "./UserAvatar.vue";

const emit = defineEmits<{ toast: [text: string, err?: boolean] }>();
const profile = useProfileStore();
const fileInput = ref<HTMLInputElement | null>(null);
const busy = ref(false);

async function onPick(e: Event) {
  const el = e.target as HTMLInputElement;
  const file = el.files?.[0];
  el.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    emit("toast", "请选择图片文件", true);
    return;
  }
  busy.value = true;
  try {
    profile.patch({ avatar: await toAvatarDataUrl(file) });
    emit("toast", "头像已更新");
  } catch (err) {
    emit("toast", err instanceof Error ? err.message : "头像处理失败", true);
  } finally {
    busy.value = false;
  }
}

function onNicknameChange(value: unknown) {
  const v = typeof value === "string" ? value : "";
  profile.patch({ nickname: v });
}
</script>

<template>
  <div class="profile-settings">
    <header class="group__head">
      <h3 class="group__title">个人</h3>
      <p class="group__desc">只影响本机显示，不会上传到任何服务器。</p>
    </header>

    <div class="profile-card">
      <UserAvatar :src="profile.state.avatar" :name="profile.state.nickname" role="user" :size="56" />
      <div class="profile-card__side">
        <div class="profile-card__row">
          <t-input
            :value="profile.state.nickname"
            :maxlength="24"
            placeholder="你的昵称"
            aria-label="昵称"
            size="small"
            @change="onNicknameChange"
          />
          <input
            ref="fileInput"
            class="sr-only"
            type="file"
            accept="image/*"
            tabindex="-1"
            aria-hidden="true"
            @change="onPick"
          />
          <button type="button" :disabled="busy" @click="fileInput?.click()">
            <AppIcon name="image" :size="14" />
            <span>{{ busy ? "处理中…" : "换头像" }}</span>
          </button>
          <button
            v-if="profile.state.avatar"
            type="button"
            class="icon-btn danger"
            aria-label="移除头像"
            @click="profile.patch({ avatar: '' })"
          >
            <AppIcon name="trash" :size="14" />
          </button>
        </div>
        <p class="profile-card__hint">头像会裁成正方形并压缩到 128px。</p>
      </div>
    </div>

    <label class="field profile-field">
      <span class="field__label">助手名称</span>
      <t-input
        :value="profile.state.assistantName"
        :maxlength="24"
        placeholder="HomeClaw"
        size="small"
        @change="(v: unknown) => profile.patch({ assistantName: typeof v === 'string' ? v : '' })"
      />
    </label>

    <button type="button" class="row-btn" @click="profile.reset()">
      <AppIcon name="refresh" :size="15" />
      <span>恢复默认</span>
      <span class="row-btn__hint">昵称、头像、助手名</span>
    </button>
  </div>
</template>
