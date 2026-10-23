import type { DeviceEvent } from "@homeclaw/contracts";

type Subscriber = (event: DeviceEvent) => void;

/**
 * EventStream：设备事件的进程内广播器，仅供 /v1/events 推送面板用。
 *
 * 为什么单独存在，而不是让路由自己订阅 adapter：
 *  - adapter 只有一个订阅口，EventBus（自动化）已经占用了它；再订阅一次需要 fan-out，
 *    不然 M3 接上后必然出现"面板没更新"或"自动化丢了事件"。
 *  - 面板订阅者随连接生灭，必须有显式的退订，否则内存泄漏。
 * 这里只做扇出，不做过滤、不做持久化 —— 这两件事分别属于客户端与 sessions。
 */
export class EventStream {
  private subs = new Set<Subscriber>();
  private seq = 0;

  publish(event: DeviceEvent): void {
    this.seq += 1;
    for (const fn of this.subs) {
      try {
        fn(event);
      } catch {
        /* 单个订阅者异常不得影响其他订阅者 */
      }
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  get size(): number {
    return this.subs.size;
  }

  /** 仅用于测试断言 */
  get published(): number {
    return this.seq;
  }
}