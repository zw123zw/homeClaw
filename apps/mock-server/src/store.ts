import { randomUUID } from "node:crypto";
import type { Entity, AuditEntry, Message, Session } from "@homeclaw/contracts";
import { applyService as applyServiceShared } from "@homeclaw/contracts";
import { HOME_ID, SEED_SCENES as SCENES, createEntities, nowSeconds as NOW } from "@homeclaw/contracts";

const randomSuffix = () => randomUUID().replaceAll("-", "").slice(0, 12);

export const newId = (prefix: string) => `${prefix}_${randomSuffix()}`;

export type Store = {
  entities: Map<string, Entity>;
  sessions: Map<string, Session>;
  /** session_id -> 该会话消息（按 seq 升序追加） */
  messages: Map<string, Message[]>;
  audit: AuditEntry[];
  /** 幂等键 -> 首次结果，防重复执行 */
  idempotency: Map<string, unknown>;
};

export function createStore(): Store {
  return {
    entities: createEntities(),
    sessions: new Map(),
    messages: new Map(),
    audit: [],
    idempotency: new Map(),
  };
}

export function nextSeq(store: Store, sessionId: string): number {
  const list = store.messages.get(sessionId) ?? [];
  return list.length === 0 ? 1 : (list[list.length - 1]!.seq + 1);
}

export function appendMessage(store: Store, msg: Omit<Message, "seq" | "created_at">): Message {
  const list = store.messages.get(msg.session_id) ?? [];
  const full: Message = {
    ...msg,
    seq: nextSeq(store, msg.session_id),
    created_at: NOW(),
  };
  list.push(full);
  store.messages.set(msg.session_id, list);

  const session = store.sessions.get(msg.session_id);
  if (session) {
    session.message_count = list.length;
    session.updated_at = full.created_at;
  }
  return full;
}

export function ensureSession(store: Store, sessionId: string, title = "新会话"): Session {
  const found = store.sessions.get(sessionId);
  if (found) return found;
  const ts = NOW();
  const session: Session = {
    id: sessionId,
    home_id: HOME_ID,
    title,
    created_at: ts,
    updated_at: ts,
    message_count: 0,
  };
  store.sessions.set(sessionId, session);
  store.messages.set(sessionId, []);
  return session;
}

export function recordAudit(
  store: Store,
  entry: Omit<AuditEntry, "ts">,
): AuditEntry {
  const full: AuditEntry = { ...entry, ts: NOW() };
  store.audit.unshift(full);
  if (store.audit.length > 5000) store.audit.length = 5000;
  return full;
}

export const scenes = SCENES;

/** 薄包装：补上当前时间戳，业务语义全部委托给 contracts 的单一实现 */
export function applyService(entity: Entity, service: string, data: Record<string, unknown>): Entity {
  return applyServiceShared(entity, service, data, NOW());
}
