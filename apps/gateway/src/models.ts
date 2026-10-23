import fs from "node:fs";
import path from "node:path";
import { MockLlm, HttpLlm, UpstreamError, type Llm, type LlmChatRequest, type LlmTurn } from "./llm.ts";
import { AnthropicLlm } from "./anthropic.ts";

/**
 * 模型配置（对齐 cc-switch 的字段集合）。
 *
 * 必填四项：名称、Base URL、API Key、模型 ID。
 * 可选四项：上游协议（wire_api）、推理强度、上下文窗口、关闭会话存储。
 *
 * 协议支持三种：
 *  - chat_completions：OpenAI 兼容（DeepSeek / Moonshot / 通义 / vLLM / Ollama …），默认
 *  - responses：OpenAI Responses API（Codex / 新版 OpenAI / MiMo 原生）
 *  - anthropic：Claude Messages API（Claude 系列直连）
 *
 * 没有"预置模型"这个概念：首次启动列表为空，没配就降级走离线规则引擎。
 */
export type WireApi = "chat_completions" | "responses" | "anthropic";

export type ModelProfile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** 只存服务端；任何 GET 都不返回明文 */
  apiKey?: string;
  /** 上游协议；缺省按 chat_completions 处理（兼容面最广） */
  wireApi?: WireApi;
  /** low / medium / high；模型不支持时由上游忽略或报错，不在客户端假装成功 */
  reasoningEffort?: "low" | "medium" | "high";
  /** 上下文窗口上限（token）；只用于展示与计算，不做裁剪 */
  contextWindow?: number;
  /** cc-switch 的 disable_response_storage：对 Responses API 有效 */
  disableResponseStorage?: boolean;
};

export type PublicModel = Omit<ModelProfile, "apiKey"> & { has_key: boolean };

export type ModelInput = {
  name: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  wireApi?: WireApi;
  reasoningEffort?: "low" | "medium" | "high";
  contextWindow?: number;
  disableResponseStorage?: boolean;
};

type Stored = { active_id: string | null; models: ModelProfile[] };

const WIRES: WireApi[] = ["chat_completions", "responses", "anthropic"];
const EFFORTS = ["low", "medium", "high"] as const;

function uid(): string {
  return `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function wire(v: unknown): WireApi | undefined {
  return WIRES.includes(v as WireApi) ? (v as WireApi) : undefined;
}

function effort(v: unknown): ModelProfile["reasoningEffort"] | undefined {
  return EFFORTS.includes(v as "low") ? (v as ModelProfile["reasoningEffort"]) : undefined;
}

function toPublic(m: ModelProfile): PublicModel {
  const { apiKey, ...rest } = m;
  return { ...rest, has_key: Boolean(apiKey) };
}

export class ModelRegistry {
  private readonly file: string;
  private state: Stored;

  constructor(opts: { file?: string } = {}) {
    this.file = opts.file ?? path.resolve("data/gateway-settings.json");
    this.state = this.load();
  }

  private load(): Stored {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Stored>;
      if (Array.isArray(raw.models)) {
        // 只保留新契约认识的键；旧版本的 builtin / temperature / vision 一律丢弃
        const models = raw.models
          .filter((m) => m && typeof m.id === "string" && m.id !== "builtin")
          .map((m) => {
            const mm = m as Record<string, unknown>;
            return {
              id: mm.id as string,
              name: typeof mm.name === "string"
                ? mm.name
                : String(mm.label ?? "未命名模型"),
              baseUrl: typeof mm.baseUrl === "string" ? mm.baseUrl : "",
              model: typeof mm.model === "string" ? mm.model : "",
              ...(typeof mm.apiKey === "string" ? { apiKey: mm.apiKey } : {}),
              ...(wire(mm.wireApi) ? { wireApi: wire(mm.wireApi) } : {}),
              ...(effort(mm.reasoningEffort) ? { reasoningEffort: effort(mm.reasoningEffort) } : {}),
              ...(typeof mm.contextWindow === "number" && mm.contextWindow > 0
                ? { contextWindow: Math.round(mm.contextWindow) }
                : {}),
              ...(typeof mm.disableResponseStorage === "boolean"
                ? { disableResponseStorage: mm.disableResponseStorage }
                : {}),
            };
          });
        const active = models.some((m) => m.id === raw.active_id) ? (raw.active_id as string) : null;
        return { active_id: active, models };
      }
    } catch {
      /* 首次启动或文件损坏：从空列表开始，不阻断服务 */
    }
    return { active_id: null, models: [] };
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf8");
  }

  list(): { active_id: string | null; models: PublicModel[] } {
    return { active_id: this.state.active_id, models: this.state.models.map(toPublic) };
  }

  get(id: string): ModelProfile | undefined {
    return this.state.models.find((m) => m.id === id);
  }

  get activeId(): string | null {
    return this.state.active_id;
  }

  active(): ModelProfile | undefined {
    return this.state.active_id ? this.get(this.state.active_id) : undefined;
  }

  setActive(id: string): boolean {
    if (!this.get(id)) return false;
    this.state.active_id = id;
    this.persist();
    return true;
  }

  create(input: ModelInput): PublicModel {
    const m: ModelProfile = {
      id: uid(),
      name: input.name.trim().slice(0, 80) || "未命名模型",
      baseUrl: (input.baseUrl ?? "").trim(),
      model: (input.model ?? "").trim(),
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.wireApi ? { wireApi: input.wireApi } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
      ...(input.disableResponseStorage !== undefined ? { disableResponseStorage: input.disableResponseStorage } : {}),
    };
    this.state.models.push(m);
    // 第一个添加的模型自动生效，省掉"加完还得再点一次"的步骤
    if (!this.state.active_id) this.state.active_id = m.id;
    this.persist();
    return toPublic(m);
  }

  update(id: string, input: Partial<ModelInput>): PublicModel | undefined {
    const m = this.get(id);
    if (!m) return undefined;
    if (input.name !== undefined) m.name = input.name.trim().slice(0, 80) || m.name;
    if (input.baseUrl !== undefined) m.baseUrl = input.baseUrl.trim();
    if (input.model !== undefined) m.model = input.model.trim();
    if (input.apiKey) m.apiKey = input.apiKey;
    if (input.wireApi !== undefined) m.wireApi = wire(input.wireApi);
    if (input.reasoningEffort !== undefined) m.reasoningEffort = effort(input.reasoningEffort);
    if (input.contextWindow !== undefined) {
      m.contextWindow = typeof input.contextWindow === "number" && input.contextWindow > 0
        ? Math.round(input.contextWindow)
        : undefined;
    }
    if (input.disableResponseStorage !== undefined) m.disableResponseStorage = input.disableResponseStorage;
    this.persist();
    return toPublic(m);
  }

  remove(id: string): boolean {
    const idx = this.state.models.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    this.state.models.splice(idx, 1);
    if (this.state.active_id === id) this.state.active_id = this.state.models[0]?.id ?? null;
    this.persist();
    return true;
  }

  /** 按配置造 LLM；没有可用配置时走离线规则引擎，绝不假装接了真模型 */
  build(id?: string): Llm {
    const m = (id ? this.get(id) : undefined) ?? this.active();
    if (!m || !m.apiKey || !m.baseUrl || !m.model) return new MockLlm();
    const base = { baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model };
    if (m.wireApi === "anthropic") return new AnthropicLlm(base);
    if (m.wireApi === "responses") return new ResponsesLlm({ ...base, effort: m.reasoningEffort, disableResponseStorage: m.disableResponseStorage });
    return new HttpLlm(base);
  }

  describe(id?: string): { id: string | null; name: string; model: string; connected: boolean } {
    const m = (id ? this.get(id) : undefined) ?? this.active();
    if (!m) return { id: null, name: "离线规则引擎", model: "rule-based", connected: false };
    return { id: m.id, name: m.name, model: m.model, connected: Boolean(m.apiKey) };
  }
}

/** Responses API（OpenAI 新协议 / Codex / MiMo） */
export class ResponsesLlm implements Llm {
  readonly name: string;
  private readonly o: { baseUrl: string; apiKey: string; model: string; effort?: string; disableResponseStorage?: boolean };
  constructor(o: ResponsesLlm["o"]) { this.o = o; this.name = `responses:${o.model}`; }

  async chat(req: LlmChatRequest): Promise<LlmTurn> {
    // 只发送文本部分；图片走 chat_completions 的 data URL 形式，这里先不展开
    const input = req.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
    const res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
      body: JSON.stringify({
        model: this.o.model,
        input,
        ...(this.o.effort ? { reasoning: { effort: this.o.effort } } : {}),
        ...(this.o.disableResponseStorage ? { store: false } : {}),
      }),
      signal: req.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new UpstreamError(`Responses HTTP ${res.status}: ${t.slice(0, 300)}`, res.status >= 500 || res.status === 429);
    }
    const body = (await res.json()) as { output_text?: string };
    return { kind: "text", text: body.output_text ?? "" };
  }
}
