import type { Attachment, Entity, EntityCommandResponse, Scene, SceneRunResult, Session, Message, AuditEntry, Health, DeviceEvent } from "@homeclaw/contracts";
import { platform } from "@/platform";

/** 统一的 HTTP 错误：保留 code 供 UI 决定是否展示"重试" */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * 拼 query 后缀。抽成工具函数而不是内联嵌套模板，
 * 是为了让路径在源码里保持"字面量形状"，便于静态核对前后端契约。
 */
function q(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, String(v));
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

async function runtime() {
  return platform().runtimeConfig();
}

/**
 * 只有真正带 body 时才声明 JSON。
 *
 * 统一加 Content-Type 是"顺手"的写法，但 DELETE 这类没有 body 的请求会被
 * Fastify 判成"声明了 JSON 却没有内容"→ 400。表现就是"删除接口报错"。
 */
function bodyHeaders(init?: RequestInit): Record<string, string> {
  return init?.body !== undefined && init.body !== null ? { "content-type": "application/json" } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { hubBaseUrl, hubToken } = await runtime();
  const headers: Record<string, string> = bodyHeaders(init);
  // 用户票据只发往 HomeHub，且只在配置了才发（mock-server 不需要）
  if (hubToken) headers.authorization = `Bearer ${hubToken}`;

  const res = await fetch(`${hubBaseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
  });
  if (!res.ok) {
    let body: { code?: string; message?: string; retryable?: boolean } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError(res.status, body.code ?? "INTERNAL", body.message ?? `HTTP ${res.status}`, body.retryable ?? false);
  }
  return (await res.json()) as T;
}

/** 规则触发条件：字段与 HomeHub 的 RuleWhenBody 一一对应 */
export type RuleWhen = {
  kind?: "state_changed" | "availability_changed" | "triggered";
  entity?: string;
  to?: boolean | number | string;
  from?: boolean | number | string;
  attribute?: string;
  for_seconds?: number;
  gt?: number;
  lt?: number;
  time_between?: [number, number];
};

/** 规则动作：一期只有"下命令"和"跑场景"两种 */
export type RuleThen =
  | { action: "entity.command"; entity: string; service: string; data?: Record<string, unknown>; delay_ms?: number }
  | { action: "scene.run"; name: string };

/** 自动化规则（HomeHub GET /v1/automations 的形状） */
export type AutomationRule = {
  id: string;
  home_id: string;
  enabled: boolean;
  when: RuleWhen;
  then: RuleThen[];
  cooldown_seconds: number;
  last_fired_at: number | null;
};

/** 可编辑的规则字段：PATCH 只改传进来的键，其余保持不变 */
export type RulePatch = {
  enabled?: boolean;
  when?: RuleWhen;
  then?: RuleThen[];
  cooldown_seconds?: number;
};

/** 规则执行历史（rule_run 表） */
export type RuleRun = {
  automation_id: string;
  trace_id: string;
  matched: boolean;
  ok: boolean;
  detail: string;
  ts: number;
};

/** EventBus 裁决日志（trigger_log 表）：解释"事件为什么没触发推理" */
export type TriggerLog = {
  entity_id: string;
  room: string | null;
  ts: number;
  outcome: string;
};

/**
 * 模型配置（L2），字段对齐 cc-switch：
 * 必填：名称 / Base URL / API Key / 模型 ID
 * 可选：上游协议 / 推理强度 / 上下文窗口 / 关闭会话存储
 * apiKey 永不下发，只有 has_key。
 */
export type WireApi = "chat_completions" | "responses" | "anthropic";
export type ReasoningEffort = "low" | "medium" | "high";

export type ModelProfile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  has_key: boolean;
  wireApi?: WireApi;
  reasoningEffort?: ReasoningEffort;
  contextWindow?: number;
  disableResponseStorage?: boolean;
};

export type ModelInput = {
  name: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  wireApi?: WireApi;
  reasoningEffort?: ReasoningEffort;
  contextWindow?: number;
  disableResponseStorage?: boolean;
};

export type ModelTestResult = { ok: boolean; latency_ms: number; message?: string };


/* ---------------- 智能体内核（L2 Hermes） ---------------- */

/**
 * MCP 服务器：内置项（homehub / homeclaw-tools）可禁用不可删。
 *
 * 服务端不回传 token 明文，只回 has_token；新增/修改时如果填了新 token 才上行。
 */
export type McpServer = {
  name: string;
  url: string;
  token?: string;
  has_token?: boolean;
  enabled: boolean;
  builtin?: boolean;
};

/**
 * 内核设置。字段与 gateway 的 HermesSettings 一一对应。
 * runtimeDir / launcher 是高级项（换 venv 位置、接自定义启动器），
 * 普通用户只需要 enabled + workspaceRoot。
 */
export type HermesSettings = {
  enabled: boolean;
  runtimeDir: string;
  launcher: string;
  args: string[];
  protocol: "ndjson" | "text";
  timeoutMs: number;
  workspaceRoot: string;
  allowShell: boolean;
  mcpServers: McpServer[];
};

export type HermesStatus = {
  enabled: boolean;
  status: "ready" | "not_ready";
  source: string;
  detail: string;
  venv_dir: string | null;
  launcher: string | null;
  home: string;
  protocol: string;
  timeout_ms: number;
  workspace: string;
  allow_shell: boolean;
  mcp_servers: Array<{ name: string; url: string; enabled: boolean; builtin: boolean }>;
  skills: Array<{ name: string; description: string }>;
  last_error: string | null;
};

export type HermesTestResult = { ok: boolean; message: string; elapsed_ms: number };

/** L2 网关请求：与 HomeHub 分开，因为两者地址与鉴权都不同 */
async function gatewayRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const { gatewayBaseUrl } = await runtime();
  const res = await fetch(`${gatewayBaseUrl}${path}`, {
    ...init,
    headers: { ...bodyHeaders(init), ...((init?.headers as Record<string, string>) ?? {}) },
  });
  if (!res.ok) {
    let body: { code?: string; message?: string; retryable?: boolean } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError(res.status, body.code ?? "INTERNAL", body.message ?? `HTTP ${res.status}`, body.retryable ?? false);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<Health>("/health"),

  entities: (filter?: { room?: string; type?: string }) =>
    request<Entity[]>(`/entities${q({ room: filter?.room, type: filter?.type })}`),
  entity: (id: string) => request<Entity>(`/entities/${encodeURIComponent(id)}`),
  command: (id: string, body: { service: string; data?: Record<string, unknown>; idempotency_key?: string }) =>
    request<EntityCommandResponse>(`/entities/${encodeURIComponent(id)}/command`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  scenes: () => request<Scene[]>("/scenes"),
  runScene: (id: string) => request<SceneRunResult>(`/scenes/${encodeURIComponent(id)}/run`, { method: "POST" }),

  sessions: () => request<Session[]>("/sessions"),
  createSession: (title?: string) => request<Session>("/sessions", { method: "POST", body: JSON.stringify({ title }) }),
  messages: (sessionId: string, page?: { after?: number; before?: number; limit?: number }) =>
    request<Message[]>(
      `/sessions/${encodeURIComponent(sessionId)}/messages${q({ after: page?.after, before: page?.before, limit: page?.limit })}`,
    ),

  audit: (filter?: { from?: number; to?: number; entity?: string; trace_id?: string; decision?: string; limit?: number }) =>
    request<AuditEntry[]>(`/audit${q({ ...filter })}`),

  /** 自动化规则（§6.4）：一期只读 + 启停，编辑留到二期 */
  automations: () => request<AutomationRule[]>("/automations"),
  enableAutomation: (id: string, on: boolean) =>
    request<{ ok: boolean; enabled: boolean }>(`/automations/${encodeURIComponent(id)}/enable`, {
      method: "POST",
      body: JSON.stringify({ on }),
    }),
  updateAutomation: (id: string, patch: RulePatch) =>
    request<{ ok: boolean; rule: AutomationRule }>(`/automations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  automationHistory: (limit = 50) => request<RuleRun[]>(`/automations/history${q({ limit })}`),
  automationTriggers: (limit = 50) => request<TriggerLog[]>(`/automations/triggers${q({ limit })}`),

  /* ---- 附件（L3）：base64 JSON，避免 multipart 依赖 ---- */
  uploadAttachment: (input: { name: string; mime: string; data: string }) =>
    request<Attachment>("/attachments", { method: "POST", body: JSON.stringify(input) }),
  deleteAttachment: (id: string) =>
    request<{ ok: boolean }>(`/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /* ---- 模型配置（L2） ---- */
  models: () => gatewayRequest<{ active_id: string | null; models: ModelProfile[] }>("/v1/models"),
  createModel: (input: ModelInput) =>
    gatewayRequest<ModelProfile>("/v1/models", { method: "POST", body: JSON.stringify(input) }),
  updateModel: (id: string, input: Partial<ModelInput>) =>
    gatewayRequest<ModelProfile>(`/v1/models/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteModel: (id: string) =>
    gatewayRequest<{ ok: boolean }>(`/v1/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
  activateModel: (id: string) =>
    gatewayRequest<{ ok: boolean; active_id: string | null }>("/v1/models/active", { method: "PUT", body: JSON.stringify({ id }) }),
  testModel: (id: string) =>
    gatewayRequest<ModelTestResult>(`/v1/models/${encodeURIComponent(id)}/test`, { method: "POST" }),

  /* ---- 智能体内核（L2）：Hermes 运行时 + 内置工具 + 技能 ---- */
  hermesSettings: () => gatewayRequest<HermesSettings & { status: HermesStatus }>("/v1/hermes/settings"),
  updateHermesSettings: (patch: Partial<HermesSettings>) =>
    gatewayRequest<HermesSettings & { status: HermesStatus }>("/v1/hermes/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  hermesStatus: () => gatewayRequest<HermesStatus>("/v1/hermes/status"),
  /** 真起一次子进程验证；不要用"文件存在"代替 */
  testHermes: () => gatewayRequest<HermesTestResult>("/v1/hermes/test", { method: "POST" }),
  skills: () => gatewayRequest<{ skills: Array<{ name: string; description: string }>; home: string }>("/v1/skills"),
  /** AI 记住的偏好：只读，写操作走 HomeHub 的 /preferences */
  memory: () => gatewayRequest<{ items: Array<{ key: string; value: string }> }>("/v1/memory"),
  preferences: () => request<Array<{ key: string; value: string; updated_at: number }>>("/preferences"),
  setPreference: (key: string, value: string) =>
    request<{ key: string; value: string }>(`/preferences/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  removePreference: (key: string) =>
    request<{ ok: boolean }>(`/preferences/${encodeURIComponent(key)}`, { method: "DELETE" }),
  builtinTools: () => gatewayRequest<{ tools: Array<{ name: string; description: string }>; local_mcp: string | null }>("/v1/tools"),
};

/**
 * 附件字节：必须带用户票据 fetch 成 blob，不能直接 <img src>。
 * 历史消息里的图片/PDF 都走这里，调用方负责 revokeObjectURL。
 */
export async function fetchAttachmentBlob(id: string): Promise<Blob> {
  const { hubBaseUrl, hubToken } = await runtime();
  const headers: Record<string, string> = {};
  if (hubToken) headers.authorization = `Bearer ${hubToken}`;
  const res = await fetch(`${hubBaseUrl}/attachments/${encodeURIComponent(id)}`, { headers });
  if (!res.ok) throw new ApiError(res.status, "ATTACHMENT", `附件读取失败：HTTP ${res.status}`, res.status >= 500);
  return await res.blob();
}

/** 附件文本预览：只对文本类调用，读取上限由服务端保证 */
export async function fetchAttachmentText(id: string): Promise<string> {
  const blob = await fetchAttachmentBlob(id);
  return await blob.text();
}

/**
 * 设备事件流（M1）：面板实时刷新用。
 * 与对话流是两条独立的 SSE —— 一条来自 HomeHub，一条来自 Gateway。
 * 只有 HomeHub 支持该接口时才订阅；mock-server 上会 404，直接降级为轮询。
 */
export async function openDeviceStream(
  onEvent: (e: DeviceEvent) => void,
  onState?: (s: "open" | "error") => void,
): Promise<() => void> {
  const { hubBaseUrl, hubToken } = await runtime();
  const ac = new AbortController();

  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (hubToken) headers.authorization = `Bearer ${hubToken}`;

  void (async () => {
    try {
      const res = await fetch(`${hubBaseUrl}/events`, { headers, signal: ac.signal });
      if (!res.ok || !res.body) {
        onState?.("error");
        return;
      }
      onState?.("open");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          idx = buf.indexOf("\n\n");
          if (block.startsWith(":")) continue;
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            onEvent(JSON.parse(dataLine.slice(6)) as DeviceEvent);
          } catch {
            /* 坏帧丢弃：单帧解析失败不应中断整条流 */
          }
        }
      }
      onState?.("error");
    } catch {
      if (!ac.signal.aborted) onState?.("error");
    }
  })();

  return () => ac.abort();
}