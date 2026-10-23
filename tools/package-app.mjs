/**
 * 组装一份可双击启动的绿色安装包（不依赖 electron-builder）。
 *
 * 为什么不用 electron-builder：本机离线，装不了它的依赖；而"能跑起来"这件事
 * 不该等打包工具。Electron 本身支持 resources/app 目录形态（未 asar 打包时
 * 直接从磁盘加载），装配出来和安装包的结构一致。
 *
 * 产物结构（release/HomeClaw-win32-x64/）：
 *   HomeClaw.exe                 ← electron.exe 改名
 *   resources/app/               ← 主进程 + preload（apps/desktop/dist）
 *   resources/web/               ← 界面产物（apps/web/dist）
 *   resources/backend/           ← homehub.mjs / gateway.mjs（tools/build-backend.mjs）
 *   resources/node/node.exe      ← 随包 Node，用户机器不需要装
 *   resources/hermes-venv/       ← 可选，存在才拷（平台绑定，见 docs/HERMES.md）
 *
 * 用法：node tools/package-app.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgName = `HomeClaw-${process.platform}-${process.arch}`;
const outDir = path.join(root, "release", pkgName);

const need = (p, hint) => {
  if (!fs.existsSync(p)) {
    console.error(`[失败] 缺少 ${path.relative(root, p)}\n        ${hint}`);
    process.exit(1);
  }
  return p;
};

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 1) 前置产物
const electronDist = need(
  path.join(root, "apps/desktop/node_modules/electron/dist"),
  "先执行 pnpm install（需要 electron 的 dist）",
);
const desktopDist = need(path.join(root, "apps/desktop/dist"), "先执行：pnpm --filter @homeclaw/desktop build");
const webDist = need(path.join(root, "apps/web/dist"), "先构建界面：apps/web 下 node --import ./esbuild-register.mjs build.mjs");
const backendDir = need(path.join(root, "dist-backend"), "先构建后端：node --import ./apps/web/esbuild-register.mjs tools/build-backend.mjs");

// 2) Electron 外壳
fs.rmSync(outDir, { recursive: true, force: true });
copyDir(electronDist, outDir);

const exeName = process.platform === "win32" ? "HomeClaw.exe" : "HomeClaw";
const srcExe = path.join(outDir, process.platform === "win32" ? "electron.exe" : "Electron");
if (fs.existsSync(srcExe)) fs.renameSync(srcExe, path.join(outDir, exeName));
// 默认的 default_app.asar 会让 Electron 起"示例应用"，必须删掉，否则加载的是它而不是我们
fs.rmSync(path.join(outDir, "resources/default_app.asar"), { force: true });

// 3) 应用本体：resources/app（main / preload / log）
const appDir = path.join(outDir, "resources/app");
fs.mkdirSync(appDir, { recursive: true });
for (const f of ["main.js", "preload.js", "log.js"]) {
  fs.copyFileSync(path.join(desktopDist, f), path.join(appDir, f));
}
fs.writeFileSync(
  path.join(appDir, "package.json"),
  JSON.stringify(
    { name: "homeclaw", productName: "HomeClaw", version: "0.1.0", main: "main.js", private: true },
    null,
    2,
  ),
  "utf8",
);

// 4) 界面 / 后端 / node 运行时
copyDir(webDist, path.join(outDir, "resources/web"));
copyDir(backendDir, path.join(outDir, "resources/backend"));

const nodeSrc =
  process.env.HOMECLAW_NODE ??
  (process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:/Program Files", "nodejs/node.exe") : process.execPath);
if (fs.existsSync(nodeSrc)) {
  fs.mkdirSync(path.join(outDir, "resources/node"), { recursive: true });
  fs.copyFileSync(nodeSrc, path.join(outDir, "resources/node", path.basename(nodeSrc)));
  console.log(`[node] 随包 ${nodeSrc}`);
} else {
  // 没有就退化为"用系统 Node"，并在启动日志里说明 —— 不能静默
  console.warn(`[node] 未找到 ${nodeSrc}，安装包将依赖系统 Node`);
}

// 5) Hermes venv（可选，平台绑定）
const venv = path.join(root, "hermes-venv");
if (fs.existsSync(venv)) {
  copyDir(venv, path.join(outDir, "resources/hermes-venv"));
  console.log("[hermes] 已随包 hermes-venv");
} else {
  console.log("[hermes] 无 hermes-venv：安装包只带自研循环（深度规划需另行生成）");
}

// 6) 启动说明
fs.writeFileSync(
  path.join(outDir, "启动说明.txt"),
  [
    "HomeClaw 绿色版",
    "",
    `双击 ${exeName} 启动。`,
    "",
    "首次启动会在 %APPDATA%\\HomeClaw 下建 data 目录（会话库、模型配置、Hermes 工作区都在这里）。",
    "端口：HomeHub 4020 / Gateway 4030 / 内置工具 MCP 4031（被占用时会跳过启动已有实例）。",
    "日志：%APPDATA%\\HomeClaw\\logs\\main.log；后端日志在 %TEMP%\\homeclaw\\ 下。",
    "",
    "深度规划（Hermes）为可选能力：没有 hermes-venv 时复杂任务自动走后置循环，界面不会报错。",
    "",
  ].join(os.EOL),
  "utf8",
);

console.log(`PACKAGED → ${path.relative(root, outDir)}`);
console.log(`启动：${path.join(outDir, exeName)}`);
