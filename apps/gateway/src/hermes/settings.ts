import fs from "node:fs";
import path from "node:path";

/**
 * Hermes 接入设置（L2 自己的配置，和模型配置分开存）。
 *
 * 为什么不塞进 gateway-settings.json：模型配置是"用户几乎天天改"的东西，
 * 这里是"装一次基本不动"的运行时参数。混在一起，改模型时误伤运行时路径的概率很高。
 *
 * 所有字段都有默认值：读不到文件、字段缺失、类型不对，都退回默认，
 * 绝不让一个坏字段把整条对话链路打挂。
 */
export type McpServerConfig = {
  name: string;
  url: string;
  token?: string;
  enabled: boolean;
  /** 内置的 HomeHub ToolHub：允许禁用，但不允许删除 */
  builtin?: boolean;
};

export type HermesSettings = {
  /** 总开关：关掉就完全不 spawn 子进程，全走自研循环 */
  enabled: boolean;
  /** 显式指定 venv 目录；空则按 环境变量 → 仓库 → vendor 顺序探测 */
  runtimeDir: string;
  /** 启动器覆盖：留空用 venv 里的 hermes；测试时可指向 node + 脚本 */
  launcher: string;
  /** 参数模板，支持 {prompt}；不含占位符时 prompt 走 stdin */
  args: string[];
  /** ndjson：逐行 JSON 事件；text：纯文本整体切片 */
  protocol: "ndjson" | "text";
  /** 单次 run 上限 */
  timeoutMs: number;
  /** 文件类工具的沙箱根目录，所有路径必须落在其内 */
  workspaceRoot: string;
  /** 允许 shell / 任意文件（默认关，开了也只作用于 workspaceRoot） */
  allowShell: boolean;
  /** MCP 服务器列表 */
  mcpServers: McpServerConfig[];
};

export const DEFAULT_SETTINGS: HermesSettings = {
  enabled: true,
  runtimeDir: "",
  launcher: "",
  args: ["run", "{prompt}"],
  protocol: "ndjson",
  timeoutMs: 180_000,
  workspaceRoot: "data/workspace",
  allowShell: false,
  mcpServers: [],
};

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function servers(v: unknown, fallback: McpServerConfig[]): McpServerConfig[] {
  if (!Array.isArray(v)) return fallback;
  const out: McpServerConfig[] = [];
  for (const raw of v) {
    const m = raw as Record<string, unknown>;
    if (!m || typeof m.name !== "string" || typeof m.url !== "string") continue;
    out.push({
      name: m.name,
      url: m.url,
      ...(typeof m.token === "string" && m.token ? { token: m.token } : {}),
      enabled: bool(m.enabled, true),
      ...(m.builtin === true ? { builtin: true } : {}),
    });
  }
  return out;
}

/**
 * 下发给客户端的形状：票据打码。
 *
 * 和模型配置同一条规矩 —— apiKey / token 只留在服务端进程内存与磁盘上，
 * 任何 GET 都不回传明文。客户端只需要知道"这条有没有配票据"。
 */
export type PublicMcpServer = Omit<McpServerConfig, "token"> & { has_token: boolean };

export type PublicHermesSettings = Omit<HermesSettings, "mcpServers"> & { mcpServers: PublicMcpServer[] };

export function toPublicSettings(s: HermesSettings): PublicHermesSettings {
  return {
    ...s,
    mcpServers: s.mcpServers.map(({ token, ...rest }) => ({ ...rest, has_token: Boolean(token) })),
  };
}

export class HermesSettingsStore {
  private readonly file: string;
  private state: HermesSettings;

  constructor(opts: { file?: string } = {}) {
    this.file = opts.file ?? path.resolve("data/hermes-settings.json");
    this.state = this.load();
  }

  private load(): HermesSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      const d = DEFAULT_SETTINGS;
      return {
        enabled: bool(raw.enabled, d.enabled),
        runtimeDir: str(raw.runtimeDir, d.runtimeDir),
        launcher: str(raw.launcher, d.launcher),
        args: Array.isArray(raw.args) && raw.args.every((x) => typeof x === "string")
          ? (raw.args as string[])
          : d.args,
        protocol: raw.protocol === "text" ? "text" : "ndjson",
        timeoutMs: num(raw.timeoutMs, d.timeoutMs),
        workspaceRoot: str(raw.workspaceRoot, d.workspaceRoot) || d.workspaceRoot,
        allowShell: bool(raw.allowShell, d.allowShell),
        mcpServers: servers(raw.mcpServers, d.mcpServers),
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  get(): HermesSettings {
    return this.state;
  }

  /**
   * 合并客户端提交的 MCP 列表。
   *
   * 客户端拿到的列表里没有 token（见 toPublicSettings），所以它回传时必然缺 token。
   * 直接整体替换会把已配好的票据抹掉 —— 表现是"改了个开关，结果连接全 401"。
   * 这里按名字把旧 token 补回去：客户端能改的只有地址、开关与新增项。
   */
  private mergeServers(next: McpServerConfig[]): McpServerConfig[] {
    return next.map((s) => {
      if (s.token) return s;
      const prev = this.state.mcpServers.find((p) => p.name === s.name);
      return prev?.token ? { ...s, token: prev.token } : s;
    });
  }

  /** 部分更新：只改传进来的键，其余保持 */
  update(patch: Partial<HermesSettings>): HermesSettings {
    const cur = this.state;
    const d = DEFAULT_SETTINGS;
    this.state = {
      enabled: bool(patch.enabled, cur.enabled),
      runtimeDir: str(patch.runtimeDir, cur.runtimeDir),
      launcher: str(patch.launcher, cur.launcher),
      args: Array.isArray(patch.args) && patch.args.every((x) => typeof x === "string") ? patch.args : cur.args,
      protocol: patch.protocol === "text" ? "text" : patch.protocol === "ndjson" ? "ndjson" : cur.protocol,
      timeoutMs: num(patch.timeoutMs, cur.timeoutMs),
      workspaceRoot: str(patch.workspaceRoot, cur.workspaceRoot) || d.workspaceRoot,
      allowShell: bool(patch.allowShell, cur.allowShell),
      mcpServers: patch.mcpServers ? this.mergeServers(servers(patch.mcpServers, cur.mcpServers)) : cur.mcpServers,
    };
    this.persist();
    return this.state;
  }

  /** 内置服务器由启动流程补齐，不覆盖用户自加的条目 */
  ensureBuiltin(server: McpServerConfig): void {
    const found = this.state.mcpServers.find((s) => s.name === server.name);
    if (found) return;
    this.state.mcpServers = [{ ...server, builtin: true }, ...this.state.mcpServers];
    this.persist();
  }

  /**
   * 内置服务器：地址与票据以进程内的实际值为准（覆盖写）。
   *
   * 和 ensureBuiltin 的区别就在"覆盖"：本地工具端口的票据每次启动都变，
   * 沿用旧值会让 Hermes 一直 401，而用户从报错里看不出是票据过期。
   * 用户可改的只有 enabled。
   */
  upsertBuiltin(server: McpServerConfig): void {
    const rest = this.state.mcpServers.filter((s) => s.name !== server.name);
    const prev = this.state.mcpServers.find((s) => s.name === server.name);
    this.state.mcpServers = [
      { ...server, builtin: true, enabled: prev?.enabled ?? server.enabled },
      ...rest,
    ];
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf8");
  }
}
