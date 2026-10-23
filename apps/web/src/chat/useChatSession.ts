import { computed, onScopeDispose, ref, shallowRef } from "vue";
import type { Attachment, ClientEnvelope, Envelope } from "@homeclaw/contracts";
import { PROTOCOL_VERSION } from "@homeclaw/contracts";
import { GatewayChannel } from "@/api/gateway";
import { api } from "@/api/client";
import { useModelStore } from "@/stores/models";
import { MAX_FILES_PER_MESSAGE, prepareUpload, releaseAllAttachmentUrls } from "./files";
import { initialChatState, appendLocalUser, fromHistory, markStopped, reduceEnvelope, type ChatState } from "./reducer";

const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * 待发送附件。上传是即时的：选中文件就立刻传，发送时只挑 ready 的，
 * 这样"发送"按钮不需要等网络，也不会出现"点了发送但附件还在传"的竞态。
 */
export type PendingAttachment = {
  key: string;
  name: string;
  mime: string;
  size: number;
  status: "uploading" | "ready" | "error";
  error?: string;
  attachment?: Attachment;
  /** 上传前用本地 blob 预览，省一次回读 */
  previewUrl?: string;
};

/**
 * 流式增量渲染调度：
 * - 分片先累积进 buffer，按 rAF 批量 apply（§3.1 性能要求）；
 * - 避免每个 token 触发一次 Vue patch。
 */
export function useChatSession() {
  const state = shallowRef<ChatState>({ ...initialChatState });
  /** 历史加载态：首屏/切会话时用来区分"空会话"和"还没加载" */
  const loadingHistory = ref(false);
  /** 分页游标：HomeHub 的 messages.seq（不是 log_seq） */
  const historyCursor = ref<number | null>(null);
  const hasMoreHistory = ref(false);
  const connected = ref(false);
  const reconnecting = ref(false);
  const input = ref("");
  const sending = ref(false);
  const currentSessionId = ref<string | null>(null);
  const pending = ref<PendingAttachment[]>([]);
  /**
   * 深度思考开关：开着就把本次请求交给规划内核。
   *
   * 默认关。默认开的问题是：普通说话（"开灯"）也会被判成复杂任务，
   * 用户看到的只是"变慢了"，而不知道是自己开的一个开关导致的。
   * 状态存在内存里、不落盘 —— 它是"这一条怎么发"，不是"以后都这样"。
   */
  const deepThinking = ref(false);
  const models = useModelStore();

  let channel: GatewayChannel | null = null;
  let buffer: Envelope[] = [];
  let raf = 0;

  function flush() {
    raf = 0;
    if (buffer.length === 0) return;
    let next = state.value;
    for (const env of buffer) next = reduceEnvelope(next, env);
    buffer = [];
    state.value = next;
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(flush);
  }

  function handleEnvelope(env: Envelope) {
    buffer.push(env);
    schedule();
  }
  /**
   * 拉一页历史（§3.1：消息超 500 条要分页）。
   * 顺序很重要：先拉历史、再建连。
   * 反过来会丢消息 —— SSE 建连后到历史返回前的这段时间，
   * 新信封已经进了列表，而历史一到就把整个 state 覆盖掉。
   */
  async function loadHistory(id: string) {
    loadingHistory.value = true;
    try {
      const rows = await api.messages(id, { limit: 50 });
      const hist = fromHistory(rows);
      state.value = hist;
      historyCursor.value = rows.length >= 50 ? rows[0]!.seq : null;
      hasMoreHistory.value = rows.length >= 50;
    } catch {
      // 历史拉不到不能挡住对话：会话可能是刚建的（还没落库），也可能是 HomeHub 暂时不可用
      state.value = { ...initialChatState };
      historyCursor.value = null;
      hasMoreHistory.value = false;
    } finally {
      loadingHistory.value = false;
    }
  }

  /** 上翻加载更早的一页：必须 prepend，不能替换 */
  async function loadOlder() {
    const id = currentSessionId.value;
    const before = historyCursor.value;
    if (!id || before === null || loadingHistory.value) return;
    loadingHistory.value = true;
    try {
      const rows = await api.messages(id, { before, limit: 50 });
      if (rows.length > 0) {
        const older = fromHistory(rows);
        state.value = { ...state.value, items: [...older.items, ...state.value.items] };
        historyCursor.value = rows[0]!.seq;
      }
      hasMoreHistory.value = rows.length >= 50;
    } finally {
      loadingHistory.value = false;
    }
  }

  async function open(id: string) {
    close();
    currentSessionId.value = id;
    state.value = { ...initialChatState };

    await loadHistory(id);

    channel = new GatewayChannel(id, {
      onEnvelope: handleEnvelope,
      onOpen: () => {
        connected.value = true;
        reconnecting.value = false;
      },
      onClose: () => {
        connected.value = false;
        reconnecting.value = true;
      },
      onError: () => {
        connected.value = false;
        reconnecting.value = true;
      },
    });
    await channel.connect();
  }

  /* ---------------- 附件 ---------------- */

  function dropAttachment(key: string) {
    const item = pending.value.find((p) => p.key === key);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    pending.value = pending.value.filter((p) => p.key !== key);
    // 已落库的附件顺手删掉，避免留下孤儿文件占磁盘
    if (item?.attachment) void api.deleteAttachment(item.attachment.id).catch(() => {});
  }

  /** 选中文件：立刻上传。返回失败列表，供 UI 一次性提示 */
  async function addFiles(files: File[]): Promise<string[]> {
    const room = MAX_FILES_PER_MESSAGE - pending.value.length;
    const accepted = files.slice(0, Math.max(0, room));
    const rejected = files.slice(accepted.length).map((f) => `${f.name} 超出单条消息上限`);
    if (accepted.length === 0) return rejected;

    const slots: PendingAttachment[] = accepted.map((file) => ({
      key: uid("att"),
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
      status: "uploading",
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));
    pending.value = [...pending.value, ...slots];

    await Promise.all(
      accepted.map(async (file, i) => {
        const slot = slots[i]!;
        try {
          const payload = await prepareUpload(file);
          const saved = await api.uploadAttachment(payload);
          const idx = pending.value.findIndex((p) => p.key === slot.key);
          if (idx < 0) return;
          const next = pending.value.slice();
          next[idx] = { ...next[idx]!, status: "ready", attachment: saved, mime: payload.mime, size: payload.size };
          pending.value = next;
        } catch (err) {
          const message = err instanceof Error ? err.message : "上传失败";
          const idx = pending.value.findIndex((p) => p.key === slot.key);
          if (idx < 0) return;
          const next = pending.value.slice();
          next[idx] = { ...next[idx]!, status: "error", error: message };
          pending.value = next;
          rejected.push(message);
        }
      }),
    );

    return rejected;
  }

  const uploading = computed(() => pending.value.some((p) => p.status === "uploading"));
  const readyAttachments = computed(() =>
    pending.value.filter((p) => p.status === "ready" && p.attachment).map((p) => p.attachment!),
  );
  async function send() {
    const text = input.value.trim();
    const attachments = readyAttachments.value;
    if ((!text && attachments.length === 0) || !channel || sending.value || uploading.value) return;

    const id = uid("c");
    sending.value = true;
    input.value = "";

    // 乐观更新：本地立即显示，服务端回声按 id 去重。
    // 带 previewUrl 的副本只用于本地渲染，回执与历史里都是服务端地址。
    const local = attachments.map((a) => ({ ...a, previewUrl: pending.value.find((p) => p.attachment?.id === a.id)?.previewUrl }));
    state.value = appendLocalUser(state.value, id, text, local);
    pending.value = [];

    const env: ClientEnvelope = {
      v: PROTOCOL_VERSION,
      type: "user.message",
      id,
      session_id: currentSessionId.value ?? undefined,
      ts: Math.floor(Date.now() / 1000),
      payload: {
        text,
        attachments,
        ...(models.activeId ? { model_id: models.activeId } : {}),
        ...(deepThinking.value ? { prefer_planning: true } : {}),
      },
    };
    try {
      await channel.send(env);
    } finally {
      sending.value = false;
    }
  }

  async function stop() {
    if (!channel) return;
    const target = state.value.activeUserMsgId;
    if (!target) return;
    const env: ClientEnvelope = {
      v: PROTOCOL_VERSION,
      type: "run.cancel",
      id: uid("x"),
      session_id: currentSessionId.value ?? undefined,
      payload: { target },
    };
    await channel.send(env);
    state.value = markStopped(state.value);
  }

  function close() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    buffer = [];
    channel?.close();
    channel = null;
    connected.value = false;
  }

  onScopeDispose(() => {
    close();
    // 会话卸载时统一回收 blob URL：预览缓存是按 id 复用的，不能逐个 revoke
    releaseAllAttachmentUrls();
    for (const p of pending.value) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    pending.value = [];
  });

  return {
    state,
    connected,
    reconnecting,
    input,
    sending,
    loadingHistory,
    hasMoreHistory,
    pending,
    uploading,
    readyAttachments,
    deepThinking,
    open,
    loadOlder,
    send,
    stop,
    close,
    addFiles,
    dropAttachment,
    canStop: computed(() => Boolean(state.value.activeReplyId)),
    canSend: computed(
      () => !sending.value && !uploading.value && (input.value.trim().length > 0 || readyAttachments.value.length > 0),
    ),
  };
}