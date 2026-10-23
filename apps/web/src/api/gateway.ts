import type { ClientEnvelope, Envelope } from "@homeclaw/contracts";
import { platform } from "@/platform";

export type StreamHandlers = {
  onEnvelope: (env: Envelope) => void;
  onOpen?: () => void;
  onError?: (err: Error) => void;
  /** 心跳超时/网络中断后即将重连 */
  onClose?: (reason: string) => void;
};

/**
 * L1 ↔ L2 通道（§5.1）：SSE 优先。
 * 关键行为：
 * - 重连时携带 last_seq（已收到的最大 log_seq），服务端补齐缺口；
 * - 上行只有"发消息/取消"两条 HTTP，符合"上行极少"的定位；
 * - 指数退避重连，退避上限 15s，避免断网时打爆网关。
 */
export class GatewayChannel {
  private es: AbortController | null = null;
  private closed = false;
  private retry = 0;
  private lastSeq = 0;
  private retryTimer: number | null = null;

  private readonly sessionId: string;
  private readonly handlers: StreamHandlers;

  constructor(sessionId: string, handlers: StreamHandlers) {
    this.sessionId = sessionId;
    this.handlers = handlers;
  }

  get cursor(): number {
    return this.lastSeq;
  }

  async connect(): Promise<void> {
    const { gatewayBaseUrl } = await platform().runtimeConfig();
    const url = `${gatewayBaseUrl}/v1/stream?session_id=${encodeURIComponent(this.sessionId)}&last_seq=${this.lastSeq}`;

    this.es?.abort();
    const ac = new AbortController();
    this.es = ac;

    try {
      const res = await fetch(url, { signal: ac.signal, headers: { accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`SSE 建连失败: HTTP ${res.status}`);
      this.retry = 0;
      this.handlers.onOpen?.();
      await this.pump(res.body, ac.signal);
    } catch (err) {
      if (this.closed || ac.signal.aborted) return;
      this.handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
    }
  }

  private async pump(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.startsWith(":")) continue; // ping
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const env = JSON.parse(dataLine.slice(6)) as Envelope;
          if (typeof env.log_seq === "number") this.lastSeq = Math.max(this.lastSeq, env.log_seq);
          this.handlers.onEnvelope(env);
        } catch {
          /* 坏帧丢弃：单帧解析失败不应中断整条流 */
        }
      }
    }

    if (!this.closed) {
      this.handlers.onClose?.("stream ended");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.retry += 1;
    const delay = Math.min(500 * 2 ** (this.retry - 1), 15_000);
    this.retryTimer = window.setTimeout(() => void this.connect(), delay);
  }

  async send(env: ClientEnvelope): Promise<void> {
    const { gatewayBaseUrl } = await platform().runtimeConfig();
    const path = env.type === "run.cancel" ? "/v1/chat/cancel" : "/v1/chat/message";
    await fetch(`${gatewayBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
    });
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.es?.abort();
  }
}