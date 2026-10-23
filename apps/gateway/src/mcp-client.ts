/**
 * MCP 客户端（§3.2 的"接触面：MCP 客户端 ✅"）。
 *
 * 只走公开协议（initialize / tools/list / tools/call），不读 HomeHub 源码、
 * 不加私有钩子 —— 这是 C3 约束的落地方式。
 *
 * 为什么不用官方 MCP SDK：一期只需要 4 个方法、传输是 HTTP POST，
 * 引入 SDK 会带进 stdio 进程管理与 schema 校验两套用不上的东西。
 * 唯一需要自己保证的是：协议版本、错误码、isError 语义与规范一致。
 */
export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpCallResult = {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
  partial?: boolean;
  trace_id?: string;
  /** MCP 规范的 isError：为 true 时调用方必须当失败处理 */
  isError: boolean;
};

type McpClientOptions = {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** 供观测：每次 RPC 的耗时 */
  onRpc?: (info: { method: string; ms: number; ok: boolean }) => void;
};

export class McpClient {
  private rpcId = 1;
  private readonly opts: McpClientOptions;

  constructor(opts: McpClientOptions) {
    this.opts = opts;
  }

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const started = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 15_000);

    try {
      const res = await fetch(`${this.opts.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.rpcId++, method, params }),
        signal: ac.signal,
      });

      if (!res.ok) {
        throw new Error(`MCP ${method} HTTP ${res.status}`);
      }

      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (body.error) throw new Error(`MCP ${method} 失败 ${body.error.code}: ${body.error.message}`);
      if (body.result === undefined) throw new Error(`MCP ${method} 缺少 result`);

      this.opts.onRpc?.({ method, ms: Math.round(performance.now() - started), ok: true });
      return body.result;
    } catch (err) {
      this.opts.onRpc?.({ method, ms: Math.round(performance.now() - started), ok: false });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async initialize(): Promise<{ protocolVersion: string; serverInfo: { name: string; version: string } }> {
    return this.rpc("initialize", {});
  }

  /** session/query 让 HomeHub 只返回该会话命中的工具（§4.2 首选注入方式） */
  async listTools(opts: { sessionId?: string; query?: string } = {}): Promise<{ tools: McpTool[]; tokens: number }> {
    const result = await this.rpc<{ tools: McpTool[]; _meta?: { tokens?: number } }>("tools/list", {
      session_id: opts.sessionId,
      query: opts.query,
    });
    return { tools: result.tools ?? [], tokens: result._meta?.tokens ?? 0 };
  }

  async callTool(name: string, args: Record<string, unknown>, opts: { traceId?: string; idempotencyKey?: string } = {}): Promise<McpCallResult> {
    const result = await this.rpc<{
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }>("tools/call", {
      name,
      arguments: args,
      trace_id: opts.traceId,
      idempotency_key: opts.idempotencyKey,
    });

    const raw = result.content?.[0]?.text ?? "{}";
    let parsed: Partial<McpCallResult> = {};
    try {
      parsed = JSON.parse(raw) as Partial<McpCallResult>;
    } catch {
      parsed = { summary: raw };
    }

    return {
      ok: parsed.ok ?? !result.isError,
      summary: parsed.summary ?? raw,
      data: parsed.data,
      error: parsed.error,
      partial: parsed.partial,
      trace_id: parsed.trace_id,
      isError: result.isError === true,
    };
  }
}

/** 把 MCP 的 inputSchema 转成模型能用的工具描述（OpenAI 风格） */
export type ModelTool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export function toModelTool(t: McpTool): ModelTool {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  };
}
