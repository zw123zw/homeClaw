import type { DeviceEvent } from "@homeclaw/contracts";
import type { Audit } from "../audit/index.ts";
import type { Db } from "../db/index.ts";
import type { Policy } from "../policy/index.ts";
import type { CommandPipeline } from "../command.ts";
import type { HomeRuntime } from "../runtime.ts";
import { L1_TOOLS, L2_TOOLS, findTool } from "./catalog.ts";
import { ToolSearchIndex } from "./search.ts";
import { budgetOf, estimateTokens, renderToolsList, type ToolSpec } from "./spec.ts";
import { validateArgs } from "./validate.ts";
import { runTool, type ToolResult, type ToolContext } from "./execute.ts";

/** ToolHub 的依赖面：runtime 里除 toolhub 自身以外的全部（避免自引用死循环） */
export type ToolDeps = Omit<HomeRuntime, "toolhub">;

export type ToolCallRequest = {
  name: string;
  args?: Record<string, unknown>;
  /** 幂等键：同一次用户意图的重试必须带同一个 key */
  idempotencyKey?: string;
  traceId: string;
  actor: string;
  /** MCP 会话标识，用于"按会话只注入命中工具"的缓存（§4.2） */
  sessionId?: string;
};

export type ToolCallResponse = ToolResult & {
  /** 本次调用的规范化参数（已校验），便于审计复现 */
  args?: Record<string, unknown>;
  /** 执行耗时（ms），用于超时/重试统计 */
  elapsed_ms?: number;
  /** 命中的是幂等缓存而不是真执行 */
  replayed?: boolean;
};

/** 工具预算硬上限（§4.2）：超了就是设计退化，必须让测试红 */
export const TOOL_SCHEMA_TOKEN_LIMIT = 2000;

/** 单次工具调用超时：超过即放弃并写死信，不无限挂住推理循环 */
const DEFAULT_TIMEOUT_MS = 10_000;
/** 只对"可重试"的失败（超时）重试一次：设备拒绝、策略拒绝不重试 */
const MAX_ATTEMPTS = 2;

export class ToolHub {
  private readonly db: Db;
  private readonly policy: Policy;
  private readonly audit: Audit;
  private readonly pipeline: CommandPipeline;
  private readonly rt: ToolDeps;

  private readonly index: ToolSearchIndex;
  /**
   * 房间词典（§4.3：枚举化，不接受自由文本）。
   * 只能在 warmup() 里从真实实体填 —— 构造期 adapter 还是 async，
   * 硬塞一个空的 rooms 会让所有 room 参数校验失败，硬塞一个猜的值又会让模型生成不存在的房间。
   */
  private rooms: string[] = [];
  /** session_id -> 命中工具名（TTL 5 分钟），避免 prompt cache 反复失效 */
  private readonly sessionCache = new Map<string, { names: string[]; at: number }>();
  private readonly now: () => number;

  constructor(rt: ToolDeps) {
    this.rt = rt;
    this.db = rt.db;
    this.policy = rt.policy;
    this.audit = rt.audit;
    this.pipeline = rt.pipeline;
    this.now = () => Math.floor(Date.now() / 1000);
    this.index = new ToolSearchIndex([...L1_TOOLS, ...L2_TOOLS]);
  }

  /**
   * 房间词典来自实际实体，不来自手写常量。
   * 缓存的是 Promise 而不是结果：并发首调只打一次 adapter，且任何调用点都能 await 到同一份。
   */
  warmup(): Promise<void> {
    this.warming ??= (async () => {
      const entities = await this.rt.adapter.listEntities(this.rt.config.homeId);
      this.rooms = [...new Set(entities.map((e) => e.room))].sort();
    })();
    return this.warming;
  }

  private warming: Promise<void> | null = null;

  get roomList(): string[] {
    return this.rooms;
  }

  async tokenBudget(): Promise<number> {
    await this.warmup();
    return budgetOf(L1_TOOLS, this.rooms);
  }

  /** MCP tools/list 的载荷（L1 常驻 + 元工具），带 token 估算供断言 */
  async listToolsAsync(): Promise<{ tools: ReturnType<typeof renderToolsList>; tokens: number }> {
    await this.warmup();
    return this.listTools();
  }

  listTools(): { tools: ReturnType<typeof renderToolsList>; tokens: number } {
    const tools = renderToolsList(L1_TOOLS, this.rooms);
    return { tools, tokens: estimateTokens(JSON.stringify(tools)) };
  }

  /** 按会话返回工具集：L1 常驻 + 该会话检索命中的 L2（§4.2 首选注入方式） */
  async listToolsForSession(sessionId: string | undefined, query?: string): Promise<{ tools: ReturnType<typeof renderToolsList>; tokens: number }> {
    await this.warmup();
    if (!sessionId) return this.listTools();

    let names = this.sessionCache.get(sessionId)?.names;
    if (query) {
      const hits = this.index.search(query, 8, "L2").map((h) => h.tool.name);
      names = hits;
      this.sessionCache.set(sessionId, { names, at: this.now() });
    }
    if (!names) return this.listTools();

    const extra = names
      .map((n) => L2_TOOLS.find((t) => t.name === n))
      .filter((t): t is ToolSpec => !!t);
    const tools = renderToolsList([...L1_TOOLS, ...extra], this.rooms);
    return { tools, tokens: estimateTokens(JSON.stringify(tools)) };
  }

  searchTools(query: string, limit = 8): Array<{ tool: ToolSpec; score: number }> {
    return this.index.search(query, limit);
  }

  /**
   * 工具调用主路径。
   * 顺序刻意与 CommandPipeline 一致（幂等 → 存在性 → 策略 → 执行 → 审计），
   * 这样"AI 调用"与"面板手动控制"走同一套安全语义，不存在第二条捷径。
   */
  async call(req: ToolCallRequest): Promise<ToolCallResponse> {
    const started = performance.now();
    await this.warmup();
    const spec = findTool(req.name);
    const elapsed = () => Math.round(performance.now() - started);

    if (!spec) {
      this.auditDeny(req, "TOOL", "policy_service", `未知工具 ${req.name}`);
      return { ok: false, summary: `未知工具 ${req.name}`, error: "NOT_FOUND", elapsed_ms: elapsed() };
    }

    /* 1) 参数校验：不合法的参数绝不进执行器 */
    const validated = validateArgs(spec, req.args ?? {}, this.rooms);
    if (!validated.ok) {
      this.auditDeny(req, spec.name, "policy_service", `参数不合法：${validated.errors.join("；")}`);
      return {
        ok: false,
        summary: `参数不合法：${validated.errors.join("；")}`,
        error: "BAD_REQUEST",
        elapsed_ms: elapsed(),
      };
    }
    const args = validated.args;

    /* 2) 幂等：带 key 的重试直接回放，但仍留审计 */
    const idemKey = req.idempotencyKey ? `tool:${req.name}:${req.idempotencyKey}` : undefined;
    if (idemKey) {
      const cached = this.db.one<{ result: string }>(
        "SELECT result FROM idempotency WHERE home_id = ? AND key = ?",
        this.rt.config.homeId, idemKey,
      );
      if (cached) {
        this.audit.record({
          homeId: this.rt.config.homeId, traceId: req.traceId, actor: req.actor,
          action: `tool.${spec.name}`, target: JSON.stringify(args),
          params: { ...args, idempotency_key: req.idempotencyKey },
          decision: "allow", reason: "idempotent_replay", result: "skipped", origin: "ai", elapsedMs: 0,
        });
        const prev = JSON.parse(cached.result) as ToolCallResponse;
        return { ...prev, replayed: true, elapsed_ms: 0 };
      }
    }

    /* 3) 执行（含超时 + 一次重试） */
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await this.withTimeout(
          runTool(spec, args, this.context(req), req.traceId),
          DEFAULT_TIMEOUT_MS,
        );

        const response: ToolCallResponse = { ...result, args, elapsed_ms: elapsed() };

        if (idemKey && result.ok) {
          this.db.run(
            "INSERT OR REPLACE INTO idempotency (home_id, key, result, ts) VALUES (?,?,?,?)",
            this.rt.config.homeId, idemKey, JSON.stringify(response), this.now(),
          );
        }

        if (!result.ok) {
          // 超时才重试；设备/策略类失败重试只会重复同一个拒绝
          if (result.error === "TIMEOUT" && attempt < MAX_ATTEMPTS) {
            lastError = result.summary;
            continue;
          }
          if (result.error === "TIMEOUT" || result.error === "INTERNAL") {
            this.deadLetter(req, spec, args, result.summary);
          }
        }

        return response;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === MAX_ATTEMPTS) break;
      }
    }

    /* 4) 全部失败：写死信，保证"有失败但没人知道"这种情况不会发生 */
    const summary = `工具 ${spec.name} 执行失败：${lastError ?? "未知原因"}`;
    this.deadLetter(req, spec, args, summary);
    this.auditDeny(req, spec.name, "adapter_error", summary);
    return { ok: false, summary, error: "INTERNAL", elapsed_ms: elapsed(), args };
  }

  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error("TIMEOUT")), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private auditDeny(req: ToolCallRequest, target: string, reason: "policy_service" | "policy_whitelist" | "hard_deny" | "adapter_error", detail: string): void {
    this.audit.record({
      homeId: this.rt.config.homeId,
      traceId: req.traceId,
      actor: req.actor,
      action: `tool.${req.name}`,
      target,
      params: { ...(req.args ?? {}), detail },
      decision: "deny",
      reason,
      result: "error",
      origin: "ai",
      elapsedMs: 0,
    });
  }

  private deadLetter(req: ToolCallRequest, spec: ToolSpec, args: Record<string, unknown>, error: string): void {
    try {
      this.db.run(
        `INSERT INTO dead_letter (home_id, trace_id, tool, args, error, attempts, ts)
         VALUES (?,?,?,?,?,?,?)`,
        this.rt.config.homeId, req.traceId, spec.name, JSON.stringify(args), error, MAX_ATTEMPTS, this.now(),
      );
    } catch (err) {
      console.error("[toolhub] 死信写入失败（工具失败本身已上报）：", err);
    }
  }

  /** 执行上下文：把 runtime 收窄成工具真正需要的能力 */
  private context(req: ToolCallRequest): ToolContext {
    return {
      homeId: this.rt.config.homeId,
      rooms: () => this.rooms,
      listEntities: async () => this.rt.adapter.listEntities(this.rt.config.homeId),
      command: (input) => this.pipeline.execute({ ...input, origin: input.origin }),
      scenes: () => this.rt.scenes(),
      automations: () => this.readAutomations(),
      setAutomationEnabled: (id, on) => this.toggleAutomation(id, on),
      sensorHistory: (q) => this.readSensorHistory(q),
      search: (query, limit) => this.index.search(query, limit),
      callTool: async (name, args, traceId) => {
        if (name === req.name) return { ok: false, summary: "call_tool 不能递归调用自身", error: "BAD_REQUEST" };
        const sub = await this.call({ name, args, traceId, actor: req.actor, sessionId: req.sessionId });
        return sub;
      },
      now: this.now,
    };
  }

  private readAutomations(): Array<{ id: string; enabled: boolean; when: unknown; then: unknown }> {
    const rows = this.db.all<{ automation_id: string; enabled: number; when_json: string; then_json: string }>(
      "SELECT automation_id, enabled, when_json, then_json FROM automations WHERE home_id = ? ORDER BY automation_id",
      this.rt.config.homeId,
    );
    return rows.map((r) => ({
      id: r.automation_id,
      enabled: r.enabled === 1,
      when: JSON.parse(r.when_json),
      then: JSON.parse(r.then_json),
    }));
  }

  private toggleAutomation(id: string, on: boolean): boolean {
    const found = this.db.one<{ automation_id: string }>(
      "SELECT automation_id FROM automations WHERE home_id = ? AND automation_id = ?",
      this.rt.config.homeId, id,
    );
    if (!found) return false;
    this.db.run(
      "UPDATE automations SET enabled = ? WHERE home_id = ? AND automation_id = ?",
      on ? 1 : 0, this.rt.config.homeId, id,
    );
    return true;
  }

  private readSensorHistory(q: { room?: string; since: number; limit: number }): Array<{ entity_id: string; ts: number; outcome: string }> {
    const where = ["home_id = ?", "ts >= ?"];
    const args: Array<string | number> = [this.rt.config.homeId, q.since];
    if (q.room) {
      where.push("room = ?");
      args.push(q.room);
    }
    args.push(q.limit);
    return this.db.all<{ entity_id: string; ts: number; outcome: string }>(
      `SELECT entity_id, ts, outcome FROM trigger_log WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`,
      ...args,
    );
  }

  /** 死信查询：运维与验收都要看得到 */
  deadLetters(limit = 50): Array<{ trace_id: string; tool: string; error: string; ts: number }> {
    return this.db.all(
      "SELECT trace_id, tool, error, ts FROM dead_letter WHERE home_id = ? ORDER BY ts DESC LIMIT ?",
      this.rt.config.homeId, limit,
    );
  }

  /** 供事件流推断"设备变化是否由 AI 引发"（防环辅助） */
  noteDeviceEvent(event: DeviceEvent): void {
    if (event.origin === "ai") this.sessionCache.delete(`ai:${event.entity_id}`);
  }
}