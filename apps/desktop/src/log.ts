import { app } from "electron";
import nodeFs from "node:fs";
import path from "node:path";

/**
 * 主进程日志（§M6「日志落盘 + 轮转」）。
 *
 * 为什么主进程要自己写文件，而不是 console.log：
 *  打包后的应用没有终端，console.log 等于扔进黑洞；
 *  崩溃与"为什么窗口是白的"恰恰是最需要事后回看的场景。
 *
 * 落盘位置：app.getPath("logs")，Windows 上是
 *  %APPDATA%\<appName>\logs\main.log —— 用户能在资源管理器里直接找到，
 *  发问题报告时知道该发哪个文件。
 */

type Level = "debug" | "info" | "warn" | "error";

let stream: nodeFs.WriteStream | null = null;
let ready = false;

/** 延迟到 app ready 之后再开文件：ready 之前 getPath 不可靠 */
function ensureStream(): nodeFs.WriteStream | null {
  if (stream || !ready) return stream;
  try {
    const dir = app.getPath("logs");
    nodeFs.mkdirSync(dir, { recursive: true });
    stream = nodeFs.createWriteStream(path.join(dir, "main.log"), { flags: "a" });
    stream.on("error", () => {
      // 日志写不进去不能让应用崩：降级为 stderr（开发时仍能看到）
      stream = null;
    });
  } catch {
    stream = null;
  }
  return stream;
}

function fmt(level: Level, msg: string, extra?: unknown): string {
  const ts = new Date().toISOString();
  const tail = extra === undefined ? "" : " " + safeJson(extra);
  return ts + " [" + level + "] " + msg + tail + "\n";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function log(level: Level, msg: string, extra?: unknown): void {
  const line = fmt(level, msg, extra);
  if (level === "error") process.stderr.write(line);
  else process.stdout.write(line);
  ensureStream()?.write(line);
}

export const logger = {
  debug: (m: string, e?: unknown) => log("debug", m, e),
  info: (m: string, e?: unknown) => log("info", m, e),
  warn: (m: string, e?: unknown) => log("warn", m, e),
  error: (m: string, e?: unknown) => log("error", m, e),
};

/** 日志目录，供菜单"打开日志目录"使用 */
export function logDir(): string {
  return app.getPath("logs");
}

export function markReady(): void {
  ready = true;
  ensureStream();
}

/**
 * 崩溃与异常兜底：不写这两处捕获，Electron 崩了只会留一个退出码，
 * 用户看到的"应用打不开"就成了一条无从查起的现象。
 */
export function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => {
    logger.error("uncaughtException", { message: err?.message, stack: err?.stack });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", { reason: safeJson(reason) });
  });
}
