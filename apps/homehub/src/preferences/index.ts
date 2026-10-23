import type { Db } from "../db/index.ts";

/**
 * 用户偏好（§3.2 记忆策略）：显式键值对，可查可改可删。
 *
 * 为什么不做隐式向量记忆：
 *  - 用户看不见的记忆，出错时无法纠正；
 *  - 向量召回不可解释，"AI 为什么这么说"没法回答；
 *  - 量级上，家庭场景真正需要长期记住的就那几条（称呼、常去的房间、忌口、作息）。
 *
 * 这里只做最朴素的一张表：key → value，读写都带 home_id。
 * 注入给模型时按"用户偏好"列出，用户可在设置里逐条看到并删除。
 */
export type Preference = { key: string; value: string; updated_at: number };

type Row = { key: string; value: string; updated_at: number };

export class Preferences {
  private readonly db: Db;
  private readonly homeId: string;
  private readonly now: () => number;

  constructor(db: Db, homeId: string, now: () => number) {
    this.db = db;
    this.homeId = homeId;
    this.now = now;
  }

  list(): Preference[] {
    return this.db
      .all<Row>(
        "SELECT key, value, updated_at FROM preferences WHERE home_id = ? ORDER BY key ASC",
        this.homeId,
      )
      .map((r) => ({ key: r.key, value: r.value, updated_at: r.updated_at }));
  }

  /** 以对象形式给 Gateway 用：注入系统提示时不需要时间戳 */
  asRecord(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.list()) out[p.key] = p.value;
    return out;
  }

  set(key: string, value: string): Preference {
    const ts = this.now();
    // 显式 UPSERT：先删后插也行，但 UPSERT 少一次写事务、也不改变 updated_at 语义
    this.db.run(
      `INSERT INTO preferences (home_id, key, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(home_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      this.homeId, key, value, ts,
    );
    return { key, value, updated_at: ts };
  }

  remove(key: string): boolean {
    this.db.run("DELETE FROM preferences WHERE home_id = ? AND key = ?", this.homeId, key);
    return true;
  }
}
