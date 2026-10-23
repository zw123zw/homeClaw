import type { McpCallResult, McpTool } from "../mcp-client.ts";
import type { ToolRegistry } from "./index.ts";

/**
 * 把内置工具注册表适配成 MCP 客户端接口。
 *
 * 为什么要适配而不是让 agent.ts 直接调注册表：
 * 自研循环只认「mcp.listTools / mcp.callTool」两个方法（它不知道自己连的是本地还是远端）。
 * 保持这个边界，Hermes 走 HTTP、自研循环走进程内直调，但两边看到的是同一批工具与同一套结果格式。
 *
 * 为什么不走 HTTP 绕一圈：自研循环与工具在同一进程里，绕一圈只会多一次序列化与超时风险；
 * 而 Hermes 是 Python，才必须走协议。
 */
export class LocalToolMcp {
  private readonly registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  async listTools(): Promise<{ tools: McpTool[]; tokens: number }> {
    const tools: McpTool[] = this.registry.describe().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    // tokens 只是给 /v1/_debug 看的估算值：这里没有真实 tokenizer，按字符数/3 粗算
    const tokens = Math.round(JSON.stringify(tools).length / 3);
    return { tools, tokens };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const res = await this.registry.call(name, args);
    return {
      ok: res.ok,
      summary: res.summary,
      ...(res.data !== undefined ? { data: res.data } : {}),
      ...(res.error ? { error: res.error } : {}),
      isError: res.ok === false,
    };
  }

  has(name: string): boolean {
    return this.registry.get(name) !== undefined;
  }
}

/**
 * 多路 MCP：HomeHub ToolHub 与本地内置工具合成一个"工具箱"。
 *
 * 优先级：本地工具名精确命中才走本地，其余一律转发给 HomeHub。
 * 这条规则必须写死 —— 若做成"先问 homehub，报错再问本地"，
 * 一旦 HomeHub 挂了，所有工具调用都会先超时 15s 才落到本地，界面像卡死。
 */
export class MultiMcp {
  private readonly primary: {
    listTools: (o: { sessionId?: string; query?: string }) => Promise<{ tools: McpTool[]; tokens: number }>;
    callTool: (n: string, a: Record<string, unknown>, o?: { traceId?: string }) => Promise<McpCallResult>;
  };
  private readonly local: LocalToolMcp;

  constructor(primary: MultiMcp["primary"], local: LocalToolMcp) {
    this.primary = primary;
    this.local = local;
  }

  async listTools(opts: { sessionId?: string; query?: string } = {}): Promise<{ tools: McpTool[]; tokens: number }> {
    // 本地工具永远可用：它们不依赖 HomeHub，HomeHub 挂了也要能读文档/改文件
    const local = await this.local.listTools();
    try {
      const remote = await this.primary.listTools(opts);
      return { tools: [...remote.tools, ...local.tools], tokens: remote.tokens + local.tokens };
    } catch {
      // 远端不可用只损失设备控制，不损失文件能力；错误在调用时才会暴露给模型
      return local;
    }
  }

  async callTool(name: string, args: Record<string, unknown>, opts: { traceId?: string } = {}): Promise<McpCallResult> {
    if (this.local.has(name)) return this.local.callTool(name, args);
    return this.primary.callTool(name, args, opts);
  }
}