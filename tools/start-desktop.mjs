/**
 * 一键启动 HomeClaw 桌面客户端。
 *
 * 为什么需要它：桌面端要在 dev 模式下自己拉 HomeHub + Gateway，
 * 而 pnpm/npm 脚本会把 npm_node_execpath 注入进去。直接双击 electron.exe
 * 反而拿不到正确的 node 路径（main.ts 会退回 PATH 里的 node）。
 * 这个脚本把 node 路径显式找出来再启动，失败时把日志摊开给人看，
 * 而不是留一个一闪而过的黑窗口。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(root, "apps", "desktop");
const electronBin = path.join(desktopDir, "node_modules", "electron", "dist", "electron.exe");

const fail = (msg) => {
  console.error("\n[启动失败] " + msg + "\n");
  process.exitCode = 1;
};

const waitPort = (port, ms = 20000) =>
  new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      const s = net.connect({ host: "127.0.0.1", port });
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 300);
      });
    };
    tick();
  });

if (!fs.existsSync(electronBin)) fail(`找不到 Electron：${electronBin}\n先执行 pnpm install`);
// 界面产物缺失就现场构建。用自带的无子进程构建链（node --import ./esbuild-register.mjs），
// 它在任何机器上都能跑，不依赖 pnpm/vite 的 spawn。
const webIndex = path.join(root, "apps", "web", "dist", "index.html");
if (!fs.existsSync(webIndex)) {
  console.log("[准备] 界面产物缺失，正在构建…");
  const r = spawnSync(
    process.execPath,
    ["--import", "./esbuild-register.mjs", "build.mjs"],
    { cwd: path.join(root, "apps", "web"), stdio: "inherit" },
  );
  if (r.status !== 0 || !fs.existsSync(webIndex)) fail("界面构建失败，见上方输出");
}

if (process.exitCode) process.exit();

// Hermes 运行时是可选的：没有它客户端照常启动，只是复杂任务会走内置循环。
// 这里只做"告知"，不阻塞、不自动安装 —— 自动装会在用户不知情时下几十分钟的依赖。
const hermesLauncher = path.join(
  root,
  "hermes-venv",
  process.platform === "win32" ? path.join("Scripts", "hermes.exe") : path.join("bin", "hermes"),
);
if (fs.existsSync(hermesLauncher)) {
  console.log("[提示] 深度规划内核已就绪");
} else {
  console.log("[提示] 未安装深度规划内核：复杂任务将走内置循环。");
  console.log("       需要时执行：powershell -ExecutionPolicy Bypass -File scripts\\setup-hermes.ps1");
}

console.log("[1/3] 启动 HomeHub (:4020) 与 Gateway (:4030)…");
const env = { ...process.env, HOMECLAW_NODE: process.execPath };

// 后端由桌面端自己拉（startSidecars，dev 模式），这里只负责把 node 路径传进去
const child = spawn(electronBin, ["."], {
  cwd: desktopDir,
  env,
  stdio: "inherit",
});

// spawn 失败（例如权限策略拦子进程）时也要说清楚，而不是静默退出
child.on("error", (err) => {
  console.error("\n[启动失败] 无法启动 Electron：" + err.message + "\n");
  process.exitCode = 1;
});

child.on("exit", (code) => {
  console.log(`\n客户端已退出（code=${code}）`);
  process.exitCode = code ?? 0;
});

// 自检：给使用者一个"到底起没起来"的明确信号
void (async () => {
  const hub = await waitPort(4020);
  const gw = await waitPort(4030);
  console.log(`[2/3] HomeHub :4020 ${hub ? "就绪" : "未就绪"}`);
  console.log(`[3/3] Gateway :4030 ${gw ? "就绪" : "未就绪"}`);
  if (!hub || !gw) {
    const logDir = path.join(os.tmpdir(), "homeclaw");
    console.log(`\n后端日志目录：${logDir}`);
    for (const f of ["homehub.log", "gateway.log"]) {
      const p = path.join(logDir, f);
      if (fs.existsSync(p)) {
        console.log(`\n--- ${f} (末尾 30 行) ---`);
        console.log(fs.readFileSync(p, "utf8").split("\n").slice(-30).join("\n"));
      }
    }
  }
})();