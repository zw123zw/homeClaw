import type { ToolHub } from "./index.ts";

/**
 * MCP Server（§3.3 toolhub）。
 *
 * 协议选择：JSON-RPC 2.0 over HTTP POST（MCP 的 streamable-http 传输）。
 * 为什么不用 stdio：HomeHub 是常驻服务，同时服务客户端面板与 AI；
 * stdio 会把工具进程绑死在单个 MCP 客户端上，接第二个（比如本地 CLI 调试）就得再起一份进程，
 * 而设备状态只有一份 —— 那会立刻出现"两份状态互相覆盖"。
 *
 * 只实现一期真正用得上的方法：initialize / tools/list / tools/call / ping。
 * 未实现的方法按 JSON-RPC 规范回 -32601，不假装支持。
 */

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export const MCP_PROTOCOL_VERSION = "2024-11-05";

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

/**
 * MCP 的 tools/call 结果格式：content 数组 + isError。
 *
 * isError 必须跟着真实结果走 —— 恒为 false 会让模型把"设备离线"当成"已执行"，
 * 然后对用户说"灯已经关了"。这是最难在事后发现的一类错误：审计里有记录，
 * 但用户看到的是一个自信的错误答案。
 */
function toContent(payload: { ok: boolean; summary: string; data?: unknown; error?: string; trace_id?: string; partial?: boolean }) {
  const body = {
    ok: payload.ok,
    summary: payload.summary,
    data: payload.data,
    error: payload.error,
    partial: payload.partial ?? false,
    trace_id: payload.trace_id,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    isError: payload.ok === false,
  };
}

export function createMcpHandler(hub: ToolHub, opts: { onCall?: (info: { tool: string; traceId: string }) => void } = {}) {
  return async function handle(body: unknown, headerSessionId?: string): Promise<JsonRpcResponse> {
    const req = body as JsonRpcRequest;

    if (!req || typeof req !== "object" || req.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id: null, error: { code: RPC_INVALID_REQUEST, message: "需要 JSON-RPC 2.0 请求体" } };
    }

    const id = req.id ?? null;

    switch (req.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "homeclaw-toolhub", version: "0.1.0" },
          },
        };

      case "notifications/initialized":
        // 通知没有 id，按规范不回包；这里统一返回空 result 方便 HTTP 客户端
        return { jsonrpc: "2.0", id, result: {} };

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list": {
        const params = (req.params ?? {}) as { session_id?: string; query?: string };
        const sessionId = params.session_id ?? headerSessionId;
        const { tools, tokens } = await hub.listToolsForSession(sessionId, params.query);
        return { jsonrpc: "2.0", id, result: { tools, _meta: { tokens } } };
      }

      case "tools/call": {
        const params = (req.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
          trace_id?: string;
          idempotency_key?: string;
          session_id?: string;
          _meta?: { trace_id?: string; idempotency_key?: string };
        };
        if (!params.name) {
          return { jsonrpc: "2.0", id, error: { code: RPC_INVALID_PARAMS, message: "缺少 tools/call.params.name" } };
        }

        const traceId = params.trace_id ?? params._meta?.trace_id ?? `tr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        opts.onCall?.({ tool: params.name, traceId });

        const result = await hub.call({
          name: params.name,
          args: params.arguments ?? {},
          traceId,
          actor: "ai:hermes",
          idempotencyKey: params.idempotency_key ?? params._meta?.idempotency_key,
          sessionId: params.session_id ?? headerSessionId,
        });

        return { jsonrpc: "2.0", id, result: toContent(result) };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: RPC_METHOD_NOT_FOUND, message: `未实现的方法：${req.method}` },
        };
    }
  };
}