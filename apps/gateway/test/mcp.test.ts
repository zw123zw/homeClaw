import { describe, it, expect } from "./harness.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolRegistry } from "../src/tools/index.ts";
import { startToolMcpServer } from "../src/tools/mcp-server.ts";
import { LocalToolMcp, MultiMcp } from "../src/tools/mcp-adapter.ts";

/**
 * 本地工具 MCP 端口的协议测试。
 *
 * 这是 Hermes 唯一接触内置工具的方式，所以必须验证四件事：
 * 鉴权、方法集、tools/call 的 isError 语义、以及"结果形状能被 MCP 客户端解析"。
 * 一个都不能只靠"看起来对"—— 401 与 isError 出错时的表现都是静默降级，
 * 用户只会看到"模型说它调了工具但其实没调"。
 */
describe("本地工具 MCP 端口", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-mcp-"));
  const registry = createToolRegistry({ workspaceRoot: root });
  const token = "test-token-123";

  it("initialize / tools/list / tools/call 全链路可用", async () => {
    const server = await startToolMcpServer({ registry, token, port: 0 });
    const rpc = async (body: unknown, auth = `Bearer ${token}`) => {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    try {
      const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
      expect(init.body.result).toMatchObject({ serverInfo: { name: "homeclaw-local-tools" } });

      const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = (list.body.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name)).toContain("file_write");
      expect(tools.map((t) => t.name)).toContain("doc_read");

      const call = await rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "file_write", arguments: { path: "note.md", content: "# 你好" } },
      });
      expect(call.body.result).toMatchObject({ isError: false });
      expect(fs.readFileSync(path.join(root, "note.md"), "utf8")).toBe("# 你好");

      // 失败必须以 isError:true 返回，否则模型会把"越界"当成功
      const bad = await rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "file_read", arguments: { path: "../../etc/passwd" } },
      });
      expect(bad.body.result).toMatchObject({ isError: true });

      const unknown = await rpc({ jsonrpc: "2.0", id: 5, method: "nope" });
      expect((unknown.body.error as { code: number }).code).toBe(-32601);
    } finally {
      await server.close();
    }
  });

  it("无票据被拒绝（本机其它程序不能借这个端口读写文件）", async () => {
    const server = await startToolMcpServer({ registry, token, port: 0 });
    try {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("多路工具（本地 + HomeHub）", () => {
  it("工具名命中本地就走本地，其余转发远端", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-multi-"));
    const local = new LocalToolMcp(createToolRegistry({ workspaceRoot: root }));
    const calls: string[] = [];
    const remote = {
      listTools: async () => ({ tools: [{ name: "set_room_light", description: "调灯", inputSchema: {} }], tokens: 10 }),
      callTool: async (name: string) => {
        calls.push(name);
        return { ok: true, summary: "远端已执行", isError: false };
      },
    };
    const box = new MultiMcp(remote, local);

    const { tools } = await box.listTools();
    expect(tools.map((t) => t.name)).toContain("set_room_light");
    expect(tools.map((t) => t.name)).toContain("file_list");

    await box.callTool("file_list", {});
    expect(calls).toHaveLength(0);

    await box.callTool("set_room_light", { room: "客厅", level: 40 });
    expect(calls).toEqual(["set_room_light"]);
  });

  it("HomeHub 不可用时本地工具仍然可用（断网也能读文档）", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-multi2-"));
    const local = new LocalToolMcp(createToolRegistry({ workspaceRoot: root }));
    const remote = {
      listTools: async () => {
        throw new Error("hub down");
      },
      callTool: async () => {
        throw new Error("hub down");
      },
    };
    const box = new MultiMcp(remote, local);
    const { tools } = await box.listTools();
    expect(tools.length).toBeGreaterThan(5);
    const res = await box.callTool("file_list", {});
    expect(res.ok).toBe(true);
  });
});