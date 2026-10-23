import Fastify from "fastify";
import cors from "@fastify/cors";
import type { ClientEnvelope, Envelope } from "@homeclaw/contracts";
import { ClientEnvelope as ClientEnvelopeSchema, PROTOCOL_VERSION, nowSeconds } from "@homeclaw/contracts";
import path from "node:path";
import { loadGatewayConfig, type GatewayConfig } from "./config.ts";
import { McpClient } from "./mcp-client.ts";
import { HubClient } from "./hub-client.ts";
import type { Llm } from "./llm.ts";
import { ModelRegistry, type ModelInput, type ModelProfile } from "./models.ts";
import { buildAttachmentPayload } from "./attachments.ts";
import { SessionStream } from "./stream.ts";
import { runAgent, toEnvelope, type RunEvent } from "./agent.ts";
import { HermesService } from "./hermes/index.ts";
import { HermesSettingsStore, toPublicSettings, type HermesSettings } from "./hermes/settings.ts";
import { createToolRegistry, type ToolRegistry } from "./tools/index.ts";
import { startToolMcpServer } from "./tools/mcp-server.ts";
import { LocalToolMcp, MultiMcp } from "./tools/mcp-adapter.ts";
import { decide as decideRoute } from "./route.ts";
import { parseL0, splitMulti } from "./l0.ts";
import crypto from "node:crypto";

/**
 * Gateway 服务（L2）。
 *
 * 对话接口只有三条（§5.1）：
 *   GET  /v1/stream       —— SSE 下发信封（客户端唯一的读通道）
 *   POST /v1/chat/message —— 收用户消息，触发一次 run
 *   POST /v1/chat/cancel  —— 取消进行中的 run
 * 另外提供配置类接口（模型 / Hermes / 技能 / 内置工具），它们不属于对话通道，
 * 但仍然只监听回环地址：这些接口里有 API key 与运行时路径。
 *
 * 一次 run 有三条执行路径（ADR-0007）：
 *   L0 规则直通 → Hermes（深度规划）→ 自研薄循环（降级）
 * 三条路径共用同一套 RunEvent 与 SSE 信封，客户端不需要知道走的是哪条。
 */
export type GatewayDeps = {
  config?: GatewayConfig;
  llm?: Llm;
  /** 模型注册表：测试可注入，默认读 data/gateway-settings.json */
  models?: ModelRegistry;
  mcp?: McpClient;
  hub?: HubClient;
  /** 测试用：把 run 缩短，避免 CI 等 2 分钟 */
  runTimeoutMs?: number;
  /** Hermes 接入服务：测试可注入 */
  hermes?: HermesService;
  /** 内置工具注册表：测试可注入 */
  tools?: ToolRegistry;
  /** 测试用：不启动本地工具 MCP 端口 */
  startToolMcp?: boolean;
};

type ActiveRun = {
  controller: AbortController;
  startedAt: number;
  userMsgId: string;
};

export async function buildGateway(deps: GatewayDeps = {}) {
  const config = deps.config ?? loadGatewayConfig();
  // 模型配置完全由用户维护：不读环境变量生成"影子模型"，否则设置页会出现用户没添加过的条目
  const models = deps.models ?? new ModelRegistry({ file: config.modelsFile });
  /** 注入的 llm 优先（测试用）；否则按 active 模型解析 */
  const resolveLlm = (id?: string): Llm => deps.llm ?? models.build(id);
  const mcp = deps.mcp ?? new McpClient({ baseUrl: config.hub.baseUrl, token: config.hub.mcpToken });
  const hub = deps.hub ?? new HubClient({
    baseUrl: config.hub.baseUrl,
    token: config.hub.userToken,
    mcpToken: config.hub.mcpToken,
  });

  /**
   * Hermes 接入层（ADR-0006）：探测 venv、生成 HERMES_HOME/config.yaml、跑子进程。
   * 它自己不做降级 —— 降级决策留在 chat 路由里，否则"这次到底走的哪条路"查不清。
   */
  const hermes =
    deps.hermes ??
    new HermesService({
      repoRoot: config.repoRoot,
      settings: new HermesSettingsStore({ file: path.resolve(config.repoRoot, "data/hermes-settings.json") }),
    });

  /**
   * 内置工具表：两条执行路径共用（自研循环与 Hermes 都经本地 MCP 调它）。
   * workspaceRoot 传函数而不是常量 —— 设置里改工作目录后必须立刻生效。
   */
  const tools =
    deps.tools ??
    createToolRegistry({
      workspaceRoot: () => path.resolve(config.repoRoot, hermes.settings.workspaceRoot),
      llm: () => (models.activeId ? models.build() : undefined),
    });

  /**
   * 本地工具 MCP 票据：每次进程启动随机生成。
   * 不落盘、不跨进程复用 —— 它只用于"本进程起的 MCP 端口"这一件事，
   * 持久化只会扩大泄露面（任何读到配置文件的程序都能调工具）。
   */
  const localToolToken = crypto.randomBytes(16).toString("hex");

  /**
   * 工具箱：本地内置工具 + HomeHub ToolHub。
   *
   * 自研循环用它（进程内直调本地工具，不再绕 HTTP）；
   * Hermes 走真实 MCP 端口（config.yaml 里的 mcp.servers）—— 两条路径看到同一批工具。
   */
  const toolbox = new MultiMcp(mcp, new LocalToolMcp(tools));

  const stream = new SessionStream();
  /** session_id → 正在跑的 run。同一会话串行，不同会话可并行。 */
  const active = new Map<string, ActiveRun>();
  /** 房间词典缓存：20 秒过期，避免每次 run 都打一次 /v1/entities */
  let roomsCache: { at: number; rooms: string[] } = { at: 0, rooms: [] };

  const rooms = async (): Promise<string[]> => {
    if (Date.now() - roomsCache.at < 20_000 && roomsCache.rooms.length) return roomsCache.rooms;
    try {
      const list = await hub.entities();
      roomsCache = { at: Date.now(), rooms: [...new Set(list.map((e) => e.room))] };
    } catch {
      // HomeHub 不可用时不能把房间清空：空词典会让 L0 全部失效，降级成"只能走模型"
      if (!roomsCache.rooms.length) roomsCache = { at: Date.now(), rooms: ["客厅", "主卧", "书房"] };
    }
    return roomsCache.rooms;
  };

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });
  /**
   * 空 body 的容错。
   *
   * 真实事故：客户端对 DELETE /v1/models/:id、POST /v1/models/:id/test 这类
   * "没有 body 的写请求"也带上了 Content-Type: application/json（统一请求头最容易这么做），
   * Fastify 内置 json 解析器于是抛 FST_ERR_CTP_EMPTY_JSON_BODY → 400。
   * 用户看到的是"删除模型报错"，但配置本身完全正常。
   *
   * 处理：空字符串当 undefined 收下，由各路由自己决定要不要 body。
   * 这不是放松校验 —— 非法 JSON 仍然会在 parse 阶段报 400。
   */
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const raw = typeof body === "string" ? body.trim() : "";
    if (!raw) return done(null, undefined);
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(Object.assign(new Error("请求体不是合法 JSON"), { statusCode: 400, code: "BAD_JSON" }), undefined);
    }
  });
  // 其余 content-type（如 text/plain、缺失 content-type）一律按原始字符串收下
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

  /* ---------------- 本地工具 MCP（Hermes 与自研循环共用） ---------------- */

  /**
   * 为什么起一个真实的 MCP 端口而不是"内部直调函数"：
   * Hermes 是 Python 子进程，跨语言唯一稳定接触面就是协议。这里起一个只监听回环、
   * 带随机票据的 MCP 服务，Hermes 通过 config.yaml 里的 mcp.servers 连进来，
   * 和连 HomeHub ToolHub 完全同构 —— 不需要为"内置工具"写第二套接入代码。
   */
  let localMcp: { url: string; close: () => Promise<void> } | null = null;
  if (deps.startToolMcp !== false) {
    try {
      localMcp = await startToolMcpServer({
        registry: tools,
        token: localToolToken,
        port: Number(process.env.TOOL_MCP_PORT ?? 4031),
        onCall: (info) => app.log.debug(info, "local tool call"),
      });
    } catch (err) {
      // 端口被占（比如开了两个网关）不该让整个服务起不来：Hermes 会连不上内置工具，
      // 但设备控制与自研循环仍然可用。降级要显式记录，不能静默。
      app.log.warn({ err }, "本地工具 MCP 端口启动失败，内置工具对 Hermes 不可见");
    }
  }
  app.addHook("onClose", async () => {
    await localMcp?.close();
  });

  /** 把 HomeHub ToolHub 与本地工具注册进 Hermes 的 MCP 列表（只在首次补齐，不覆盖用户配置） */
  hermes.bootstrap({
    homeHubUrl: config.hub.baseUrl,
    homeHubToken: config.hub.mcpToken,
    ...(localMcp ? { localMcpUrl: localMcp.url, localMcpToken: localToolToken } : {}),
  });

  app.get("/v1/health", async () => {
    const active = models.describe();
    let hubOk = true;
    try {
      await mcp.listTools({});
    } catch {
      hubOk = false;
    }
    return {
      ok: hubOk,
      version: "gateway-0.2.0",
      ts: nowSeconds(),
      adapter: { status: hubOk ? "ok" : "down", detail: hubOk ? "HomeHub ToolHub 可达" : "HomeHub 不可达" },
      llm: {
        status: active.connected ? "ok" : "disabled",
        detail: active.connected ? `${active.name} · ${active.model}` : "未配置模型，走离线规则引擎",
      },
      gateway: { status: "ok", detail: "SSE /v1/stream" },
      db: { status: "disabled", detail: "会话落 HomeHub，Gateway 无本地库" },
      ...(() => {
        // 只探测一次：三次 probe 之间文件状态理论上可能变化，会给出自相矛盾的健康报告
        const rt = hermes.probe();
        return {
          hermes: {
            // 健康检查的词表是 ok/degraded/down/disabled，未安装属于"未启用"，不是故障
            status: rt.status === "ready" ? "ok" : hermes.settings.enabled ? "degraded" : "disabled",
            detail: rt.detail,
            source: rt.source,
          },
          tools: {
            status: localMcp ? "ok" : "down",
            detail: localMcp ? `${tools.list().length} 个内置工具` : "本地工具端口未启动",
          },
        };
      })(),
    };
  });

  /* ---------------- 内核设置（Hermes） ---------------- */

  /**
   * 读写 Hermes 接入设置。放在 /v1/hermes 下而不是混进 /v1/models：
   * 两者改动频率差一个数量级（模型天天改，运行时装一次就不动），
   * 混在一个 PUT 里迟早出现"改模型把 venv 路径改没了"。
   */
  // 票据打码：MCP token 与模型 apiKey 同级，任何 GET 都不回传明文
  app.get("/v1/hermes/settings", async () => ({ ...toPublicSettings(hermes.settings), status: hermes.status() }));

  app.put("/v1/hermes/settings", async (req, reply) => {
    const body = (req.body ?? {}) as Partial<HermesSettings>;
    // 只允许白名单键：多传的字段静默丢弃，避免用户配置里攒出无效键
    const patch: Partial<HermesSettings> = {
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(typeof body.runtimeDir === "string" ? { runtimeDir: body.runtimeDir } : {}),
      ...(typeof body.launcher === "string" ? { launcher: body.launcher } : {}),
      ...(Array.isArray(body.args) ? { args: body.args.filter((x): x is string => typeof x === "string") } : {}),
      ...(body.protocol === "ndjson" || body.protocol === "text" ? { protocol: body.protocol } : {}),
      ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
      ...(typeof body.workspaceRoot === "string" ? { workspaceRoot: body.workspaceRoot } : {}),
      ...(typeof body.allowShell === "boolean" ? { allowShell: body.allowShell } : {}),
      ...(Array.isArray(body.mcpServers) ? { mcpServers: body.mcpServers as HermesSettings["mcpServers"] } : {}),
    };

    // 工作目录必须能被创建且在仓库内：写进设置后才报错，用户会以为"保存成功了"
    if (patch.workspaceRoot) {
      try {
        const abs = path.resolve(config.repoRoot, patch.workspaceRoot);
        const rel = path.relative(config.repoRoot, abs);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
          return reply.code(400).send({ code: "BAD_REQUEST", message: "工作目录必须位于应用目录内", retryable: false });
        }
      } catch {
        return reply.code(400).send({ code: "BAD_REQUEST", message: "工作目录路径不合法", retryable: false });
      }
    }

    const next = hermes.updateSettings(patch);
    // 设置一变就同步 config.yaml：否则用户看到"已保存"，但 Hermes 下次运行还用旧配置
    let synced: string | null = null;
    try {
      synced = hermes.syncConfig(models.active()).file;
    } catch (err) {
      app.log.warn({ err }, "同步 HERMES_HOME/config.yaml 失败");
    }
    return { ...toPublicSettings(next), status: hermes.status(), ...(synced ? { config_file: synced } : {}) };
  });

  app.get("/v1/hermes/status", async () => hermes.status());

  /** 测试连接：真起一次子进程。只探文件存在性会给出"就绪但其实跑不起来"的假阳性 */
  app.post("/v1/hermes/test", async () => hermes.probeRun());

  /** 技能清单：Hermes 原生 skill 目录的只读视图 */
  app.get("/v1/skills", async () => ({
    skills: hermes.skills().map((k) => ({ name: k.name, description: k.description })),
    home: hermes.home(),
  }));

  /**
   * AI 记住的偏好（只读视图）。
   *
   * 为什么网关也暴露一份：设置页要展示"AI 现在记得什么"，
   * 而这一页不该再引一个 HomeHub 的登录态。写操作仍走 HomeHub（用户票据），
   * 网关不做写代理 —— 否则"谁能改记忆"就有了两个入口。
   */
  app.get("/v1/memory", async () => ({ items: Object.entries(await hub.preferences()).map(([key, value]) => ({ key, value })) }));

  /** 内置工具清单：设置页展示"这个客户端自己能干什么"，与模型是否配置无关 */
  app.get("/v1/tools", async () => ({
    tools: tools.describe().map((t) => ({ name: t.name, description: t.description })),
    local_mcp: localMcp?.url ?? null,
  }));

  /* ---------------- 模型配置（§0.3.2） ---------------- */

  app.get("/v1/models", async () => models.list());

  app.post("/v1/models", async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    const label = typeof body?.label === "string" ? body.label : "";
    const input = normalizeModelInput(body);
    if (!input.name.trim()) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "需要名称", retryable: false });
    }
    if (!input.baseUrl?.trim() || !input.model?.trim() || !input.apiKey?.trim()) {
      return reply.code(400).send({
        code: "BAD_REQUEST",
        message: "Base URL、模型 ID、API Key 都不能为空",
        retryable: false,
      });
    }
    return reply.code(201).send(models.create({ ...input, name: input.name }));
  });

  app.put("/v1/models/active", async (req, reply) => {
    const body = req.body as { id?: string } | undefined;
    if (!body?.id || !models.setActive(body.id)) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "模型不存在", retryable: false });
    }
    return { ok: true, active_id: models.activeId };
  });

  app.put("/v1/models/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = normalizeModelInput(req.body as Record<string, unknown> | undefined);
    // 部分更新：name 没传就不改，所以这里先剔掉空字符串
    const { name, ...patch } = input;
    const updated = models.update(id, { ...patch, ...(name.trim() ? { name } : {}) });
    if (!updated) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "模型不存在", retryable: false });
    }
    return updated;
  });

  app.delete("/v1/models/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!models.remove(id)) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "模型不存在", retryable: false });
    }
    return { ok: true };
  });

  app.post("/v1/models/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const profile = models.get(id);
    if (!profile) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "模型不存在", retryable: false });
    }
    if (!profile.apiKey) {
      return { ok: false, latency_ms: 0, message: "未配置 API key" };
    }

    const started = performance.now();
    try {
      // 测试按配置的真实协议构造实例，和实际对话链路一致；测通了才允许设为当前
      const probe = models.build(id);
      const turn = await probe.chat({
        messages: [{ role: "user", content: "回复 OK 两个字母即可。" }],
        tools: [],
        maxTokens: 16,
      });
      const latency = Math.round(performance.now() - started);
      return { ok: turn.kind === "text", latency_ms: latency, message: turn.kind === "text" ? "连接正常" : "返回格式异常" };
    } catch (err) {
      return reply.code(200).send({
        ok: false,
        latency_ms: Math.round(performance.now() - started),
        message: err instanceof Error ? err.message.slice(0, 200) : "连接失败",
      });
    }
  });

  /* ---------------- SSE 读通道 ---------------- */

  app.get("/v1/stream", async (req, reply) => {
    const q = req.query as { session_id?: string; last_seq?: string };
    const sessionId = q.session_id;
    const lastSeq = Number(q.last_seq ?? 0);

    if (!sessionId) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "需要 session_id", retryable: false });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const write = (env: Envelope) => {
      reply.raw.write(`event: envelope\ndata: ${JSON.stringify(env)}\n\n`);
    };

    // 1) 先补历史缺口：客户端带 last_seq 重连时，把断线期间的信封补齐
    for (const entry of stream.since(sessionId, lastSeq)) write(entry.env);

    // 2) ready 信封：告诉客户端服务端已有的最大 log_seq
    write({
      v: PROTOCOL_VERSION,
      type: "session.ready",
      id: `ready_${Date.now().toString(36)}`,
      session_id: sessionId,
      ts: nowSeconds(),
      log_seq: stream.lastSeq(sessionId),
      payload: { session_id: sessionId, last_seq: stream.lastSeq(sessionId) },
    } as Envelope);

    // 3) 订阅后续信封
    const off = stream.subscribe(sessionId, (entry) => write(entry.env));
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);

    const close = () => {
      clearInterval(ping);
      off();
    };
    req.raw.on("close", close);
    req.raw.on("error", close);
  });

  /* ---------------- 上行：发消息 ---------------- */

  app.post("/v1/chat/message", async (req, reply) => {
    const parsed = ClientEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "信封不合法", retryable: false, detail: parsed.error.issues });
    }

    const env = parsed.data as ClientEnvelope;
    if (env.type !== "user.message") {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "该接口只接受 user.message", retryable: false });
    }

    const sessionId = env.session_id ?? "";
    if (!sessionId) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "需要 session_id", retryable: false });
    }

    // 同一会话串行：并发 run 会让消息 seq 交错，客户端拼不回去
    if (active.has(sessionId)) {
      return reply.code(409).send({ code: "CONFLICT", message: "该会话正在生成中，请先取消或等待", retryable: true });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deps.runTimeoutMs ?? config.runTimeoutMs);
    active.set(sessionId, { controller, startedAt: Date.now(), userMsgId: env.id });

    // 先把用户消息回显并落库，客户端立刻能看到自己的输入（乐观 UI 的服务端确认）
    const userEnvelope: Envelope = {
      v: PROTOCOL_VERSION,
      type: "user.message",
      id: env.id,
      session_id: sessionId,
      ts: env.ts ?? nowSeconds(),
      payload: { text: env.payload.text, attachments: env.payload.attachments },
    };
    stream.append(sessionId, userEnvelope);

    void (async () => {
      const replyId = `a_${env.id}`;
      /**
       * 落库策略：一轮 run 只写「一条用户消息 + 一条 assistant 消息」。
       * 分片是传输单位，不是存储单位 —— 每片写一行会撞 message_id 唯一索引，
       * 历史里 AI 回复就只剩第一句。工具卡按 tool.start 落一行，result 用 PATCH 回填。
       */
      const assistantId = `${replyId}_msg`;
      let assistantText = "";
      let assistantPersisted = false;
      const toolIds = new Map<string, string>();

      const flushAssistant = async (force = false) => {
        if (!assistantText.trim() && !force) return;
        try {
          await hub.appendMessage({
            session_id: sessionId,
            id: assistantId,
            role: "assistant",
            text: assistantText,
          });
          assistantPersisted = true;
        } catch (err) {
          app.log.warn({ err }, "assistant 落库失败");
        }
      };

      const persistEvent = async (e: RunEvent) => {
        try {
          if (e.type === "delta") {
            assistantText += e.text;
            return;
          }
          if (e.type === "tool.start") {
            toolIds.set(e.id, e.id);
            await hub.appendMessage({
              session_id: sessionId,
              id: e.id,
              role: "tool",
              text: e.summary ?? "",
              tool: { name: e.tool, args: e.args },
            });
            return;
          }
          if (e.type === "tool.result") {
            if (toolIds.has(e.id)) {
              await hub.updateTool(sessionId, e.id, { ok: e.ok, elapsed_ms: e.elapsed_ms });
            }
            return;
          }
          if (e.type === "error") {
            assistantText += `\n\n> 错误：${e.message}`;
          }
        } catch (err) {
          // 落库失败不能让对话中断：用户看到的答复比历史完整更重要
          app.log.warn({ err }, "消息落库失败");
        }
      };

      try {
        await hub.ensureSession(sessionId);

        /**
         * 用户消息落库：失败不中断本轮。
         *
         * 真实场景：HomeHub 短暂抖动、或客户端重发同一信封导致主键冲突。
         * 这两种情况下"回答用户"仍然可做；把它当致命错误会让一次数据库抖动
         * 直接变成一条 INTERNAL 错误，用户连自己发的消息都看不到回复。
         */
        try {
          await hub.appendMessage({
            session_id: sessionId,
            id: env.id,
            role: "user",
            text: env.payload.text,
            attachments: env.payload.attachments,
          });
        } catch (err) {
          app.log.warn({ err }, "用户消息落库失败，继续本轮");
        }

        // 附件先转成模型输入（图片 → data URL，文本 → 截断拼接）
        const attachmentPayload = await buildAttachmentPayload(env.payload.attachments, { hub });

        /**
         * 统一的下发口：三条路径（L0 / Hermes / 自研循环）都用它，
         * 保证信封形状、落库策略、done 帧完全一致 —— 客户端因此不需要知道走的是哪条路。
         */
        const emit = (e: RunEvent) => {
          const out = toEnvelope(e, { sessionId, userMsgId: env.id, replyId });
          if (out) {
            stream.append(sessionId, out);
            void persistEvent(e);
            return;
          }
          // done 事件也要让客户端知道：单独发一条带 done=true 的空 delta
          const done: Envelope = {
            v: PROTOCOL_VERSION,
            type: "assistant.delta",
            id: replyId,
            session_id: sessionId,
            reply_to: env.id,
            seq: 9999,
            ts: nowSeconds(),
            payload: { text: "", done: true, attachments: [] },
          };
          stream.append(sessionId, done);
          void flushAssistant(true);
        };

        /* ---------- 路由（ADR-0007）：L0 → Hermes → 自研循环 ---------- */

        // L0 需要房间词典，所以先在这里判一次；真正的执行仍在自研循环里（唯一实现）
        const roomList = await rooms();
        const l0Texts = splitMulti(env.payload.text);
        const l0Hit = l0Texts.length > 0 && l0Texts.every((t) => parseL0(t, roomList) !== null);

        const route = decideRoute({
          text: env.payload.text,
          attachmentCount: env.payload.attachments.length,
          hermesReady: hermes.probe().status === "ready",
          hermesEnabled: hermes.settings.enabled,
          l0Hit,
          ...(env.payload.prefer_planning !== undefined ? { preferPlanning: env.payload.prefer_planning } : {}),
        });
        app.log.info({ session: sessionId, route: route.kind, reason: route.reason }, "run route");

        const plan: ModelProfile | undefined = env.payload.model_id ? models.get(env.payload.model_id) : models.active();

        let wentHermes = false;
        if (route.kind === "hermes") {
          let deltas = 0;
          const hermesRes = await hermes.run({
            prompt: withInstructions(
              promptText(env.payload.text, attachmentPayload.summary),
              await hub.preferences(),
              hermes.skills(),
            ),
            ...(plan ? { model: plan } : {}),
            signal: controller.signal,
            suppressError: true,
            emit: (e) => {
              if (e.type === "delta") deltas += 1;
              emit(e);
            },
          });

          if (hermesRes.ok) {
            wentHermes = true;
          } else if (deltas > 0) {
            /**
             * 已经吐了一半再换路径，会把两段不相干的答案拼在一起。
             * 这里如实收尾：保留已产出的内容，并说明没走完。
             */
            wentHermes = true;
            const note = `\n\n（深度规划未跑完：${hermesRes.reason ?? "已中断"}。可以让我接着做。）`;
            emit({ type: "delta", text: note, seq: 9998 });
            emit({ type: "done" });
          } else {
            // 一个 delta 都没产出：静默回落到自研循环，用户看不到"报错后又成功"
            app.log.warn({ session: sessionId, reason: hermesRes.reason }, "Hermes 未产出内容，回落自研循环");
          }
        }

        if (!wentHermes) {
          await runAgent({
            sessionId,
            userText: env.payload.text,
            userContent: attachmentPayload.content || env.payload.text,
            userMsgId: env.id,
            llm: resolveLlm(env.payload.model_id),
            mcp: toolbox,
            rooms,
            // 用户偏好（记忆）：读不到就是空对象，不阻断对话
            preferences: await hub.preferences(),
            signal: controller.signal,
            emit,
          });
        }
        if (!assistantPersisted) await flushAssistant(true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stream.append(sessionId, {
          v: PROTOCOL_VERSION,
          type: "error",
          id: `err_${Date.now().toString(36)}`,
          session_id: sessionId,
          ts: nowSeconds(),
          payload: { code: "INTERNAL", message, retryable: true, reply_to: env.id },
        });
        assistantText += `\n\n> 错误：${message}`;
        await flushAssistant(true);
      } finally {
        clearTimeout(timeout);
        active.delete(sessionId);
      }
    })();

    return reply.code(202).send({ ok: true, session_id: sessionId, accepted: env.id });
  });

  /* ---------------- 上行：取消 ---------------- */

  app.post("/v1/chat/cancel", async (req, reply) => {
    const body = req.body as { session_id?: string; payload?: { target?: string } } | undefined;
    const sessionId = body?.session_id;

    if (!sessionId) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "需要 session_id", retryable: false });
    }

    const run = active.get(sessionId);
    if (!run) {
      // 取消一个不存在的 run 不是错误：客户端断线重连后可能重复发取消
      return { ok: true, cancelled: false, reason: "no active run" };
    }

    run.controller.abort();
    active.delete(sessionId);

    stream.append(sessionId, {
      v: PROTOCOL_VERSION,
      type: "assistant.delta",
      id: `a_${run.userMsgId}`,
      session_id: sessionId,
      reply_to: run.userMsgId,
      seq: 9999,
      ts: nowSeconds(),
      payload: { text: "", done: true, attachments: [] },
    });

    return { ok: true, cancelled: true, elapsed_ms: Date.now() - run.startedAt };
  });

  /* ---------------- 可观测 ---------------- */

  // 与 HomeHub 同一套开关：调试接口默认不挂载（HOMECLAW_DEBUG=1 才开）
  if (config.debug) {
    app.get("/v1/_debug/streams", async () => ({
      sessions: [...active.keys()].map((s) => ({ session_id: s, subscribers: stream.subscriberCount(s) })),
      active: active.size,
      llm: models.describe(),
    }));
  }

  return app;
}

/**
 * 只接受白名单字段：多余字段（如 id / has_key）一律丢弃。
 * 没传的字段不补默认值 —— PUT 是部分更新语义，补默认会把用户的其余配置清掉。
 */
function normalizeModelInput(body: Record<string, unknown> | undefined): ModelInput {
  const b = body ?? {};
  return {
    name: typeof b.name === "string" ? b.name : "",
    ...(typeof b.baseUrl === "string" ? { baseUrl: b.baseUrl } : {}),
    ...(typeof b.model === "string" ? { model: b.model } : {}),
    ...(typeof b.apiKey === "string" && b.apiKey ? { apiKey: b.apiKey } : {}),
    ...(typeof b.wireApi === "string" ? { wireApi: b.wireApi as ModelInput["wireApi"] } : {}),
    ...(typeof b.reasoningEffort === "string" ? { reasoningEffort: b.reasoningEffort as ModelInput["reasoningEffort"] } : {}),
    ...(typeof b.contextWindow === "number" ? { contextWindow: b.contextWindow } : {}),
    ...(typeof b.disableResponseStorage === "boolean" ? { disableResponseStorage: b.disableResponseStorage } : {}),
  };
}

/**
 * 给 Hermes 的输入补上"用户偏好 + 可用技能"。
 *
 * 为什么不把这两段写进 HERMES_HOME/config.yaml 的 system prompt：
 * 偏好是用户随时会改的数据，技能是随目录变化的数据。写进配置文件就成了
 * "改了偏好要重启内核"，而且两份真源必然对不上。每次 run 现拼最省事。
 *
 * 技能清单只给名字与一句话：模型据此决定"要不要读某个技能"，
 * 把 SKILL.md 全文塞进来会吃掉大量上下文。
 */
function withInstructions(base: string, prefs: Record<string, string>, skills: { name: string; description: string }[]): string {
  const parts = [base];
  const prefLines = Object.entries(prefs).map(([k, v]) => `- ${k}: ${v}`);
  if (prefLines.length) parts.push(`用户偏好：\n${prefLines.join("\n")}`);
  if (skills.length) parts.push(`可用技能：\n${skills.map((s) => `- ${s.name}：${s.description}`).join("\n")}`);
  return parts.join("\n\n");
}

/**
 * Hermes 只收纯文本 prompt，所以附件摘要要拼进输入。
 *
 * 拼在原文之后而不是之前：模型的注意力更容易被开头带走，
 * 用户的真实意图必须排在最前面，附件信息只是补充。
 */
function promptText(text: string, attachmentSummary: string): string {
  const t = text.trim();
  if (!attachmentSummary.trim()) return t || "（用户只发送了附件，请先看清附件内容再回答）";
  return `${t || "请处理这些附件"}

附带的附件信息：
${attachmentSummary}`;
}

/** 同 homehub：打包产物是 .mjs，用 HOMECLAW_STANDALONE=1 启动 */
const isMain =
  process.env.HOMECLAW_STANDALONE === "1" ||
  Boolean(process.argv[1]?.replace(/\\/g, "/").endsWith("src/server.ts"));
if (isMain) {
  const config = loadGatewayConfig();
  buildGateway({ config })
    .then((app) => app.listen({ port: config.port, host: config.host }))
    .then((addr) => console.log(`[gateway] listening on ${addr} (llm=${config.llm.provider})`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}