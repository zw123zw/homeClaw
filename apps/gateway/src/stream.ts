import type { Envelope } from "@homeclaw/contracts";

/**
 * 事件日志 + 扇出（§5.1 / ADR-0003）。
 *
 * log_seq 与消息 seq 是两套编号，混用会立刻出错：
 *  - 消息 seq：对话消息在 session 内的序号，落 HomeHub 的 messages 表；
 *  - log_seq：这条 SSE 信封在服务端事件日志里的序号，客户端重连时带它补齐。
 * 一个用户消息可能产生 12 个信封（1 用户 + 3 工具 + 8 分片），
 * 它们共享一个消息 seq 却各有不同 log_seq —— 这正是必须分开的原因。
 */
type Logged = { logSeq: number; env: Envelope };
type Subscriber = (entry: Logged) => void;

export class SessionStream {
  private readonly logs = new Map<string, Logged[]>();
  private readonly subs = new Map<string, Set<Subscriber>>();
  /** 日志上限：一期只保留最近 2000 条，超出的靠 HomeHub 的历史分页补 */
  private static readonly MAX_LOG = 2000;

  lastSeq(sessionId: string): number {
    const log = this.logs.get(sessionId) ?? [];
    return log.length === 0 ? 0 : log[log.length - 1]!.logSeq;
  }

  /** 追加一条信封：分配 log_seq，写日志，扇出给订阅者 */
  append(sessionId: string, env: Envelope): Logged {
    const log = this.logs.get(sessionId) ?? [];
    const logSeq = this.lastSeq(sessionId) + 1;
    const entry: Logged = { logSeq, env: { ...env, log_seq: logSeq } as Envelope };

    log.push(entry);
    if (log.length > SessionStream.MAX_LOG) log.splice(0, log.length - SessionStream.MAX_LOG);
    this.logs.set(sessionId, log);

    for (const fn of this.subs.get(sessionId) ?? []) {
      try {
        fn(entry);
      } catch {
        /* 单个订阅者异常不影响广播 */
      }
    }
    return entry;
  }

  /** 重连补齐：返回 log_seq > lastSeq 的所有信封 */
  since(sessionId: string, lastSeq: number): Logged[] {
    return (this.logs.get(sessionId) ?? []).filter((e) => e.logSeq > lastSeq);
  }

  subscribe(sessionId: string, fn: Subscriber): () => void {
    const set = this.subs.get(sessionId) ?? new Set<Subscriber>();
    set.add(fn);
    this.subs.set(sessionId, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subs.delete(sessionId);
    };
  }

  subscriberCount(sessionId: string): number {
    return this.subs.get(sessionId)?.size ?? 0;
  }
}