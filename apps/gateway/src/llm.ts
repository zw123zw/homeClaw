/**
 * LLM 适配层。
 *
 * 为什么自己写这一层而不是直接用某个 SDK 的 chat 接口：
 *  1. 需要"可离线"——没有 API key 时整条链路必须还能跑（MockLLM）；
 *  2. 需要"可断言"——评测与验收要能复现同一轮工具选择；
 *  3. 只需要 chat + tools 两个能力，SDK 的其余部分都是负担。
 *
 * 协议选择 OpenAI 兼容的 /chat/completions：DeepSeek、Moonshot、通义、vLLM、
 * Ollama 都实现了它，换供应商只改 baseUrl 与 model。
 */

export type LlmToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

/** 多模态输入：文本块 + 图片块（OpenAI 兼容线格式） */
export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type LlmUserContent = string | LlmContentPart[];

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: LlmUserContent }
  | { role: "assistant"; content: string; tool_calls?: LlmToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

/** 从多模态内容里取纯文本：Mock 与降级路径只需要文字 */
export function textOf(content: LlmUserContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<LlmContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export type LlmToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type LlmTurn =
  | { kind: "text"; text: string; usage?: { prompt: number; completion: number } }
  | { kind: "tools"; calls: LlmToolCall[]; text?: string; usage?: { prompt: number; completion: number } };

export type LlmChatRequest = {
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export interface Llm {
  readonly name: string;
  chat(req: LlmChatRequest): Promise<LlmTurn>;
}

/* ------------------------------------------------------------------ */
/* 真实 LLM（OpenAI 兼容）                                             */
/* ------------------------------------------------------------------ */

export type HttpLlmOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 流式关闭：一期只需要"一轮完整回复"，流式由 Gateway 自己按句切分下发 */
  temperature?: number;
  maxTokens?: number;
};

export class HttpLlm implements Llm {
  readonly name: string;
  private readonly o: HttpLlmOptions;

  constructor(o: HttpLlmOptions) {
    this.o = o;
    this.name = `http:${o.model}`;
  }

  async chat(req: LlmChatRequest): Promise<LlmTurn> {
    // 内部表示 → OpenAI 线格式
    const messages = req.messages.map((m) => {
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: m.content || null,
          ...(m.tool_calls?.length
            ? {
                tool_calls: m.tool_calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }
            : {}),
        };
      }
      if (m.role === "tool") {
        return { role: "tool", tool_call_id: m.tool_call_id, name: m.name, content: m.content };
      }
      if (m.role === "user") return { role: "user", content: m.content };
      return { role: m.role, content: m.content };
    });

    const send = (msgs: unknown[]) =>
      fetch(`${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.o.apiKey}`,
        },
        body: JSON.stringify({
          model: this.o.model,
          messages: msgs,
          tools: req.tools.length ? req.tools : undefined,
          tool_choice: req.tools.length ? "auto" : undefined,
          temperature: req.temperature ?? this.o.temperature ?? 0.3,
          max_tokens: req.maxTokens ?? this.o.maxTokens ?? 800,
        }),
        signal: req.signal,
      });

    let res = await send(messages);

    /**
     * 图片降级：不要求用户预先声明"我的模型支不支持视觉"。
     * 一旦上游明确拒绝（4xx）且本轮带了图片，就把图片块摘掉重试一次，
     * 并在文本里说明"图未送达"，而不是让整轮对话失败。
     */
    if (!res.ok && res.status >= 400 && res.status < 500 && hasImagePart(req.messages)) {
      const detail = await res.text().catch(() => "");
      if (/image|vision|multimodal|content.*type/i.test(detail) || res.status === 400) {
        const downgraded = messages.map((m) => {
          if (m.role !== "user" || typeof m.content === "string" || !Array.isArray(m.content)) return m;
          const parts = m.content.filter((p) => p.type !== "image_url");
          const text = parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n");
          return { role: "user", content: `${text}\n\n（图片未能发送：当前模型不支持图片输入）` };
        });
        res = await send(downgraded);
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 明确区分"上游不可用"与"我们的 bug"：前者该重试/降级，后者该修
      throw new UpstreamError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`, res.status >= 500 || res.status === 429);
    }

    const body = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const msg = body.choices?.[0]?.message;
    if (!msg) throw new UpstreamError("LLM 返回空 choices", true);

    const usage = {
      prompt: body.usage?.prompt_tokens ?? 0,
      completion: body.usage?.completion_tokens ?? 0,
    };

    if (msg.tool_calls?.length) {
      return {
        kind: "tools",
        text: msg.content ?? undefined,
        usage,
        calls: msg.tool_calls.map((c) => ({
          id: c.id,
          name: c.function.name,
          args: safeJson(c.function.arguments),
        })),
      };
    }

    return { kind: "text", text: msg.content ?? "", usage };
  }
}

function hasImagePart(messages: LlmMessage[]): boolean {
  return messages.some(
    (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
  );
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    // 模型给出坏 JSON 时不抛错：交给工具层的参数校验生成可读的失败信息
    return {};
  }
}

export class UpstreamError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "UpstreamError";
    this.retryable = retryable;
  }
}

/* ------------------------------------------------------------------ */
/* 离线 LLM（Mock）：没有 API key 时整条链路仍然可用                    */
/* ------------------------------------------------------------------ */

/**
 * MockLLM 不是"假成功"：它会真的解析中文指令、真的选择工具、真的把参数填对。
 * 这样在无外网的开发环境里，"自然语言 → 工具调用 → 设备状态变化"这条链路
 * 仍然是被端到端验证过的，而不是被跳过。
 */
export class MockLlm implements Llm {
  readonly name = "mock:rule-based";

  async chat(req: LlmChatRequest): Promise<LlmTurn> {
    const last = [...req.messages].reverse().find((m) => m.role === "user");
    const text = last && "content" in last ? textOf(last.content) : "";

    // 已经执行过工具：这一轮给最终答复
    const toolResults = req.messages.filter((m) => m.role === "tool");
    if (toolResults.length > 0) {
      // 只取 summary 说人话：把工具返回的 JSON 原样倒给用户是最差的可读性
      const lines = toolResults.map((m) => {
        if (!("content" in m)) return "";
        try {
          const v = JSON.parse(String(m.content)) as { ok?: boolean; summary?: string; error?: string };
          if (v.ok === false) return `没有完成：${v.summary ?? v.error ?? "未知原因"}`;
          return v.summary ?? "";
        } catch {
          return String(m.content).slice(0, 80);
        }
      }).filter(Boolean);

      const failed = lines.some((l) => l.startsWith("没有完成"));
      return {
        kind: "text",
        text: lines.length === 1 && !failed ? `好的，${lines[0]}。` : lines.join("\n"),
        usage: { prompt: 0, completion: 0 },
      };
    }

    const calls = this.plan(text, req.tools);
    if (calls.length === 0) {
      return {
        kind: "text",
        text: "我可以帮你控制家里的灯、窗帘、空调，查温湿度、执行场景。你想做什么？",
        usage: { prompt: 0, completion: 0 },
      };
    }

    return { kind: "tools", calls, usage: { prompt: 0, completion: 0 } };
  }

  /** 极简意图识别：只处理能明确映射到已加载工具的说法，其余交回用户 */
  private plan(text: string, tools: LlmToolSpec[]): LlmToolCall[] {
    const has = (n: string) => tools.some((t) => t.function.name === n);
    const room = ["客厅", "主卧", "书房", "厨房", "浴室", "阳台", "门口"].find((r) => text.includes(r)) ?? "客厅";

    const mk = (name: string, args: Record<string, unknown>, i = 0): LlmToolCall => ({
      id: `call_${Date.now().toString(36)}_${i}`,
      name,
      args,
    });

    // 多步："打开客厅灯并把空调调到26度"
    const steps: LlmToolCall[] = [];

    if (/灯/.test(text) && has("set_room_light")) {
      const off = /关/.test(text);
      const pct = text.match(/(\d{1,3})\s*[%％]/);
      const args: Record<string, unknown> = { room: /全屋|所有|全部/.test(text) ? "*" : room };
      if (off) args.level = 0;
      else if (pct) args.level = Number(pct[1]);
      if (/暖光/.test(text)) args.color_temp = 2700;
      if (/冷白|冷光/.test(text)) args.color_temp = 5000;
      steps.push(mk("set_room_light", args, steps.length));
    }

    if (/空调/.test(text) && has("set_climate")) {
      const temp = text.match(/(\d{1,2})\s*度/);
      const args: Record<string, unknown> = { room };
      if (temp) args.temp = Number(temp[1]);
      if (/除湿/.test(text)) args.mode = "dry";
      if (/送风/.test(text)) args.mode = "fan_only";
      if (!temp && !args.mode) args.temp = 26;
      steps.push(mk("set_climate", args, steps.length));
    }

    if (/窗帘/.test(text) && has("set_cover")) {
      const pct = text.match(/(\d{1,3})\s*[%％]/);
      steps.push(mk("set_cover", { room, position: /关/.test(text) ? 0 : pct ? Number(pct[1]) : 100 }, steps.length));
    }

    if (/场景|模式/.test(text) && has("run_scene")) {
      for (const name of ["回家模式", "离家模式", "观影模式", "睡眠模式"]) {
        if (text.includes(name.replace("模式", ""))) {
          steps.push(mk("run_scene", { name }, steps.length));
          break;
        }
      }
    }

    if (/扫地机|扫地/.test(text) && has("vacuum_clean")) {
      steps.push(mk("vacuum_clean", { room }, steps.length));
    }

    if (/电视|音乐|音响|音箱|播放/.test(text) && has("set_media")) {
      const action = /关/.test(text) ? "off" : /静音/.test(text) ? "mute" : /暂停/.test(text) ? "pause" : "on";
      steps.push(mk("set_media", { room, action }, steps.length));
    }

    if (/温湿度|多少度|几度|热不热|冷不冷/.test(text) && !/调到|设/.test(text) && has("get_room_climate")) {
      steps.push(mk("get_room_climate", { room }, steps.length));
    }

    return steps;
  }
}

/** 按配置造一个 LLM：没有 key 一律走 Mock，绝不用"假 key 请求真接口"的方式假装接了模型 */
export function createLlm(cfg: {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Llm {
  if (cfg.provider === "mock" || !cfg.apiKey) return new MockLlm();
  return new HttpLlm({
    baseUrl: cfg.baseUrl ?? "https://api.deepseek.com/v1",
    apiKey: cfg.apiKey,
    model: cfg.model ?? "deepseek-chat",
  });
}