import { describe, it, expect } from "./harness.ts";
import { translateLine, applyTranslated, tryParseJson } from "../src/hermes/events.ts";
import type { RunEvent } from "../src/agent.ts";

/** 收集翻译结果，断言"上游一行 → 界面一个动作" */
function collect(lines: string[], protocol: "ndjson" | "text" = "ndjson") {
  const events: RunEvent[] = [];
  let text = "";
  let done = 0;
  for (const line of lines) {
    applyTranslated(
      translateLine(line, protocol),
      (e) => events.push(e),
      (t) => {
        text += t;
      },
      () => {
        done += 1;
      },
    );
  }
  return { events, text, done };
}

describe("Hermes 事件翻译", () => {
  it("delta 进正文，工具事件成卡片", () => {
    const r = collect([
      JSON.stringify({ type: "delta", text: "先看目录。" }),
      JSON.stringify({ type: "tool.start", id: "t1", tool: "file_list", args: { dir: "." }, summary: "查看目录" }),
      JSON.stringify({ type: "tool.result", id: "t1", ok: true, elapsed_ms: 12 }),
      JSON.stringify({ type: "done" }),
    ]);

    expect(r.text).toBe("先看目录。");
    expect(r.events.map((e) => e.type)).toEqual(["tool.start", "tool.result"]);
    expect(r.events[0]).toMatchObject({ type: "tool.start", id: "t1", tool: "file_list" });
    expect(r.events[1]).toMatchObject({ type: "tool.result", id: "t1", ok: true, elapsed_ms: 12 });
    expect(r.done).toBe(1);
  });

  it("非 JSON 行当正文，不中断（上游会打横幅日志）", () => {
    const r = collect(["Loading hermes v0.22.5...", JSON.stringify({ type: "delta", text: "好" })]);
    expect(r.text).toBe("Loading hermes v0.22.5...好");
    expect(r.events).toHaveLength(0);
  });

  it("未知事件带 text 时按正文输出，否则忽略", () => {
    expect(collect([JSON.stringify({ type: "progress", text: "50%" })]).text).toBe("50%");
    expect(collect([JSON.stringify({ type: "progress", pct: 50 })]).text).toBe("");
  });

  it("error 事件保留 code 与 retryable", () => {
    const r = collect([JSON.stringify({ type: "error", code: "UPSTREAM_TIMEOUT", message: "超时", retryable: false })]);
    expect(r.events[0]).toMatchObject({ type: "error", code: "UPSTREAM_TIMEOUT", message: "超时", retryable: false });
  });

  it("tool.result 缺 ok 视为成功（上游只给 id 时不该误报失败）", () => {
    const r = collect([JSON.stringify({ type: "tool.result", id: "t1" })]);
    expect(r.events[0]).toMatchObject({ type: "tool.result", ok: true, elapsed_ms: 0 });
  });

  it("text 协议下整行都是正文，不做 JSON 解析", () => {
    const r = collect([JSON.stringify({ type: "delta", text: "x" })], "text");
    expect(r.events).toHaveLength(0);
    expect(r.text).toContain('"delta"');
  });

  it("空行与纯空白被忽略", () => {
    const r = collect(["", "   ", "\t"]);
    expect(r.text).toBe("");
    expect(r.events).toHaveLength(0);
  });

  it("tryParseJson 拒绝数组与非法 JSON", () => {
    expect(tryParseJson("[1,2]")).toBeNull();
    expect(tryParseJson("{oops}")).toBeNull();
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("tool.start 无 id 时补一个，避免卡片无法回填结果", () => {
    const r = collect([JSON.stringify({ type: "tool.start", tool: "web_fetch" })]);
    const ev = r.events[0];
    expect(ev?.type).toBe("tool.start");
    expect(ev && "id" in ev ? ev.id.length : 0).toBeGreaterThan(0);
  });
});