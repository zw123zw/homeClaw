import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolRegistry } from "./index.ts";

/**
 * 本地工具 MCP 服务（JSON-RPC over HTTP POST）。
 *
 * 为什么单独起一个本机端口，而不是让 Hermes 直接 import 工具：
 * Hermes 是 Python 进程，跨语言唯一稳定接触面就是协议。MCP 是双方都认的公开协议，
 * 沿用 C3 约束（只走公开协议，不进对方源码）。
 *
 * 只监听 127.0.0.1，并校验 Bearer 票据 —— 本机其它程序（包括浏览器里的网页）
 * 不应该能借这个端口读写用户文件。绑定回环地址还不够：任意网页都能 fetch 127.0.0.1。
 */

export type ToolMcpOptions = {
  registry: ToolRegistry;
  token: string;
  port?: number;
  host?: string;
  /** 每次调用后回调：用于审计与"工具调用"日志 */
  onCall?: (info: { tool: string; ok: boolean; ms: number }) => void;
};

const MCP_PROTOCOL_VERSION = "2024-11-05";

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export function startToolMcpServer(opts: ToolMcpOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4031;

  const server = http.createServer((req, res) => {
    // 只接受 POST /mcp；其它路径返回 404，避免被当成通用 HTTP 代理
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    if (req.method !== "POST" || url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const auth = req.headers.authorization ?? "";
    if (opts.token && auth !== `Bearer ${opts.token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } }));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      // 工具参数里可能带整份文档内容，给到 8MB；再多就说明调用方用错了工具
      if (size > 8 * 1024 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on("end", () => {
      void handle(Buffer.concat(chunks).toString("utf8"))
        .then((out) => {
          res.writeHead(out.httpStatus, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(out.body));
        })
        .catch((err: unknown) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
            }),
          );
        });
    });
  });

  async function handle(raw: string): Promise<{ httpStatus: number; body: unknown }> {
    let rpc: Rpc;
    try {
      rpc = JSON.parse(raw) as Rpc;
    } catch {
      return { httpStatus: 200, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } } };
    }

    if (!rpc || typeof rpc !== "object" || rpc.jsonrpc !== "2.0") {
      return { httpStatus: 200, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } } };
    }

    const id = rpc.id ?? null;
    const ok = (result: unknown) => ({ httpStatus: 200, body: { jsonrpc: "2.0", id, result } });
    const err = (code: number, message: string) => ({ httpStatus: 200, body: { jsonrpc: "2.0", id, error: { code, message } } });

    switch (rpc.method) {
      case "initialize":
        return ok({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "homeclaw-local-tools", version: "0.1.0" },
        });

      case "notifications/initialized":
      case "ping":
        return ok({});

      case "tools/list":
        return ok({ tools: opts.registry.describe() });

      case "tools/call": {
        const params = (rpc.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (!params.name) return err(-32602, "缺少 params.name");
        const started = performance.now();
        const result = await opts.registry.call(params.name, params.arguments ?? {});
        const ms = Math.round(performance.now() - started);
        opts.onCall?.({ tool: params.name, ok: result.ok, ms });

        // MCP 规范：content 数组 + isError；正文用 JSON 字符串，与本项目 ToolHub 一致
        return ok({
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: result.ok === false,
        });
      }

      default:
        return err(-32601, `未实现的方法：${String(rpc.method)}`);
    }
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${addr.port}/mcp`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}