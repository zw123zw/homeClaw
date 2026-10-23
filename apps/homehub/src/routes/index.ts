import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Attachment, EntityCommandRequest, MessagePageQuery, AuditQuery, CreateSessionRequest } from "@homeclaw/contracts";
import { requirePrincipal } from "../auth.ts";
import { Attachments, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "../attachments/index.ts";
import { createMcpHandler } from "../toolhub/mcp.ts";
import { L1_TOOLS, L2_TOOLS } from "../toolhub/catalog.ts";
import { TOOL_SCHEMA_TOKEN_LIMIT } from "../toolhub/index.ts";
const L1_COUNT = L1_TOOLS.length;

const CommandBody = EntityCommandRequest.extend({
  /** AI 调用时由 ToolHub 传入；面板手动控制为 user */
  origin: z.enum(["ai", "user", "rule"]).default("user"),
});

/**
 * 规则编辑入参（§6.4）。
 *
 * 为什么不让前端直接 PUT 整个 when/then：这两个字段会被规则引擎原样执行，
 * 一旦允许任意 JSON 落库，一条手滑的规则就能在半夜把门锁打开。
 * 所以这里只放行规则引擎真正理解的字段，其余一律拒绝。
 */
const RuleWhenBody = z.object({
  kind: z.enum(["state_changed", "availability_changed", "triggered"]).optional(),
  entity: z.string().min(1).max(120).optional(),
  to: z.union([z.boolean(), z.number(), z.string()]).optional(),
  from: z.union([z.boolean(), z.number(), z.string()]).optional(),
  attribute: z.string().min(1).max(64).optional(),
  for_seconds: z.number().int().min(0).max(3600).optional(),
  gt: z.number().optional(),
  lt: z.number().optional(),
  time_between: z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)]).optional(),
});

const RuleThenBody = z.union([
  z.object({
    action: z.literal("entity.command"),
    entity: z.string().min(1).max(120),
    service: z.string().min(1).max(64),
    data: z.record(z.unknown()).optional(),
    delay_ms: z.number().int().min(0).max(60_000).optional(),
  }),
  z.object({ action: z.literal("scene.run"), name: z.string().min(1).max(120) }),
]);

const RuleUpdateBody = z
  .object({
    enabled: z.boolean().optional(),
    when: RuleWhenBody.optional(),
    then: z.array(RuleThenBody).max(20).optional(),
    cooldown_seconds: z.number().int().min(0).max(86_400).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "至少要改一个字段" });

const SessionBody = z.object({ session_id: z.string().min(1), title: z.string().max(120).optional() });

const MessageBody = z.object({
  session_id: z.string().min(1),
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "tool", "system"]),
  text: z.string().default(""),
  attachments: z.array(Attachment).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  tool: z
    .object({
      name: z.string(),
      args: z.record(z.unknown()).default({}),
      ok: z.boolean().optional(),
      elapsed_ms: z.number().optional(),
    })
    .optional(),
});

export async function registerRoutes(app: FastifyInstance) {
  const { rt } = app;
  const attachments = new Attachments({
    db: rt.db,
    homeId: rt.config.homeId,
    dir: process.env.ATTACHMENT_DIR ?? "data/attachments",
    now: () => Math.floor(Date.now() / 1000),
    newId: app.newId,
  });

  /* ---------------- 健康与概览 ---------------- */

  app.get("/v1/health", async () => {
    const adapterHealth = await rt.adapter.healthCheck();
    let dbOk = true;
    try {
      rt.db.one("SELECT 1 AS ok");
    } catch {
      dbOk = false;
    }

    // 网关是独立进程：这里必须真探测，不能写死。否则客户端"诊断"页永远显示未接入，
    // 而实际对话早就通了 —— 假状态比没有状态更糟。
    const gateway = await probeGateway(rt.config.gateway.baseUrl);

    return {
      ok: adapterHealth.ok && dbOk && gateway.status !== "down",
      version: "homehub-0.1.0",
      ts: Math.floor(Date.now() / 1000),
      adapter: { status: adapterHealth.ok ? "ok" : "down", detail: adapterHealth.detail },
      toolhub: {
        status: "ok",
        detail: `${L1_COUNT} 个常驻工具 / schema ${await rt.toolhub.tokenBudget()} tokens（上限 2000）`,
      },
      llm: gateway.llm,
      gateway: gateway.component,
      db: { status: dbOk ? "ok" : "down", detail: rt.config.dbPath },
    };
  });

  app.get("/v1/home", async () => ({ home_id: rt.config.homeId, name: "演示家庭" }));

  /* ---------------- 设备 ---------------- */

  app.get("/v1/entities", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req) => {
    const q = req.query as { room?: string; type?: string };
    let list = await rt.adapter.listEntities(rt.config.homeId);
    if (q.room) list = list.filter((e) => e.room === q.room);
    if (q.type) list = list.filter((e) => e.type === q.type);
    return list.sort((a, b) => a.room.localeCompare(b.room) || a.name.localeCompare(b.name));
  });

  app.get("/v1/entities/:id", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const list = await rt.adapter.listEntities(rt.config.homeId);
    const entity = list.find((e) => e.id === id);
    if (!entity) {
      return reply.code(404).send({ code: "NOT_FOUND", message: `实体不存在: ${id}`, retryable: false });
    }
    return entity;
  });

  app.post("/v1/entities/:id/command", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = CommandBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "请求体不合法", retryable: false, detail: parsed.error.issues });
    }

    const outcome = await rt.pipeline.execute({
      entityId: id,
      service: parsed.data.service,
      data: parsed.data.data,
      origin: parsed.data.origin,
      actor: `user:u_local`,
      idempotencyKey: parsed.data.idempotency_key,
      traceId: app.newId("tr"),
    });

    if (!outcome.ok) {
      const status =
        outcome.code === "NOT_FOUND" ? 404 :
        outcome.code === "UNAVAILABLE" ? 503 :
        outcome.code === "RATE_LIMITED" ? 429 :
        outcome.code === "HARD_DENY" || outcome.code === "POLICY_DENIED" ? 403 : 400;
      return reply.code(status).send({
        code: outcome.code,
        message: outcome.message,
        retryable: outcome.code === "UNAVAILABLE",
        trace_id: outcome.traceId,
      });
    }

    return { ok: true, state: outcome.state, trace_id: outcome.traceId, elapsed_ms: outcome.elapsedMs };
  });

  /* ---------------- 场景 ---------------- */

  app.get("/v1/scenes", { preHandler: requirePrincipal(rt.config, ["user"]) }, async () => rt.scenes());

  app.post("/v1/scenes/:id/run", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const traceId = app.newId("tr");
    const outcome = await rt.runScene(id, traceId, "user:u_local");
    if (outcome.results.length === 0) {
      return reply.code(404).send({ code: "NOT_FOUND", message: `场景不存在: ${id}`, retryable: false });
    }
    return { ok: outcome.ok, trace_id: outcome.traceId, results: outcome.results };
  });

  /* ---------------- 会话与消息 ---------------- */

  app.get("/v1/sessions", { preHandler: requirePrincipal(rt.config, ["user"]) }, async () => rt.sessions.list());

  app.post("/v1/sessions", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req, reply) => {
    const parsed = CreateSessionRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "请求体不合法", retryable: false });
    }
    const sessionId = app.newId("s");
    return reply.code(201).send(rt.sessions.create(sessionId, parsed.data.title ?? "新会话"));
  });

  /**
   * 网关侧建会话：幂等，已存在则直接返回。
   *
   * 必须带 MCP 票据：这个接口会往库里写会话与消息，
   * 裸奔意味着本机任何程序（包括浏览器里的网页）都能伪造对话历史。
   * 网关本来就持有 MCP 票据（HubClient 用的是用户票据，这里单独用 mcpToken）。
   */
  app.post("/v1/internal/sessions", { preHandler: requirePrincipal(rt.config, ["mcp"]) }, async (req, reply) => {
    const parsed = SessionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "需要 session_id", retryable: false });
    }
    return rt.sessions.ensure(parsed.data.session_id, parsed.data.title);
  });

  app.get("/v1/sessions/:id/messages", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = MessagePageQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "查询参数不合法", retryable: false });
    }
    if (!rt.sessions.find(id)) {
      return reply.code(404).send({ code: "NOT_FOUND", message: `会话不存在: ${id}`, retryable: false });
    }
    return rt.sessions.page(id, parsed.data);
  });

  /** 网关侧写消息：只有网关能写 —— 用 MCP 票据，不用用户票据 */
  app.post("/v1/internal/messages", { preHandler: requirePrincipal(rt.config, ["mcp"]) }, async (req, reply) => {
    const parsed = MessageBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "请求体不合法", retryable: false });
    }
    rt.sessions.ensure(parsed.data.session_id);
    const row = rt.sessions.append(parsed.data);
    return reply.code(201).send(row);
  });

  /** 工具结果回填：把 ok/elapsed_ms 写回同一张工具卡 */
  app.patch("/v1/internal/messages/:id", { preHandler: requirePrincipal(rt.config, ["mcp"]) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        session_id: z.string().min(1),
        ok: z.boolean().optional(),
        elapsed_ms: z.number().nonnegative().optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "请求体不合法", retryable: false });
    }
    const row = rt.sessions.updateTool(body.data.session_id, id, {
      ...(body.data.ok !== undefined ? { ok: body.data.ok } : {}),
      ...(body.data.elapsed_ms !== undefined ? { elapsed_ms: body.data.elapsed_ms } : {}),
    });
    if (!row) return reply.code(404).send({ code: "NOT_FOUND", message: "消息不存在", retryable: false });
    return row;
  });

  /**
   * 调试/模拟接口默认关闭。
   *
   * 这些接口能注入传感器事件、读事件总线状态 —— 生产环境暴露等于给外部一个
   * "伪造传感器"的入口（自动化的触发条件全靠它）。开发与验收显式设
   * HOMECLAW_DEBUG=1 才挂载；未开启时连路由都不存在（404，而不是 403，
   * 不泄露"这里本来有个调试接口"）。
   */
  if (rt.config.debug) {
  app.get("/v1/_debug/last-seq", async (req) => {
    const q = req.query as { session_id: string };
    return { session_id: q.session_id, last_seq: rt.sessions.lastSeq(q.session_id) };
  });
  }

  /* ---------------- 附件 ---------------- */

  /**
   * 上传附件。用 base64 JSON 而不是 multipart：少一个运行时依赖，
   * 且客户端压缩后的图片通常远小于 20MB 上限。
   */
  app.post("/v1/attachments", { bodyLimit: MAX_ATTACHMENT_BYTES * 2, preHandler: requirePrincipal(rt.config, ["user"]) }, async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(260),
        mime: z.string().max(160).optional(),
        data: z.string().min(1),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "附件参数不合法", retryable: false });
    }
    try {
      return reply.code(201).send(attachments.save(parsed.data));
    } catch (err) {
      return reply.code(400).send({
        code: "BAD_REQUEST",
        message: err instanceof Error ? err.message : "附件保存失败",
        retryable: false,
      });
    }
  });

  app.get("/v1/attachments/:id", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = attachments.read(id);
    if (!found) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "附件不存在", retryable: false });
    }
    const encoded = encodeURIComponent(found.fileName);
    reply.header("content-type", found.mime);
    reply.header("content-length", String(found.bytes.length));
    reply.header("content-disposition", `inline; filename*=UTF-8''${encoded}`);
    reply.header("x-content-type-options", "nosniff");
    return reply.send(found.bytes);
  });

  app.delete("/v1/attachments/:id", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req) => {
    const { id } = req.params as { id: string };
    return { ok: attachments.remove(id) };
  });
  /* ---------------- 审计 ---------------- */

  /**
   * 用户偏好（记忆，§3.2）：可查、可改、可删。
   *
   * 为什么不给 AI 一个"隐式记忆"接口让它自己往里写：
   * 用户看不见的记忆出错了无法纠正，而且会越攒越离谱。
   * 这里只提供显式的键值对，AI 读、用户改，权责清楚。
   */
  app.get("/v1/preferences", { preHandler: requirePrincipal(rt.config, ["user"]) }, async () => rt.preferences.list());

  app.put("/v1/preferences/:key", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req, reply) => {
    const { key } = req.params as { key: string };
    const body = z
      .object({ value: z.string().max(500) })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "需要 value（≤500 字）", retryable: false });
    }
    if (!key.trim() || key.length > 80) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "key 需 1-80 字符", retryable: false });
    }
    return rt.preferences.set(decodeURIComponent(key), body.data.value);
  });

  app.delete("/v1/preferences/:key", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req) => {
    const { key } = req.params as { key: string };
    rt.preferences.remove(decodeURIComponent(key));
    return { ok: true };
  });

  app.get("/v1/audit", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req, reply) => {
    const parsed = AuditQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "查询参数不合法", retryable: false });
    }
    return rt.audit.query({
      homeId: rt.config.homeId,
      from: parsed.data.from,
      to: parsed.data.to,
      entity: parsed.data.entity,
      traceId: parsed.data.trace_id,
      decision: parsed.data.decision,
      limit: parsed.data.limit,
    });
  });

  app.get("/v1/audit/:traceId", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req) => {
    const { traceId } = req.params as { traceId: string };
    return rt.audit.traceChain(rt.config.homeId, traceId);
  });

  /* ---------------- 工具层（M2）：MCP + 直连调试 ---------------- */

  /**
   * MCP over HTTP（JSON-RPC 2.0）。
   * 只接受 MCP 服务票据：这是 AI 侧唯一入口，与用户票据严格分离（§7.1）。
   */
  app.post("/mcp", { preHandler: requirePrincipal(rt.config, ["mcp"]) }, async (req, reply) => {
    const handler = createMcpHandler(rt.toolhub);
    const sessionId = req.headers["mcp-session-id"];
    const out = await handler(req.body, typeof sessionId === "string" ? sessionId : undefined);
    return reply.code(200).send(out);
  });

  /** 工具目录（面板"能力"页与运维排查用；同样只给 MCP 票据，避免把工具语义暴露给 UI） */
  app.get("/v1/tools", { preHandler: requirePrincipal(rt.config, ["mcp"]) }, async (req) => {
    const q = req.query as { session_id?: string; query?: string };
    const { tools, tokens } = await rt.toolhub.listToolsForSession(q.session_id, q.query);
    return {
      tools,
      tokens,
      limit: TOOL_SCHEMA_TOKEN_LIMIT,
      rooms: rt.toolhub.roomList,
      l1_count: L1_TOOLS.length,
      l2_count: L2_TOOLS.length,
    };
  });

  app.get("/v1/tools/search", { preHandler: requirePrincipal(rt.config, ["mcp"]) }, async (req, reply) => {
    const q = req.query as { q?: string; limit?: string };
    if (!q.q) return reply.code(400).send({ code: "BAD_REQUEST", message: "需要 q", retryable: false });
    const hits = rt.toolhub.searchTools(q.q, Number(q.limit ?? 8));
    return hits.map((h) => ({ name: h.tool.name, desc: h.tool.desc, tier: h.tool.tier, score: Math.round(h.score * 100) / 100 }));
  });

  /** 直接调用工具：M2 验收与本地调试用，语义与 MCP tools/call 完全一致 */
  app.post("/v1/tools/call", { preHandler: requirePrincipal(rt.config, ["mcp"]) }, async (req, reply) => {
    const body = req.body as { name?: string; args?: Record<string, unknown>; trace_id?: string; idempotency_key?: string };
    if (!body?.name) return reply.code(400).send({ code: "BAD_REQUEST", message: "需要 name", retryable: false });
    const result = await rt.toolhub.call({
      name: body.name,
      args: body.args ?? {},
      traceId: body.trace_id ?? app.newId("tr"),
      actor: "ai:hermes",
      idempotencyKey: body.idempotency_key,
    });
    return result;
  });

  app.get("/v1/tools/dead-letters", { preHandler: requirePrincipal(rt.config, ["user"]) }, async () => rt.toolhub.deadLetters());

  /* ---------------- 规则引擎（M3） ---------------- */

  app.get("/v1/automations", { preHandler: requirePrincipal(rt.config, ["user"]) }, async () => rt.rules.list());

  app.post("/v1/automations/:id/enable", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { on?: boolean };
    const on = body.on !== false;
    const found = rt.db.one<{ automation_id: string }>(
      "SELECT automation_id FROM automations WHERE home_id = ? AND automation_id = ?",
      rt.config.homeId, id,
    );
    if (!found) return reply.code(404).send({ code: "NOT_FOUND", message: `规则不存在: ${id}`, retryable: false });
    rt.db.run("UPDATE automations SET enabled = ? WHERE home_id = ? AND automation_id = ?", on ? 1 : 0, rt.config.homeId, id);
    return { ok: true, id, enabled: on };
  });

  /**
   * 规则编辑（设置中心的"自动化"分区用）。
   *
   * 只更新传进来的字段：前端改一个冷却时间，不该把 when/then 一起覆盖掉。
   * 更新后清空 last_fired_at —— 冷却期是相对"上次触发"算的，
   * 规则语义变了还沿用旧时间戳，会出现"刚改完却半天不生效"的怪现象。
   */
  app.patch("/v1/automations/:id", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = RuleUpdateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        code: "BAD_REQUEST",
        message: parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; "),
        retryable: false,
      });
    }

    const found = rt.db.one<{ automation_id: string }>(
      "SELECT automation_id FROM automations WHERE home_id = ? AND automation_id = ?",
      rt.config.homeId, id,
    );
    if (!found) return reply.code(404).send({ code: "NOT_FOUND", message: `规则不存在: ${id}`, retryable: false });

    const b = parsed.data;
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (b.enabled !== undefined) { sets.push("enabled = ?"); args.push(b.enabled ? 1 : 0); }
    if (b.when !== undefined) { sets.push("when_json = ?"); args.push(JSON.stringify(b.when)); }
    if (b.then !== undefined) { sets.push("then_json = ?"); args.push(JSON.stringify(b.then)); }
    if (b.cooldown_seconds !== undefined) { sets.push("cooldown_seconds = ?"); args.push(b.cooldown_seconds); }
    if (b.when !== undefined || b.then !== undefined) sets.push("last_fired_at = NULL");

    rt.db.run(`UPDATE automations SET ${sets.join(", ")} WHERE home_id = ? AND automation_id = ?`, ...args, rt.config.homeId, id);
    const updated = rt.rules.list().find((r) => r.id === id);
    return { ok: true, rule: updated };
  });

  /** 规则执行记录：回答"规则到底跑没跑、为什么没跑" */
  app.get("/v1/automations/history", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req) => {
    const q = req.query as { limit?: string };
    return rt.rules.history(Number(q.limit ?? 50));
  });

  /** 触发日志：被去抖/限流/防环挡掉的事件也在这里，是排查"自动化没反应"的第一站 */
  app.get("/v1/automations/triggers", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req) => {
    const q = req.query as { limit?: string; outcome?: string };
    const limit = Math.min(Number(q.limit ?? 100), 500);
    const where = ["home_id = ?"];
    const args: Array<string | number> = [rt.config.homeId];
    if (q.outcome) {
      where.push("outcome = ?");
      args.push(q.outcome);
    }
    args.push(limit);
    return rt.db.all(
      `SELECT entity_id, room, ts, outcome FROM trigger_log WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`,
      ...args,
    );
  });

  /* ---------------- 面板实时推送（M1） ---------------- */

  /**
   * GET /v1/events?rooms=客厅,书房
   * SSE 推送设备状态变化，供设备面板做"手动控制后状态实时回流"。
   * 与 §5.2 的分工一致：这条流只推设备事实，不推对话消息（对话走 Gateway 的 /v1/stream）。
   */
  app.get("/v1/events", { preHandler: requirePrincipal(rt.config, ["user"]) }, async (req, reply) => {
    const q = req.query as { rooms?: string };
    const filter = new Set((q.rooms ?? "").split(",").map((r) => r.trim()).filter(Boolean));

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    const write = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const off = rt.events.subscribe((event) => {
      if (filter.size > 0) {
        const room = rt.roomOf(event.entity_id);
        if (!room || !filter.has(room)) return;
      }
      write("device", event);
    });

    // 心跳：反向代理与浏览器都会在静默 60s 后断开空闲连接
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);

    const close = () => {
      clearInterval(ping);
      off();
    };
    req.raw.on("close", close);
    req.raw.on("error", close);
  });

  /* ---------------- 测试辅助（仅 mock 适配器 + HOMECLAW_DEBUG=1） ---------------- */

  if (rt.config.debug) {
  app.post("/_mock/inject-event", async (req, reply) => {
    if (rt.config.adapter !== "mock") {
      return reply.code(404).send({ code: "NOT_FOUND", message: "仅 mock 适配器支持", retryable: false });
    }
    const body = req.body as { entity_id?: string; value?: unknown; attribute?: string } | undefined;
    if (!body?.entity_id) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "需要 entity_id", retryable: false });
    }

    const mock = rt.adapter as unknown as {
      injectEvent(entityId: string, value: unknown, attribute?: string): unknown;
    };
    try {
      const event = mock.injectEvent(body.entity_id, body.value, body.attribute ?? "state");
      return { ok: true, event };
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "注入失败", retryable: false });
    }
  });

  app.post("/_mock/reset", async () => {
    rt.db.run("DELETE FROM audit");
    rt.db.run("DELETE FROM idempotency");
    rt.db.run("DELETE FROM trigger_log");
    rt.db.run("DELETE FROM rule_run");
    rt.db.run("DELETE FROM dead_letter");
    rt.db.run("UPDATE automations SET last_fired_at = NULL");
    rt.eventBus.reset();
    return { ok: true };
  });

  app.get("/_debug/eventbus", async () => ({
    enabled: rt.eventBus.isEnabled,
    pending: rt.eventBus.pendingCount,
  }));
  }
}
/**
 * 探测 L2 网关（§5.2 健康检查）。
 *
 * 两个约束：
 *  1. 必须有超时 —— 网关挂死时诊断页不能跟着挂死；
 *  2. 任何异常都归为 down，不能让 /v1/health 抛 500，
 *     否则客户端连"哪一层坏了"都拿不到。
 */
async function probeGateway(baseUrl: string): Promise<{
  status: "ok" | "down";
  component: { status: "ok" | "down"; detail: string; latency_ms?: number };
  llm: { status: "ok" | "disabled" | "down"; detail: string; latency_ms?: number };
}> {
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      llm?: { status?: string; detail?: string };
      gateway?: { status?: string; detail?: string };
    };
    const latency = Date.now() - started;

    // 网关自报 ok 才算 ok；它自己说 disabled 时保留语义，不要粉饰成 ok
    const gwStatus = body.gateway?.status === "ok" ? "ok" : "down";
    const llmStatus = body.llm?.status === "ok" ? "ok" : body.llm?.status === "disabled" ? "disabled" : "down";

    return {
      status: gwStatus,
      component: { status: gwStatus, detail: body.gateway?.detail ?? "SSE /v1/stream", latency_ms: latency },
      llm: {
        status: llmStatus,
        detail: body.llm?.detail ?? (llmStatus === "ok" ? "模型已连接" : "未配置模型"),
        latency_ms: latency,
      },
    };
  } catch (err) {
    return {
      status: "down",
      component: {
        status: "down",
        detail: `网关不可达（${baseUrl}）：${err instanceof Error ? err.message : String(err)}`,
      },
      llm: { status: "down", detail: "网关不可达，无法判断模型状态" },
    };
  }
}