import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./schema.ts";

/**
 * SQLite 访问层。用 Node 内置 node:sqlite（无原生编译依赖，便于盒子部署）。
 * WAL 模式：读写并发更好，崩溃恢复更安全。
 */
export class Db {
  readonly raw: DatabaseSync;

  readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  /** 迁移幂等：用 user_version 记录已应用的最高版本 */
  private migrate(): void {
    const row = this.raw.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    let current = Number(row?.user_version ?? 0);

    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.raw.exec("BEGIN");
      try {
        this.raw.exec(m.sql);
        this.raw.exec(`PRAGMA user_version = ${m.version}`);
        this.raw.exec("COMMIT");
        current = m.version;
      } catch (err) {
        this.raw.exec("ROLLBACK");
        // 旧库可能已有该列（人工改过库 / 重复执行），补列失败不应阻断启动
        if (/duplicate column name/i.test(String(err))) {
          this.raw.exec("BEGIN");
          try {
            this.raw.exec("PRAGMA user_version = " + m.version);
            this.raw.exec("COMMIT");
            current = m.version;
            continue;
          } catch {
            this.raw.exec("ROLLBACK");
          }
        }
        throw new Error(`迁移失败 v${m.version} (${m.name}): ${String(err)}`);
      }
    }
  }

  run(sql: string, ...params: Array<string | number | null>): void {
    this.raw.prepare(sql).run(...params);
  }

  all<T>(sql: string, ...params: Array<string | number | null>): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  one<T>(sql: string, ...params: Array<string | number | null>): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}