import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { RunEvent } from "../agent.ts";
import { translateLine, applyTranslated } from "./events.ts";

/**
 * 跑一次 Hermes。
 *
 * 三条硬要求，每一条都对应一个线上会出的事故：
 *  1. **不能阻塞消息处理** — 首次启动可能很慢，所以这里有总超时，超时就 kill 并回落；
 *  2. **输出必须翻译成现有 RunEvent** — 否则客户端工具卡/流式渲染会分裂成两套；
 *  3. **取消必须杀进程树** — Windows 上只 kill 父进程，python 子进程会留下来继续烧 token。
 *
 * 解析策略是"逐行尽力"：合法 JSON 行按事件处理，非法行当纯文本 delta。
 * 上游 CLI 的输出格式一旦变化，最坏结果是退化成纯文本，而不是整条链路报错。
 */

export type HermesRunContext = {
  /** 启动器绝对路径 */
  launcher: string;
  /** 参数模板（已展开 {prompt}）；为空表示 prompt 走 stdin */
  args: string[];
  /** 用户输入 */
  prompt: string;
  /** ndjson：逐行 JSON；text：纯文本 */
  protocol: "ndjson" | "text";
  /** 工作目录（沙箱根），子进程只能在这里活动 */
  cwd: string;
  /** 环境变量（含 HERMES_HOME） */
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  emit: (e: RunEvent) => void;
  /**
   * 失败时不发 error 事件，只把结果交回调用方。
   *
   * 用途：这条路径已经是"可降级"的（调用方会回落到自研循环）。
   * 先发 error 再补一段正常答复，界面上会同时出现报错与答案，
   * 用户会以为"出错了但好像又成了"。降级成功时不该留下任何错误痕迹。
   */
  suppressError?: boolean;
  /**
   * 进程创建函数（默认 node 的 spawn）。
   *
   * 可注入的唯一理由是可测：解析管线（分包、末行、退出码、超时、取消）
   * 是本文件最复杂的部分，而它只有在子进程真的吐数据时才会跑起来。
   * 注入之后可以用一个假的 child 把每条分支都跑一遍，不必在一台装了 Python 的机器上祈祷。
   */
  spawnFn?: SpawnLike;
};

/** 只依赖 spawn 的返回值形状，不依赖 ChildProcess 的具体实现 */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"]; windowsHide: boolean; detached: boolean },
) => ChildProcessWithoutNullStreams;

const MAX_TEXT_FALLBACK = 40_000;

/** 按句切片：与自研循环同一套语义，客户端看起来只有一种流 */
function* chunkBySentence(text: string): Generator<string> {
  const parts = text.split(/(?<=[。！？；\n])/);
  for (const p of parts) if (p) yield p;
}

type RunnerResult = { ok: boolean; code: number | null; stderr: string; stdoutSeen: boolean };

export async function runHermes(ctx: HermesRunContext): Promise<RunnerResult> {
  let seq = 0;
  let stdoutSeen = false;
  let stderr = "";
  let emittedDone = false;
  let rawBuffer = "";

  const sendDelta = (text: string) => {
    for (const chunk of chunkBySentence(text)) {
      if (ctx.signal.aborted) return;
      ctx.emit({ type: "delta", text: chunk, seq: ++seq });
    }
  };

  const done = () => {
    if (emittedDone) return;
    emittedDone = true;
    ctx.emit({ type: "done" });
  };

  /**
   * spawn 本身可能同步抛错（路径不可执行、权限策略拦截、EPERM）。
   * 必须在这里收住：抛出去会变成一条 INTERNAL 错误，用户看到"出错了"，
   * 而正确处理是"这条路径不可用，回落自研循环"。
   */
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnHermes(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!ctx.suppressError) {
      ctx.emit({ type: "error", code: "UPSTREAM_ERROR", message: `无法启动 Hermes：${message}`, retryable: true });
    }
    return { ok: false, code: null, stderr: message, stdoutSeen: false };
  }

  const startedAt = Date.now();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, ctx.timeoutMs);

  const onAbort = () => killTree(child);
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const handleLine = (line: string) => {
    const t = line.trim();
    if (!t) return;
    stdoutSeen = true;

    if (ctx.protocol === "text") {
      // 纯文本模式：整体保留，退出时切片下发，避免半个 JSON 被当句子
      if (rawBuffer.length < MAX_TEXT_FALLBACK) rawBuffer += t + "\n";
      return;
    }

    // 翻译逻辑抽到 events.ts：同一套映射被这里和单测共用，避免"测过的和跑起来的不一致"
    applyTranslated(translateLine(t, ctx.protocol), ctx.emit, sendDelta, done);
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let carry = "";
  child.stdout.on("data", (buf: string) => {
    carry += buf;
    let idx: number;
    while ((idx = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, idx);
      carry = carry.slice(idx + 1);
      handleLine(line);
    }
  });

  child.stderr.on("data", (buf: string) => {
    // stderr 只留最后 4KB：够排障，又不会把内存吃满
    stderr = (stderr + buf).slice(-4096);
  });

  const code = await new Promise<number | null>((resolve) => {
    child.once("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      resolve(null);
    });
    child.once("close", (c) => resolve(c));
  });

  clearTimeout(timer);
  ctx.signal.removeEventListener("abort", onAbort);

  // 收尾：缓冲区里剩下的最后一行（没有换行符）也要处理
  if (carry.trim()) handleLine(carry);

  if (ctx.protocol === "text" && rawBuffer.trim()) {
    sendDelta(rawBuffer.trim());
    stdoutSeen = true;
  }

  if (ctx.signal.aborted) {
    // 取消：客户端已经收到 done 帧（server 的 cancel 分支会补），这里不重复发
    return { ok: false, code, stderr, stdoutSeen };
  }

  if (timedOut) {
    if (!ctx.suppressError) {
      ctx.emit({
        type: "error",
        code: "UPSTREAM_TIMEOUT",
        message: `深度规划超时（${Math.round((Date.now() - startedAt) / 1000)}s），已中断`,
        retryable: false,
      });
    }
    return { ok: false, code, stderr, stdoutSeen };
  }

  if (code !== 0 && !stdoutSeen) {
    if (!ctx.suppressError) {
      ctx.emit({
        type: "error",
        code: "UPSTREAM_ERROR",
        message: `Hermes 退出码 ${code ?? "null"}${stderr ? `：${firstLine(stderr)}` : ""}`,
        retryable: true,
      });
    }
    return { ok: false, code, stderr, stdoutSeen };
  }

  done();
  return { ok: true, code, stderr, stdoutSeen };
}

function spawnHermes(ctx: HermesRunContext): ChildProcessWithoutNullStreams {
  const spawnImpl: SpawnLike = ctx.spawnFn ?? spawn;
  const args = [...ctx.args];
  const promptArg = args.indexOf("{prompt}");
  let stdinPayload: string | null = null;

  if (promptArg >= 0) args[promptArg] = ctx.prompt;
  else stdinPayload = ctx.prompt;

  // .js/.mjs 启动器：用当前 node 跑，方便测试与自定义 shim；
  // 其余一律当原生可执行文件（venv 里的 hermes.exe / bin/hermes）
  const isScript = /\.(mjs|cjs|js)$/i.test(ctx.launcher);
  const command = isScript ? process.execPath : ctx.launcher;
  const finalArgs = isScript ? [ctx.launcher, ...args] : args;

  const child = spawnImpl(command, finalArgs, {
    cwd: ctx.cwd,
    env: { ...process.env, ...ctx.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // Windows 上必须脱离 shell 才能精确 kill；detached 让进程树可整体终止
    detached: process.platform !== "win32",
  });

  if (stdinPayload !== null) child.stdin.end(stdinPayload);
  else child.stdin.end();

  return child;
}

/**
 * 杀进程树。
 *
 * Windows：taskkill /T /F 是唯一可靠的办法 —— child.kill() 只杀直接子进程，
 * python 起的 worker 会留下继续跑。
 * 其他平台：detached 的进程组用负 pid 整体终止。
 */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.killed || child.exitCode !== null) return;
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function firstLine(s: string): string {
  return s.split("\n").map((x) => x.trim()).filter(Boolean)[0]?.slice(0, 180) ?? "";
}
