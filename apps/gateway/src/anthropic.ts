/**
 * Anthropic Messages API（Claude 系列直连）。
 *
 * 只覆盖 chat 最小集：system / user / assistant 文本 + tool_use。
 * 带图片的消息会先被压成文字提示 —— Anthropic 的多模态格式和 OpenAI 差异较大，
 * 一期不做双协议的视觉对齐，避免给用户"两个协议能力一样"的错觉。
 */
import { UpstreamError, type Llm, type LlmChatRequest, type LlmMessage, type LlmTurn } from "./llm.ts";

export class AnthropicLlm implements Llm {
  readonly name: string;
  private readonly o: { baseUrl: string; apiKey: string; model: string };

  constructor(o: AnthropicLlm["o"]) {
    this.o = o;
    this.name = `anthropic:${o.model}`;
  }

  async chat(req: LlmChatRequest): Promise<LlmTurn> {
    const system = req.messages
      .filter((m): m is Extract<LlmMessage, { role: "system" }> => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    const toAnthropicContent = (m: LlmMessage): { role: "user" | "assistant"; content: unknown }[] => {
      if (m.role === "user") {
        if (typeof m.content === "string") return [{ role: "user", content: m.content }];
        const parts = m.content.map((p) =>
          p.type === "text"
            ? { type: "text", text: p.text }
            : { type: "text", text: "（图片：当前 Anthropic 协议下未发送）" },
        );
        return [{ role: "user", content: parts }];
      }
      if (m.role === "assistant") {
        const content: unknown[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const c of m.tool_calls ?? []) {
          content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
        }
        return [{ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] }];
      }
      // tool 结果
      if (m.role === "tool") {
        return [{
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: m.content,
          }],
        }];
      }
      return [];
    };

    const messages = req.messages
      .filter((m) => m.role !== "system")
      .flatMap(toAnthropicContent);

    const res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.o.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.o.model,
        max_tokens: req.maxTokens ?? 800,
        ...(system ? { system } : {}),
        messages,
        ...(req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
                input_schema: t.function.parameters,
              })),
            }
          : {}),
      }),
      signal: req.signal,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new UpstreamError(`Anthropic HTTP ${res.status}: ${t.slice(0, 300)}`, res.status >= 500 || res.status === 429);
    }

    const body = (await res.json()) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const calls = (body.content ?? [])
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? `t_${Date.now()}`, name: b.name ?? "", args: (b.input as Record<string, unknown>) ?? {} }));

    const usage = { prompt: body.usage?.input_tokens ?? 0, completion: body.usage?.output_tokens ?? 0 };
    if (calls.length) return { kind: "tools", text: text || undefined, calls, usage };
    return { kind: "text", text, usage };
  }
}
