/** Gateway 配置：全部来自环境变量，凭证不落代码、不下发客户端（§7.1） */
export type GatewayConfig = {
  host: string;
  port: number;
  hub: {
    baseUrl: string;
    /** MCP 服务票据：只能调工具，不能读写会话 */
    mcpToken: string;
    /** 用户票据：只用于读写会话与读实体（房间词典） */
    userToken: string;
  };
  llm: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  /** 模型注册表持久化文件：API key 只存在这里，不下发客户端 */
  modelsFile: string;
  /** 仓库根：用于解析 hermes-venv / vendor 源码 / 默认工作目录 */
  repoRoot: string;
  /** 文件类工具的沙箱根（相对仓库根） */
  workspaceRoot: string;
  /** 单次 run 的超时：防止一次推理永久占住连接 */
  runTimeoutMs: number;
  /** 调试接口（/v1/_debug/*）开关：默认关，开发与验收显式开 */
  debug: boolean;
};

export function loadGatewayConfig(): GatewayConfig {
  const env = process.env;
  return {
    host: env.GATEWAY_HOST ?? "127.0.0.1",
    port: Number(env.GATEWAY_PORT ?? 4030),
    hub: {
      baseUrl: env.HUB_URL ?? "http://127.0.0.1:4020",
      mcpToken: env.MCP_TOKEN ?? "dev-mcp-token",
      userToken: env.USER_TOKEN ?? "dev-user-token",
    },
    llm: {
      provider: env.LLM_PROVIDER ?? "mock",
      baseUrl: env.LLM_BASE_URL ?? "https://api.deepseek.com/v1",
      apiKey: env.LLM_API_KEY ?? "",
      model: env.LLM_MODEL ?? "deepseek-chat",
    },
    modelsFile: env.GATEWAY_MODELS_FILE ?? "data/gateway-settings.json",
    repoRoot: env.HOMECLAW_ROOT ?? process.cwd(),
    workspaceRoot: env.WORKSPACE_ROOT ?? "data/workspace",
    runTimeoutMs: Number(env.RUN_TIMEOUT_MS ?? 120_000),
    debug: env.HOMECLAW_DEBUG === "1",
  };
}