/**
 * HomeHub 配置（唯一持有设备凭据的进程，C2）。
 * 所有配置从环境变量读取，凭据绝不写入代码或下发给 L1/L2。
 */
export type HubConfig = {
  homeId: string;
  host: string;
  port: number;
  dbPath: string;
  /** MCP 服务票据：AI 用它访问 HomeHub（与客户端票据分离，§5.2） */
  mcpToken: string;
  /** 客户端用户票据：仅能访问面板/场景/会话读，不能触发工具 */
  userToken: string;
  adapter: "mock" | "ha";
  /**
   * mock 适配器的实体档位：
   *  basic = 12 个实体（3 房间 × 4），M0/M1 面板契约按这个断言；
   *  full  = basic + 空调/电视/扫地机/插座，用于验证多设备类推理（M4）。
   */
  mockProfile: "basic" | "full";
  ha: { baseUrl: string; token: string };
  policy: PolicyConfig;
  /** L2 内核：本期为自研薄循环（builtin），driver=hermes 预留给第三方内核 */
  gateway: { baseUrl: string; driver: "hermes" | "builtin"; llmProvider: string };
  logLevel: string;
  /**
   * 调试与模拟接口（/_mock/*、/_debug/*）的开关。
   *
   * 默认关：这些接口能注入传感器事件，生产暴露等于给外部一个伪造触发条件的入口。
   * 开发与验收显式设 HOMECLAW_DEBUG=1。
   */
  debug: boolean;
};

export type PolicyConfig = {
  /** 实体白名单：为空表示允许全部（仅限开发环境） */
  entityWhitelist: string[];
  /** 服务白名单：仅允许这些服务，管理类服务（reload/restart）一律拒绝 */
  serviceWhitelist: string[];
  /** 硬拒绝清单（保险丝，§7.2）：命中即拒，不进模型判断 */
  hardDeny: string[];
  /** 频率上限 */
  rateLimit: { perEntityPerHour: number; perRoomPerHour: number; globalPerHour: number };
  /** 预算上限 */
  budget: { dailyTokens: number; dailyCny: number };
};

export function loadConfig(): HubConfig {
  const env = process.env;
  return {
    homeId: env.HOME_ID ?? "h_demo0001",
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 4020),
    dbPath: env.DB_PATH ?? "data/homehub.db",
    mcpToken: env.MCP_TOKEN ?? "dev-mcp-token",
    userToken: env.USER_TOKEN ?? "dev-user-token",
    adapter: (env.ADAPTER as "mock" | "ha") ?? "mock",
    mockProfile: env.MOCK_PROFILE === "full" ? "full" : "basic",
    ha: {
      baseUrl: env.HA_URL ?? "http://127.0.0.1:8123",
      token: env.HA_TOKEN ?? "",
    },
    policy: {
      entityWhitelist: (env.ENTITY_WHITELIST ?? "").split(",").filter(Boolean),
      serviceWhitelist: (env.SERVICE_WHITELIST ?? "").split(",").filter(Boolean),
      hardDeny: (
        env.HARD_DENY ??
        [
          // 门锁 / 燃气阀 / 总闸：一期一律拒绝，避免提示词失败造成不可逆后果
          "lock.*",
          "valve.gas*",
          "switch.main_breaker*",
        ].join(",")
      ).split(",").filter(Boolean),
      rateLimit: {
        perEntityPerHour: Number(env.RATE_ENTITY_PER_HOUR ?? 60),
        perRoomPerHour: Number(env.RATE_ROOM_PER_HOUR ?? 120),
        globalPerHour: Number(env.RATE_GLOBAL_PER_HOUR ?? 600),
      },
      budget: {
        dailyTokens: Number(env.BUDGET_TOKENS ?? 500_000),
        dailyCny: Number(env.BUDGET_CNY ?? 20),
      },
    },
    gateway: {
      baseUrl: env.GATEWAY_URL ?? "http://127.0.0.1:4030",
      driver: (env.GATEWAY_DRIVER as "hermes" | "builtin") ?? "builtin",
      llmProvider: env.LLM_PROVIDER ?? "mock",
    },
    logLevel: env.LOG_LEVEL ?? "info",
    debug: env.HOMECLAW_DEBUG === "1",
  };
}