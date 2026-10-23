/**
 * 数据模型（§C7：所有表带 home_id，所有查询带 home_id）。
 * 一期用 SQLite + WAL；迁移按序号递增，启动时幂等执行。
 */
export type Migration = { version: number; name: string; sql: string };

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS homes (
        home_id     TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      -- 设备实体快照：由 adapter 同步写入，用于离线态与快速读取
      CREATE TABLE IF NOT EXISTS entities (
        home_id     TEXT NOT NULL,
        entity_id   TEXT NOT NULL,
        name        TEXT NOT NULL,
        room        TEXT NOT NULL,
        type        TEXT NOT NULL,
        capabilities TEXT NOT NULL,           -- JSON array
        state       TEXT NOT NULL,            -- JSON object
        available   INTEGER NOT NULL DEFAULT 1,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (home_id, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_entities_room ON entities (home_id, room);

      CREATE TABLE IF NOT EXISTS scenes (
        home_id     TEXT NOT NULL,
        scene_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        room        TEXT,
        icon        TEXT,
        actions     TEXT NOT NULL,            -- JSON array
        PRIMARY KEY (home_id, scene_id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        home_id        TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        title          TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        message_count  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (home_id, session_id)
      );

      -- seq 在同一 session 内单调递增，是断线补齐的唯一依据
      CREATE TABLE IF NOT EXISTS messages (
        home_id     TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        message_id  TEXT NOT NULL,
        role        TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        text        TEXT NOT NULL DEFAULT '',
        tool        TEXT,                     -- JSON object
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (home_id, session_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages (home_id, message_id);

      CREATE TABLE IF NOT EXISTS audit (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        home_id      TEXT NOT NULL,
        trace_id     TEXT NOT NULL,
        actor        TEXT NOT NULL,
        action       TEXT NOT NULL,
        target       TEXT NOT NULL,
        params       TEXT NOT NULL,           -- JSON object
        decision     TEXT NOT NULL,
        reason       TEXT NOT NULL,
        result       TEXT NOT NULL,
        origin       TEXT,
        elapsed_ms   INTEGER NOT NULL DEFAULT 0,
        ts           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_home_ts ON audit (home_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit (home_id, trace_id);

      -- 幂等键：防重复执行（§M2 验收）
      CREATE TABLE IF NOT EXISTS idempotency (
        home_id     TEXT NOT NULL,
        key         TEXT NOT NULL,
        result      TEXT NOT NULL,            -- JSON
        ts          INTEGER NOT NULL,
        PRIMARY KEY (home_id, key)
      );

      -- 用户偏好：必须可查、可改、可删（§3.2 记忆策略）
      CREATE TABLE IF NOT EXISTS preferences (
        home_id     TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (home_id, key)
      );

      -- 自动化规则（§6.4）
      CREATE TABLE IF NOT EXISTS automations (
        home_id       TEXT NOT NULL,
        automation_id TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 0,
        when_json     TEXT NOT NULL,
        then_json     TEXT NOT NULL,
        cooldown_seconds INTEGER NOT NULL DEFAULT 300,
        last_fired_at INTEGER,
        PRIMARY KEY (home_id, automation_id)
      );

      -- 主动自动化的事件与预算计量（§6.2 四件套）
      CREATE TABLE IF NOT EXISTS trigger_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        home_id    TEXT NOT NULL,
        entity_id  TEXT NOT NULL,
        room       TEXT,
        ts         INTEGER NOT NULL,
        outcome    TEXT NOT NULL             -- fired | merged | rate_limited | loop_blocked | budget_exceeded
      );
      CREATE INDEX IF NOT EXISTS idx_trigger_home_ts ON trigger_log (home_id, ts DESC);

      -- token/费用计量：日预算封顶依赖此表
      CREATE TABLE IF NOT EXISTS usage (
        home_id    TEXT NOT NULL,
        day        TEXT NOT NULL,             -- YYYY-MM-DD
        tokens     INTEGER NOT NULL DEFAULT 0,
        cny_milli  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (home_id, day)
      );
    `,
  },
  {
    version: 2,
    name: "toolhub",
    sql: /* sql */ `
      -- 死信：工具调用最终失败（超时 / 内部异常）必须留痕，
      -- 否则"AI 说做完了但设备没动"这种事故无法事后定位。
      CREATE TABLE IF NOT EXISTS dead_letter (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        home_id    TEXT NOT NULL,
        trace_id   TEXT NOT NULL,
        tool       TEXT NOT NULL,
        args       TEXT NOT NULL,
        error      TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 1,
        ts         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dead_letter_home_ts ON dead_letter (home_id, ts DESC);

      -- 规则引擎的执行记录（§6.4）：与 trigger_log 分开，
      -- 一条是"事件要不要推理"，一条是"规则怎么执行的"，混在一张表里统计会失真。
      CREATE TABLE IF NOT EXISTS rule_run (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        home_id       TEXT NOT NULL,
        automation_id TEXT NOT NULL,
        trace_id      TEXT NOT NULL,
        matched       INTEGER NOT NULL,
        ok            INTEGER NOT NULL,
        detail        TEXT,
        ts            INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rule_run_home_ts ON rule_run (home_id, ts DESC);
    `,
  },
  {
    version: 3,
    name: "attachments",
    sql: /* sql */ `
      -- 附件元数据：文件本体落 data/attachments，DB 只存可查询的元数据
      CREATE TABLE IF NOT EXISTS attachments (
        home_id       TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        name          TEXT NOT NULL,
        mime          TEXT NOT NULL,
        size          INTEGER NOT NULL,
        kind          TEXT NOT NULL,
        file_name     TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (home_id, attachment_id)
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_home_created ON attachments (home_id, created_at DESC);

      -- 历史消息也要能还原附件卡片；旧库通过 ALTER 补列
      ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 4,
    name: "message-id-per-session",
    sql: /* sql */ `
      -- 修正 message_id 的唯一范围：原先建成 (home_id, message_id) 全局唯一，
      -- 但工具调用的 id 是模型给短名（"t1"、"call_abc"），跨会话必然重复。
      -- 结果是第二个会话里的同名工具卡插入直接 500 —— 表现是"历史里工具卡莫名消失"，
      -- 而对话本身正常，极难定位。按会话唯一才与 findMessage 的查询条件一致。
      DROP INDEX IF EXISTS idx_messages_id;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages (home_id, session_id, message_id);
    `,
  },
];
