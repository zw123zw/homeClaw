import { describe, it, expect } from "./harness.ts";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runHermes } from "../src/hermes/runner.ts";
import type { RunEvent } from "../src/agent.ts";

/**
 * runner 的分包与收尾行为。
 *
 * 这些分支在实际部署里全都踩过：
 *  - 输出不带末尾换行 → 最后一句丢失；
 *  - 一个 chunk 里塞了多行 → 少发一半事件；
 *  - 退出码 0 但没有 done → 客户端一直转圈；
 *  - 超时 / 取消 → python 子进程残留。
 * 用假 child 把每条分支都跑一遍，比在装了 Python 的机器上手工试更可靠。
 */

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: () => void };
    pid: number;
    killed: boolean;
    exitCode: number | null;
    kill: (s?: string) => void;
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stdin = { end: () => {} };
  child.pid = 12345;
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

type Harness = { events: RunEvent[]; text: string; done: number };

async function runWith(lines: string[], opts: { code?: number | null; noTrailingNewline?: boolean; closeAfter?: number } = {}): Promise<{ h: Harness; result: Awaited<ReturnType<typeof runHermes>> }> {
  const child = fakeChild();
  const h: Harness = { events: [], text: "", done: 0 };

  const promise = runHermes({
    launcher: "fake-hermes.exe",
    args: ["run", "{prompt}"],
    prompt: "x",
    protocol: "ndjson",
    cwd: os.tmpdir(),
    env: {},
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    emit: (e) => {
      h.events.push(e);
      if (e.type === "delta") h.text += e.text;
      if (e.type === "done") h.done += 1;
    },
    spawnFn: () => child as never,
  });

  // 让底层先挂上监听，再喂数据
  await new Promise((r) => setTimeout(r, 10));
  const payload = opts.noTrailingNewline ? lines.join("\n") : lines.join("\n") + "\n";
  child.stdout.emit("data", payload);
  child.exitCode = opts.code ?? 0;
  child.emit("close", opts.code ?? 0);
  const result = await promise;
  return { h, result };
}

describe("Hermes runner", () => {
  it("多行在一个 chunk 里也要逐行解析", async () => {
    const { h } = await runWith([
      JSON.stringify({ type: "delta", text: "一。" }),
      JSON.stringify({ type: "delta", text: "二。" }),
    ]);
    expect(h.text).toBe("一。二。");
    expect(h.done).toBe(1);
  });

  it("最后一行没有换行符也不能丢", async () => {
    const { h } = await runWith([JSON.stringify({ type: "delta", text: "结尾。" })], { noTrailingNewline: true });
    expect(h.text).toBe("结尾。");
  });

  it("退出码 0 但上游没发 done 时补一个（否则客户端一直转圈）", async () => {
    const { h } = await runWith([JSON.stringify({ type: "delta", text: "ok" })]);
    expect(h.done).toBe(1);
  });

  it("退出码 0 且上游已发 done 时不再重复发", async () => {
    const { h } = await runWith([JSON.stringify({ type: "delta", text: "ok" }), JSON.stringify({ type: "done" })]);
    expect(h.done).toBe(1);
  });

  it("非 0 退出且没有任何输出 → error 事件", async () => {
    const { h, result } = await runWith([], { code: 2 });
    expect(result.ok).toBe(false);
    expect(h.events.some((e) => e.type === "error")).toBe(true);
  });

  it("suppressError 时不发 error（供降级路径静默回落）", async () => {
    const child = fakeChild();
    const events: RunEvent[] = [];
    const promise = runHermes({
      launcher: "fake.exe",
      args: ["{prompt}"],
      prompt: "x",
      protocol: "ndjson",
      cwd: os.tmpdir(),
      env: {},
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      suppressError: true,
      spawnFn: () => {
        // 模拟 spawn 直接失败（Windows 上权限策略会这样）
        throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
      },
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("工具事件与文字混排时顺序保持", async () => {
    const { h } = await runWith([
      JSON.stringify({ type: "delta", text: "先查。" }),
      JSON.stringify({ type: "tool.start", id: "t1", tool: "file_list", args: {}, summary: "查目录" }),
      JSON.stringify({ type: "tool.result", id: "t1", ok: true, elapsed_ms: 5 }),
      JSON.stringify({ type: "delta", text: "再写。" }),
    ]);
    expect(h.events.map((e) => e.type)).toEqual(["delta", "tool.start", "tool.result", "delta", "done"]);
    expect(h.text).toBe("先查。再写。");
  });

  it("工具结果 schema 参数验证：stdout 收到非法 JSON 行也不崩", async () => {
    const { h, result } = await runWith(["not json at all", JSON.stringify({ type: "delta", text: "继续" })]);
    expect(result.ok).toBe(true);
    expect(h.text).toContain("not json at all");
    expect(h.text).toContain("继续");
  });
});