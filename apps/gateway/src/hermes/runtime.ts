import fs from "node:fs";
import path from "node:path";

/**
 * Hermes 运行时探测。
 *
 * 只回答一个问题：现在能不能 spawn 一个能跑的 hermes？答案是 ready 或 not_ready，
 * 没有"大概可以"。探测顺序写死在文档（docs/HERMES.md §3），这里逐条实现。
 *
 * 为什么不用 npm 桥 hermes-agent：它没有可 import 的 API，运行时落在 node_modules 里，
 * electron-builder 打包会丢，npm 重装会替换 venv。桌面应用要的是可打包、可离线启动的运行时。
 */
export type RuntimeSource = "env" | "settings" | "repo" | "vendor" | "launcher" | "none";

export type RuntimeInfo = {
  status: "ready" | "not_ready";
  source: RuntimeSource;
  /** 实际要 spawn 的可执行文件；not_ready 时为 null */
  launcher: string | null;
  venvDir: string | null;
  /** 给用户看的一句话，直接展示在设置页与健康检查里 */
  detail: string;
};

export type ResolveOptions = {
  /** 仓库根：用来找 hermes-venv 与 vendor/hermes-agent */
  repoRoot: string;
  /** 设置里的显式目录 */
  runtimeDir?: string;
  /** 设置里的启动器覆盖（可以是任意可执行文件，用于测试/自定义部署） */
  launcher?: string;
  env?: NodeJS.ProcessEnv;
};

function launcherIn(venvDir: string, platform = process.platform): string {
  return platform === "win32"
    ? path.join(venvDir, "Scripts", "hermes.exe")
    : path.join(venvDir, "bin", "hermes");
}

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function resolveRuntime(opts: ResolveOptions): RuntimeInfo {
  const env = opts.env ?? process.env;

  // 1) 显式启动器：给了就当可以用，路径不存在才算失败。
  //    这条给测试和自定义部署用（比如用 node 跑一个 shim），生产不会走。
  if (opts.launcher?.trim()) {
    const p = opts.launcher.trim();
    return exists(p)
      ? { status: "ready", source: "launcher", launcher: p, venvDir: null, detail: `自定义启动器 ${p}` }
      : { status: "not_ready", source: "launcher", launcher: null, venvDir: null, detail: `自定义启动器不存在：${p}` };
  }

  // 2) 环境变量：打包后由 Electron 主进程注入 resources/hermes-venv
  const fromEnv = env.HERMES_VENV?.trim();
  if (fromEnv) {
    const p = launcherIn(fromEnv);
    if (exists(p)) return { status: "ready", source: "env", launcher: p, venvDir: fromEnv, detail: `HERMES_VENV=${fromEnv}` };
  }

  // 3) 设置里的目录
  const fromSettings = opts.runtimeDir?.trim();
  if (fromSettings) {
    const p = launcherIn(fromSettings);
    if (exists(p)) return { status: "ready", source: "settings", launcher: p, venvDir: fromSettings, detail: `设置指定 ${fromSettings}` };
  }

  // 4) 仓库根下的 hermes-venv（开发机默认，scripts/setup-hermes.ps1 生成）
  const repoVenv = path.join(opts.repoRoot, "hermes-venv");
  const repoLauncher = launcherIn(repoVenv);
  if (exists(repoLauncher)) {
    return { status: "ready", source: "repo", launcher: repoLauncher, venvDir: repoVenv, detail: `仓库 ${repoVenv}` };
  }

  // 5) 上游源码里就地装的 .venv（uv venv 后直接 uv pip install -e . 的产物）
  const vendorVenv = path.join(opts.repoRoot, "vendor", "hermes-agent", ".venv");
  const vendorLauncher = launcherIn(vendorVenv);
  if (exists(vendorLauncher)) {
    return { status: "ready", source: "vendor", launcher: vendorLauncher, venvDir: vendorVenv, detail: `源码 ${vendorVenv}` };
  }

  const hint = fromEnv || fromSettings
    ? `已配置 ${fromEnv || fromSettings}，但其中没有 ${path.join("Scripts", "hermes.exe")}`
    : "未找到 hermes-venv；运行 scripts/setup-hermes.ps1 生成，或关闭深度规划";

  return { status: "not_ready", source: "none", launcher: null, venvDir: null, detail: hint };
}

/**
 * HERMES_HOME：配置、skill、会话都落在这里。
 * 放在 data/ 下而不是用户主目录，是为了"删掉仓库即清理干净"，也避免污染 ~/.hermes。
 */
export function hermesHome(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.HERMES_HOME?.trim() || path.join(repoRoot, "data", "hermes");
}
