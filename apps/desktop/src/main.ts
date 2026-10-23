import { app, BrowserWindow, ipcMain, shell, session, dialog, protocol, Menu } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import net from "node:net";
import fs from "node:fs/promises";
import nodeFs from "node:fs";
import { logger, markReady, installCrashHandlers } from "./log";

/**
 * Electron 主进程只做三件事（§3.1）：窗口、sidecar 拉起、更新。
 * 业务逻辑一律在渲染进程 + HomeHub/Gateway，主进程不参与。
 */

const isDev = !app.isPackaged;

// 固定应用名：日志/用户数据落在 %APPDATA%\HomeClaw 下。
// 不设的话包名 @homeclaw/desktop 会被当成目录名，路径里带 @ 和 /，用户找不着。
app.setName("HomeClaw");

/**
 * userData 必须在拿单实例锁**之前**就定好。
 *
 * Chromium 自己要在 userData 下建 Cache / Network / Local Storage，
 * 目录不可写时它在 ready 之前就直接失败退出（日志只有 process_singleton 的
 * "Lock file can not be created"，界面上完全是"双击没反应"）。
 * 所以这里先探一次可写性，不可写就整体切到便携目录 —— 而不是等崩了再补救。
 */
const userDataOverride = process.env.HOMECLAW_USER_DATA?.trim();
if (userDataOverride) {
  app.setPath("userData", userDataOverride);
} else if (!isWritableDir(app.getPath("userData"))) {
  const portable = path.join(path.dirname(app.getPath("exe")), "HomeClawData");
  if (isWritableDir(portable) || makeWritableDir(portable)) {
    app.setPath("userData", portable);
    // 只有打包态才把数据根也搬过去：dev 的数据根必须是仓库根，
    // 否则调试时看到的库和命令行跑的库不是同一个，排查会绕远路
    if (!isDev) process.env.HOMECLAW_ROOT = process.env.HOMECLAW_ROOT ?? portable;
  }
}

/** 目录能否真的写文件：只判断存在或 ACL 都会误判 */
function isWritableDir(dir: string): boolean {
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(probe, "ok");
    nodeFs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function makeWritableDir(dir: string): boolean {
  try {
    nodeFs.mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }
  return isWritableDir(dir);
}

// 崩溃与未捕获异常落到 userData/logs/main.log，否则"打不开"只剩一个退出码
installCrashHandlers();

// 单实例：双击两次不该出现两个客户端抢同一对端口
if (!app.requestSingleInstanceLock()) {
  // 锁拿不到有两种原因：另一个实例在跑（正常），或 userData 不可写（异常）。
  // 两种都退出，但必须留一行日志 —— 否则"双击图标什么都没发生"完全无从查起。
  logger.warn("[app] 未能获得单实例锁（已有实例在运行，或用户数据目录不可写），本次启动退出");
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/**
 * 界面走自定义 app:// 协议加载，而不是 file://。
 *
 * 为什么不能用 file://：Vite 产物是 <script type="module">，Chromium 对 file:// 下的
 * ES module 一律按跨域处理并拒绝执行 —— 窗口能开、内容却是空白，控制台里只有一条
 * "Access to script at 'file:///...' from origin 'null' has been blocked"。
 * 自定义协议被标成 standard + secure 后，模块脚本、fetch、CSP 才和普通网页一致。
 */
const APP_SCHEME = "app";
const APP_HOST = "homeclaw";

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

/** 端口常量与各服务 src/config.ts 里的默认值保持一致 */
const HUB_PORT = Number(process.env.HUB_PORT ?? 4020);
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 4030);
/**
 * 内置工具 MCP 端口。
 *
 * 不能写死 4031：开发机常常同时开着命令行跑的 Gateway 与桌面端，
 * 两个进程抢同一个端口时后起的那个只丢一条 warn，表现是"Hermes 看不到内置工具"，
 * 而且不一定哪一次能成功。默认跟网关端口相邻，换端口时自动错开。
 */
const TOOL_MCP_PORT = Number(process.env.TOOL_MCP_PORT ?? GATEWAY_PORT + 1);

const sidecars: ChildProcess[] = [];

/**
 * 出网白名单（C5）：客户端只许访问本地网关与中枢。
 * 用 origin 精确匹配而不是通配端口 —— "127.0.0.1 任意端口"等于对本机所有服务开放。
 */
const ALLOWED_ORIGINS = [
  `http://127.0.0.1:${HUB_PORT}`,
  `http://127.0.0.1:${GATEWAY_PORT}`,
  "http://localhost:5310",
];

/**
 * 数据根目录（data/、hermes 工作区、模型配置都在它下面）。
 *
 * dev：仓库根，方便调试时直接看文件；
 * 打包：userData（%APPDATA%\HomeClaw）。安装目录在 Program Files 下是只读的，
 * 往里写 db 会直接 EACCES，而表现是"能打开但什么都点不动"。
 */
function repoRoot(): string {
  // 显式指定优先：便携部署 / 多实例调试 / 将来接盒子都能用同一条开关
  const override = process.env.HOMECLAW_ROOT?.trim();
  if (override) return ensureWritable(override);

  if (isDev) {
    // dev: __dirname = apps/desktop/dist → 上三级
    return path.resolve(__dirname, "../../..");
  }

  // 打包态首选 userData，但**不能假设它可写**：
  // 受限账户、漫游目录被策略锁、便携版放在只读盘上，都会让 mkdir 直接 EPERM。
  // 早先版本在这里抛错，表现就是"双击没反应"（异常发生在 ready 之前，窗口都不出来）。
  try {
    return ensureWritable(app.getPath("userData"));
  } catch (err) {
    const portable = path.join(path.dirname(app.getPath("exe")), "HomeClawData");
    logger.warn(`[data] userData 不可写（${(err as Error).message}），改用便携目录 ${portable}`);
    return ensureWritable(portable);
  }
}

/** 建目录并验证真的能写：只 mkdir 不够，ACL 允许建目录却拒绝建文件的情况是存在的 */
function ensureWritable(dir: string): string {
  const dataDir = path.join(dir, "data");
  nodeFs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, ".write-probe");
  nodeFs.writeFileSync(probe, "ok");
  nodeFs.rmSync(probe, { force: true });
  return dir;
}

/**
 * 随包分发的后端（tools/build-backend.mjs 的产物）。
 *
 * 为什么打包后不再用 `--experimental-strip-types src/*.ts`：
 * 那要求目标机器上的 Node 版本、实验开关、包类型发现顺序全部一致，
 * 任何一项不同就表现为"进程起来了但端口一直不通、日志里没有一行错误"。
 * 单文件 .mjs 只剩标准库 + 内联依赖，行为稳定。
 */
function packagedBackendDir(): string {
  return path.join(process.resourcesPath, "backend");
}

/** 打包态的 node 运行时：随包带一个，不要求用户自己装 Node */
function packagedNodeBin(): string | null {
  const p = path.join(process.resourcesPath, "node", process.platform === "win32" ? "node.exe" : "node");
  try {
    return nodeFs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#070A12",
    show: false,
    // 隐藏系统标题栏，改用窗口控件覆盖层：只留右上角三个按钮，
    // 其余顶部空间交给应用自己的那一条（可拖动、显示状态）。
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0A0F1A",
      symbolColor: "#8B99B0",
      height: 48,
    },
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // ready-to-show 只在首帧渲染完成后触发；页面若加载失败它永远不来，窗口就一直隐身。
  // 所以这里再挂一个兜底：无论如何 3 秒后把窗口亮出来，让人至少看到报错页。
  win.once("ready-to-show", () => win.show());
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 3000);

  // UI 层禁止导航到外部 URL
  win.webContents.on("will-navigate", (event, url) => {
    let origin = "";
    try {
      origin = new URL(url).origin;
    } catch {
      event.preventDefault();
      return;
    }
    if (origin === `${APP_SCHEME}://${APP_HOST}`) return;
    if (!ALLOWED_ORIGINS.includes(origin)) event.preventDefault();
  });

  // 新窗口一律交给系统浏览器，不在应用内开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // 所有权限请求默认拒绝
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));

  // 加载失败要留下可读的痕迹：白屏 + 无从查起是最差的结果。
  // 用 flag 防止报错页自己加载失败时无限递归。
  let showedFailure = false;
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (showedFailure) return;
    showedFailure = true;
    logger.error(`[window] 加载失败 ${code} ${desc} ${url}`);
    const hint = path.join(app.getPath("logs"), "main.log");
    void win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<body style="font:14px/1.7 system-ui;padding:40px;background:#0f1115;color:#e6e8ee">
             <h2 style="margin:0 0 12px">界面加载失败</h2>
             <p>${desc} (${code})</p>
             <p>URL: <code>${url}</code></p>
             <p>日志：<code>${hint}</code></p>
           </body>`,
        ),
    );
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    logger.error("[window] 渲染进程退出", { reason: details.reason, exitCode: details.exitCode });
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void win.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  }

  return win;
}

/**
 * 开发期拉起 HomeHub 与 Gateway。
 *
 * 注意：这两个进程是本机策略下唯一能起的子进程形态 ——
 * 必须用 stdio: "ignore" 或文件重定向，不能建管道（本机拒绝 pipe，见 tools/README 说明）。
 * 所以日志落到 temp 目录，而不是继承到窗口的终端。
 */
/**
 * 端口已经有服务在听，就不要再拉一份。
 *
 * 为什么不用"先起再撞 EADDRINUSE"：两个进程抢同一个端口时，
 * 后起的那个会在日志里刷一堆错误然后退出，而界面上看到的现象是
 * "有时能用有时不能用"——排查成本极高。先探一下端口最省事。
 */
function portInUse(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function startSidecars(): Promise<void> {
  // 打包态不再 return：安装包要能自己把后端拉起来，否则"双击图标 → 界面全红"。
  // 两种形态的差别只在"跑什么文件、用哪个 node"，其余流程完全一致。
  // 已经有外部服务在跑（开发时手动起的、或连的是另一台盒子的服务）就不要再拉一份 ——
  // 两个进程抢同一个端口只会在日志里刷 EADDRINUSE，对使用者毫无帮助
  if (process.env.HOMECLAW_NO_SIDECAR === "1") {
    logger.info("[sidecar] skipped (HOMECLAW_NO_SIDECAR=1)");
    return;
  }

  const root = repoRoot();
  const logDir = path.join(app.getPath("temp"), "homeclaw");
  void fs.mkdir(logDir, { recursive: true });

  const hubLog = path.join(logDir, "homehub.log");
  const gwLog = path.join(logDir, "gateway.log");
  const hermesVenv = resolveHermesVenv(root);

  /**
   * 必须用真正的 node，不能用 process.execPath。
   *
   * process.execPath 在 Electron 里指向 electron.exe 本身：拿它去跑 server.ts，
   * 等于把后端起成第二个 Electron 实例 —— 表现就是桌面上突然弹出"应用程序错误"，
   * 而 HomeHub/Gateway 一个都没起来，界面全红。
   * 优先级：显式环境变量 -> 包管理器注入的 node 路径 -> PATH 里的 node。
   */
  const nodeBin =
    process.env.HOMECLAW_NODE ??
    process.env.npm_node_execpath ??
    packagedNodeBin() ??
    (process.platform === "win32" ? "node.exe" : "node");

  /**
   * 打包态跑单文件 .mjs，dev 跑源码 .ts。
   * 两者的参数也不同：.mjs 只需要 --experimental-sqlite（node:sqlite 仍是实验特性），
   * .ts 才需要 --experimental-strip-types。
   */
  const isBundle = !isDev;
  const backendDir = packagedBackendDir();
  const entryOf = (name: string) =>
    isBundle ? path.join(backendDir, `${name}.mjs`) : path.join(root, `apps/${name}/src/server.ts`);

  const spawnNode = (entry: string, env: Record<string, string>, logFile: string) => {
    if (!nodeFs.existsSync(entry)) {
      // 缺产物时说清楚缺哪个文件，而不是让子进程 3 秒后无声退出
      logger.error(`[sidecar] 找不到后端入口：${entry}`);
      return null;
    }
    const out = nodeFs.openSync(logFile, "a");
    const flags = isBundle
      ? ["--experimental-sqlite", "--no-warnings", entry]
      : ["--experimental-strip-types", "--experimental-sqlite", entry];
    logger.info(`[sidecar] 启动 ${path.basename(entry)}（node=${nodeBin}）`);
    const child = spawn(nodeBin, flags, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    // spawn 失败是异步的（EPERM / ENOENT / 权限策略），必须记到 main.log：
    // 只写进子进程日志文件的话，这里根本不会有那个文件，用户看不到任何线索。
    child.on("error", (err) => logger.error(`[sidecar] ${path.basename(entry)} 启动失败：${err.message}`));
    child.on("exit", (code) => logger.info(`[sidecar] ${path.basename(entry)} exited: ${code}`));
    sidecars.push(child);
    return child;
  };

  if (await portInUse(HUB_PORT)) {
    logger.info(`[sidecar] HomeHub 已在 :${HUB_PORT} 监听，跳过启动`);
  } else {
    spawnNode(
      entryOf("homehub"),
      {
        PORT: String(HUB_PORT),
        DB_PATH: "data/desktop.db",
        DEBOUNCE_MS: "600",
        ...(isBundle ? { HOMECLAW_STANDALONE: "1" } : {}),
      },
      hubLog,
    );
  }

  if (await portInUse(GATEWAY_PORT)) {
    logger.info(`[sidecar] Gateway 已在 :${GATEWAY_PORT} 监听，跳过启动`);
    return;
  }

  // Gateway 依赖 HomeHub 就绪；等到端口能连上再起，而不是睡一个魔法数字
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(await portInUse(HUB_PORT, 200))) {
    await new Promise((r) => setTimeout(r, 300));
  }
  spawnNode(
    entryOf("gateway"),
    {
      GATEWAY_PORT: String(GATEWAY_PORT),
      HUB_URL: `http://127.0.0.1:${HUB_PORT}`,
      // 仓库根与沙箱根显式传：子进程 cwd 虽已是 root，但用户可能从别处启动
      HOMECLAW_ROOT: root,
      ...(isBundle ? { HOMECLAW_STANDALONE: "1" } : {}),
      TOOL_MCP_PORT: String(TOOL_MCP_PORT),
      ...(hermesVenv ? { HERMES_VENV: hermesVenv } : {}),
    },
    gwLog,
  );
}

/**
 * Hermes 运行时目录（可选）。
 *
 * 有就用，没有也不报错 —— 深度规划是增强能力，缺了应该退回自研循环，
 * 而不是让整个客户端起不来。安装脚本：scripts/setup-hermes.ps1。
 * 打包后走 resources/hermes-venv（electron-builder extraResources）。
 */
function resolveHermesVenv(root: string): string | null {
  const candidates = [
    process.env.HERMES_VENV,
    process.resourcesPath ? path.join(process.resourcesPath, "hermes-venv") : "",
    path.join(root, "hermes-venv"),
  ].filter((p): p is string => Boolean(p));

  const launcher = process.platform === "win32" ? path.join("Scripts", "hermes.exe") : path.join("bin", "hermes");
  for (const dir of candidates) {
    try {
      if (nodeFs.statSync(path.join(dir, launcher)).isFile()) {
        logger.info("[hermes] 运行时目录 " + dir);
        return dir;
      }
    } catch {
      // 不存在就继续找下一个候选，这是正常的"未安装"状态
    }
  }
  logger.info("[hermes] 未找到运行时，深度规划将回落到自研循环");
  return null;
}

/**
 * 把 app://homeclaw/<path> 映射到 apps/web/dist 下的文件。
 * 这是渲染进程唯一的资源来源：路径越界一律拒绝，未命中的路径回落到 index.html（单页应用）。
 */
function registerAppProtocol(): void {
  // dev: dist → ../../web/dist；打包: resources/web（electron-builder extraResources）
  const webRoot = isDev ? path.resolve(__dirname, "../../web/dist") : path.join(process.resourcesPath, "web");
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
  };

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname);
    const file = path.join(webRoot, path.normalize(rel).replace(/^([/\\])+/, ""));
    // 只允许读 webRoot 内的文件
    if (!file.startsWith(webRoot)) return new Response("forbidden", { status: 403 });

    const contentType = MIME[path.extname(file)] ?? "application/octet-stream";
    try {
      const buf = await nodeFs.promises.readFile(file);
      return new Response(buf, { headers: { "content-type": contentType } });
    } catch {
      const html = await nodeFs.promises.readFile(path.join(webRoot, "index.html"));
      return new Response(html, { headers: { "content-type": MIME[".html"]! } });
    }
  });
}

app.whenReady().then(() => {
  // 原生菜单栏（File / Edit / View / Window / Help）在中文界面上毫无用处，
  // 还占掉一行高度、把整体观感拉回 2010 年。界面自带导航与设置，这里直接移除。
  Menu.setApplicationMenu(null);

  registerAppProtocol();
  markReady();
  // 用 .catch 收住：startSidecars 里任何一步失败（目录不可写、spawn 被策略拦）
  // 都不该让整个应用静默退出，而且必须留下可读的原因
  void startSidecars().catch((err: unknown) => {
    logger.error("[sidecar] 启动过程异常", { message: err instanceof Error ? err.message : String(err) });
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const c of sidecars) c.kill();
  if (process.platform !== "darwin") app.quit();
});

/** 设置面板里的"打开日志目录"：只暴露这一个目录，不给任意路径 */
ipcMain.handle("homeclaw:openLogs", async () => {
  const dir = path.join(app.getPath("logs"));
  await fs.mkdir(dir, { recursive: true });
  return shell.openPath(dir);
});

/** 主题切换时同步原生窗口控件颜色，否则浅色主题下右上角仍是深色底 */
ipcMain.handle("homeclaw:window-theme", (event, theme: { background?: string; symbol?: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  if (!/^#[0-9a-f]{6}$/i.test(theme?.background ?? "") || !/^#[0-9a-f]{6}$/i.test(theme?.symbol ?? "")) return false;
  try {
    win.setTitleBarOverlay({ color: theme.background!, symbolColor: theme.symbol!, height: 48 });
  } catch {
    // 平台不支持覆盖层时忽略
  }
  try {
    win.setBackgroundColor(theme.background!);
  } catch {
    // 同上
  }
  return true;
});

/** 预加载脚本同步取运行时配置（渲染进程不读 env，也不碰文件系统） */
ipcMain.on("homeclaw:runtime-config", (event) => {
  event.returnValue = {
    gatewayBaseUrl: `http://127.0.0.1:${GATEWAY_PORT}`,
    hubBaseUrl: `http://127.0.0.1:${HUB_PORT}/v1`,
    hubToken: process.env.HUB_TOKEN ?? "dev-user-token",
  };
});

/** 导出审计/日志：走主进程的保存对话框，渲染进程不接触文件系统 */
ipcMain.handle("homeclaw:saveText", async (_e, filename: string, content: string) => {
  const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: filename });
  if (canceled || !filePath) return false;
  await fs.writeFile(filePath, content, "utf8");
  return true;
});

ipcMain.handle("homeclaw:openExternal", async (_e, url: string) => {
  if (!/^https?:\/\//.test(url)) throw new Error("仅允许 http/https 外链");
  await shell.openExternal(url);
});



