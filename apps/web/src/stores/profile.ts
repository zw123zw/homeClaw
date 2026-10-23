import { defineStore } from "pinia";
import { computed, ref } from "vue";

/**
 * 个人资料（昵称 / 头像 / 助手名）。
 *
 * 只存本机 localStorage：
 *  - 这些是纯展示偏好，没有跨设备同步需求，不该让中枢多一张表；
 *  - 头像存 data URL（压缩到 128px 的 webp），避免额外文件服务。
 *
 * 头像限制在 128px 是有意的：聊天列表要渲染很多次，原图会让滚动变卡。
 */
export type Profile = {
  nickname: string;
  /** 助手显示名，用户可改成自己的叫法 */
  assistantName: string;
  /** data URL；空表示用首字母占位 */
  avatar: string;
};

const STORAGE_KEY = "homeclaw.profile";
export const AVATAR_MAX_EDGE = 128;

const DEFAULTS: Profile = { nickname: "我", assistantName: "HomeClaw", avatar: "" };

function read(): Profile {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Profile>;
    return {
      nickname: typeof raw.nickname === "string" && raw.nickname.trim() ? raw.nickname : DEFAULTS.nickname,
      assistantName:
        typeof raw.assistantName === "string" && raw.assistantName.trim() ? raw.assistantName : DEFAULTS.assistantName,
      avatar: typeof raw.avatar === "string" ? raw.avatar : "",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 压成正方形小图：头像不需要原始尺寸，也不该把 5MB 照片塞进 localStorage */
export async function toAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const edge = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - edge) / 2;
  const sy = (bitmap.height - edge) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_MAX_EDGE;
  canvas.height = AVATAR_MAX_EDGE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法处理图片");
  ctx.drawImage(bitmap, sx, sy, edge, edge, 0, 0, AVATAR_MAX_EDGE, AVATAR_MAX_EDGE);
  bitmap.close?.();

  return canvas.toDataURL("image/webp", 0.86);
}

export const useProfileStore = defineStore("profile", () => {
  const state = ref<Profile>(read());

  const initial = computed(() => (state.value.nickname.trim()[0] ?? "我").toUpperCase());

  function patch(next: Partial<Profile>) {
    state.value = { ...state.value, ...next };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value));
    } catch {
      /* 隐私模式写不进去也不影响本次显示 */
    }
  }

  function reset() {
    state.value = { ...DEFAULTS };
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 同上 */
    }
  }

  return { state, initial, patch, reset };
});