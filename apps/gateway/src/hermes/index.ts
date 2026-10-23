import path from "node:path";
import { HermesSettingsStore, type HermesSettings, type McpServerConfig } from "./settings.ts";
import { resolveRuntime, hermesHome, type RuntimeInfo } from "./runtime.ts";
import { writeConfig, ensureWorkspace } from "./config.ts";
import { runHermes, type HermesRunContext, type SpawnLike } from "./runner.ts";
import { listSkills, type SkillInfo } from "./skills.ts";
import type { RunEvent } from "../agent.ts";
import type { ModelProfile } from "../models.ts";

/**
 * Hermes 服务门面：探测 + 配置 + 运行。
 *
 * 为什么收在一个类里而不是散着调：这三件事共享同一个前提（venv 在哪、HERMES_HOME 在哪），
 * 分散写会出现"设置改了但探测还用旧值"这种只在特定顺序下才复现的坑。
 * 每次 run 前都重新探测一次运行时（成本是一次 statSync），保证删掉 venv 立刻能感知到。
 */
export class HermesService {
  private readonly repoRoot: string;
  private readonly store: HermesSettingsStore;
  /** 本地内置工具 MCP 的地址：由 server 注册后回填 */
  private localMcpUrl: string | null = null;
  private lastEnvError: string | null = null;
  /** 仅测试用：替换子进程创建，让解析/降级分支可在没有 Python 的机器上验证 */
  private readonly spawnFn: SpawnLike | undefined;

  constructor(opts: { repoRoot: string; settings?: HermesSettingsStore; spawnFn?: SpawnLike }) {
    this.repoRoot = path.resolve(opts.repoRoot);
    this.store = opts.settings ?? new HermesSettingsStore();
    this.spawnFn = opts.spawnFn;
  }

  get settings(): HermesSettings {
    return this.store.get();
  }

  updateSettings(patch: Partial<HermesSettings>): HermesSettings {
    return this.store.update(patch);
  }

  /** 启动时由 server 调用：把 HomeHub 与本地工具注册进 MCP 列表 */
  bootstrap(opts: { homeHubUrl: string; homeHubToken: string; localMcpUrl?: string; localMcpToken?: string }) {
    this.localMcpUrl = opts.localMcpUrl ?? null;
    this.store.ensureBuiltin({
      name: "homehub",
      url: opts.homeHubUrl.replace(/\/$/, "") + "/mcp",
      token: opts.homeHubToken,
      enabled: true,
      builtin: true,
    });
    if (this.localMcpUrl) {
      // 票据每进程随机：内置条目的 token 必须跟着刷新，否则重开客户端后 Hermes 会 401
      this.store.upsertBuiltin({
        name: "homeclaw-tools",
        url: this.localMcpUrl,
        ...(opts.localMcpToken ? { token: opts.localMcpToken } : {}),
        enabled: true,
        builtin: true,
      });
    }
  }

  probe(): RuntimeInfo {
    const s = this.settings;
    if (!s.enabled) {
      return { status: "not_ready", source: "none", launcher: null, venvDir: null, detail: "已在设置中关闭深度规划" };
    }
    return resolveRuntime({ repoRoot: this.repoRoot, runtimeDir: s.runtimeDir, launcher: s.launcher });
  }

  home(): string {
    return hermesHome(this.repoRoot);
  }

  skills(): SkillInfo[] {
    return listSkills(this.home());
  }

  status() {
    const rt = this.probe();
    const s = this.settings;
    return {
      enabled: s.enabled,
      status: rt.status,
      source: rt.source,
      detail: rt.detail,
      venv_dir: rt.venvDir,
      launcher: rt.launcher,
      home: this.home(),
      protocol: s.protocol,
      timeout_ms: s.timeoutMs,
      workspace: path.resolve(this.repoRoot, s.workspaceRoot),
      allow_shell: s.allowShell,
      mcp_servers: s.mcpServers.map((m) => ({ name: m.name, url: m.url, enabled: m.enabled, builtin: m.builtin === true })),
      skills: this.skills().map((k) => ({ name: k.name, description: k.description })),
      last_error: this.lastEnvError,
    };
  }

  /** 把当前模型写进 HERMES_HOME/config.yaml；返回是否真的改了文件 */
  syncConfig(model: ModelProfile | undefined): { file: string; workspace: string; changed: boolean } {
    const s = this.settings;
    const workspace = ensureWorkspace(this.repoRoot, s.workspaceRoot);
    const servers: McpServerConfig[] = [...s.mcpServers];
    const { file, changed } = writeConfig({
      homeDir: this.home(),
      workspaceRoot: workspace,
      allowShell: s.allowShell,
      ...(model && model.apiKey && model.baseUrl && model.model
        ? {
            model: {
              provider: providerOf(model.baseUrl),
              baseUrl: model.baseUrl,
              apiKey: model.apiKey,
              model: model.model,
              ...(model.wireApi ? { wireApi: model.wireApi } : {}),
              ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
              ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
            },
          }
        : {}),
      servers,
    });
    return { file, workspace, changed };
  }

  /**
   * 跑一次。调用方负责在失败时回落自研循环 —— 这里不自己兜底，
   * 否则"到底走的是哪条路"在日志和审计里就查不清了。
   */
  async run(opts: {
    prompt: string;
    model?: ModelProfile;
    signal: AbortSignal;
    emit: (e: RunEvent) => void;
    /** 失败只回结果不抛 error（调用方会降级重跑，避免界面出现"报错 + 答案"） */
    suppressError?: boolean;
  }): Promise<{ ok: boolean; reason?: string }> {
    const rt = this.probe();
    if (rt.status !== "ready" || !rt.launcher) {
      return { ok: false, reason: rt.detail };
    }

    let workspace: string;
    let home: string;
    try {
      const synced = this.syncConfig(opts.model);
      workspace = synced.workspace;
      home = this.home();
      this.lastEnvError = null;
    } catch (err) {
      this.lastEnvError = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: this.lastEnvError };
    }

    const s = this.settings;
    const ctx: HermesRunContext = {
      launcher: rt.launcher,
      args: expandArgs(s.args, opts.prompt),
      prompt: opts.prompt,
      protocol: s.protocol,
      cwd: workspace,
      env: {
        HERMES_HOME: home,
        HOME: process.env.HOME ?? home,
        USERPROFILE: process.env.USERPROFILE ?? home,
        // 上游若读这些变量，行为与我们的模型配置保持一致
        HERMES_MODEL: opts.model?.model ?? "",
        HERMES_BASE_URL: opts.model?.baseUrl ?? "",
        HERMES_API_KEY: opts.model?.apiKey ?? "",
      },
      timeoutMs: s.timeoutMs,
      signal: opts.signal,
      emit: opts.emit,
      ...(opts.suppressError ? { suppressError: true } : {}),
      ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
    };

    const result = await runHermes(ctx);
    return { ok: result.ok, ...(result.ok ? {} : { reason: result.stderr ? "Hermes 运行失败" : "Hermes 未产出结果" }) };
  }

  /** 设置页的"测试连接"：跑一次极短提示，验证 runtime 真能起来 */
  async probeRun(): Promise<{ ok: boolean; message: string; elapsed_ms: number }> {
    const rt = this.probe();
    if (rt.status !== "ready" || !rt.launcher) {
      return { ok: false, message: rt.detail, elapsed_ms: 0 };
    }
    const started = Date.now();
    let text = "";
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(this.settings.timeoutMs, 60_000));
    try {
      const res = await this.run({
        prompt: "只回复 OK 两个字母。",
        signal: ac.signal,
        emit: (e) => {
          if (e.type === "delta") text += e.text;
        },
      });
      return {
        ok: res.ok,
        message: res.ok ? `已连通${text ? `：${text.slice(0, 40)}` : ""}` : (res.reason ?? "运行失败"),
        elapsed_ms: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 参数模板：只有 {prompt} 占位符被替换，其他原样传（上游参数照抄即可） */
function expandArgs(template: string[], prompt: string): string[] {
  return template.map((a) => a.replace(/\{prompt\}/g, prompt));
}

/** 从 baseUrl 推断 provider 标识；推断不出来就给 openai-compatible */
function providerOf(baseUrl: string): string {
  const u = baseUrl.toLowerCase();
  if (u.includes("anthropic")) return "anthropic";
  if (u.includes("deepseek")) return "deepseek";
  if (u.includes("moonshot")) return "moonshot";
  if (u.includes("dashscope") || u.includes("aliyun")) return "dashscope";
  if (u.includes("openai")) return "openai";
  return "openai-compatible";
}
