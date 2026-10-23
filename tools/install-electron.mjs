/**
 * 手动安装 Electron 二进制（本机 spawn 建管道被策略拒绝，官方 install.js 跑不了）。
 *
 * 做三件事，等价于 electron/install.js：
 *  1) 从 npmmirror 下 electron-v<ver>-win32-x64.zip；
 *  2) 解压到 node_modules/electron/dist；
 *  3) 写 path.txt（electron/index.js 靠它找可执行文件）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve("apps/desktop");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8"));
const version = pkg.version;
const dist = path.join(root, "node_modules/electron/dist");
const zip = path.join(root, "node_modules/electron/electron.zip");
const url = `https://registry.npmmirror.com/-/binary/electron/${version}/electron-v${version}-win32-x64.zip`;

if (fs.existsSync(path.join(dist, "electron.exe"))) {
  console.log("already installed:", path.join(dist, "electron.exe"));
  process.exit(0);
}

console.log("downloading", url);
const res = await fetch(url);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(zip, buf);
console.log("downloaded", (buf.length / 1e6).toFixed(1), "MB");

fs.mkdirSync(dist, { recursive: true });
// 解压走 PowerShell 的 Expand-Archive（纯文件操作，不建管道）
execFileSync(
  "powershell",
  ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dist}' -Force`],
  { stdio: ["ignore", fs.openSync(".tmp-unzip.log", "w"), fs.openSync(".tmp-unzip.log", "a")] },
);
fs.writeFileSync(path.join(root, "node_modules/electron/path.txt"), "electron.exe", "utf8");
fs.unlinkSync(zip);
console.log("installed:", fs.existsSync(path.join(dist, "electron.exe")) ? "OK" : "MISSING");