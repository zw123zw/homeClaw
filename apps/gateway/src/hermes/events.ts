import type { RunEvent } from "../agent.ts";

/**
 * Hermes 输出 → RunEvent 的纯翻译层。
 *
 * 单独抽出来是为了可测：这里每条映射都对应一个界面表现
 * （工具卡、流式文字、错误条），而它又最容易因为上游改格式而失效。
 * 纯函数意味着可以用固定输入逐一断言，不需要真起 Python 子进程。
 *
 * 设计原则：**未知输入永不抛错**。上游加新事件、打横幅日志、输出半截 JSON，
 * 都不该让整轮对话失败 —— 最差退化成"这段当纯文本显示"。
 */
export type Translated =
  | { kind: "delta"; text: string }
  | { kind: "tool.start"; id: string; tool: string; args: Record<string, unknown>; summary?: string }
  | { kind: "tool.result"; id: string; ok: boolean; elapsed_ms: number; summary?: string }
  | { kind: "error"; code: string; message: string; retryable: boolean }
  | { kind: "done" }
  | { kind: "ignore" };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 只有以 { 开头的行才尝试解析：给 JSON.parse 喂日志行会抛，用它做门禁更省 */
export function tryParseJson(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 翻译一行输出。
 *
 * protocol=text 时整行都是正文；ndjson 时逐行解析，非法行退化为正文。
 */
export function translateLine(line: string, protocol: "ndjson" | "text"): Translated {
  const t = line.trim();
  if (!t) return { kind: "ignore" };
  if (protocol === "text") return { kind: "delta", text: t };

  const obj = tryParseJson(t);
  if (!obj) return { kind: "delta", text: t };

  const type = str(obj.type);

  switch (type) {
    case "delta":
    case "assistant.delta": {
      const text = str(obj.text) || str(obj.delta);
      return text ? { kind: "delta", text } : { kind: "ignore" };
    }
    case "tool.start":
      return {
        kind: "tool.start",
        id: str(obj.id) || `t_h_${Date.now().toString(36)}`,
        tool: str(obj.tool) || str(obj.name) || "tool",
        args: (obj.args as Record<string, unknown>) ?? (obj.arguments as Record<string, unknown>) ?? {},
        ...(str(obj.summary) ? { summary: str(obj.summary) } : {}),
      };
    case "tool.result":
      return {
        kind: "tool.result",
        id: str(obj.id),
        ok: obj.ok !== false,
        elapsed_ms: typeof obj.elapsed_ms === "number" ? obj.elapsed_ms : 0,
        ...(str(obj.summary) ? { summary: str(obj.summary) } : {}),
      };
    case "error":
      return {
        kind: "error",
        code: str(obj.code) || "UPSTREAM_ERROR",
        message: str(obj.message) || "Hermes 返回错误",
        retryable: obj.retryable === true,
      };
    case "done":
      return { kind: "done" };
    default: {
      // 兜底：带 text/message 的未知事件按正文输出；什么都没有就忽略
      const text = str(obj.text) || str(obj.message);
      return text ? { kind: "delta", text } : { kind: "ignore" };
    }
  }
}

/** 把 Translated 应用到 RunEvent 回调上（runner 与测试共用的唯一实现） */
export function applyTranslated(
  t: Translated,
  emit: (e: RunEvent) => void,
  sendDelta: (text: string) => void,
  done: () => void,
): void {
  switch (t.kind) {
    case "delta":
      sendDelta(t.text);
      return;
    case "tool.start":
      emit({
        type: "tool.start",
        id: t.id,
        tool: t.tool,
        args: t.args,
        ...(t.summary ? { summary: t.summary } : {}),
      });
      return;
    case "tool.result":
      emit({
        type: "tool.result",
        id: t.id,
        ok: t.ok,
        elapsed_ms: t.elapsed_ms,
        ...(t.summary ? { summary: t.summary } : {}),
      });
      return;
    case "error":
      emit({ type: "error", code: t.code, message: t.message, retryable: t.retryable });
      return;
    case "done":
      done();
      return;
    default:
      return;
  }
}