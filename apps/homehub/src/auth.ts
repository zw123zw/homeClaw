import type { FastifyReply, FastifyRequest } from "fastify";
import type { HubConfig } from "./config.ts";

export type Principal = "user" | "mcp" | "internal";

/**
 * 两套凭据，权限不同，不可混用（§5.2）：
 *  - 用户票据：只能读面板/场景/会话、手动控制设备
 *  - MCP 票据：只能调用工具，不能读写会话
 * 用 principal 而不是布尔值，是为了将来加第三种调用方时不改接口。
 */
export function authenticate(config: HubConfig, req: FastifyRequest): Principal | null {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (token && token === config.mcpToken) return "mcp";
  if (token && token === config.userToken) return "user";
  // 内部调用（场景执行、规则引擎）走 in-process，不经 HTTP
  return null;
}

export function requirePrincipal(
  config: HubConfig,
  required: Principal[],
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    const p = authenticate(config, req);
    if (!p) {
      return reply.code(401).send({ code: "UNAUTHORIZED", message: "缺少或无效的凭据", retryable: false });
    }
    if (!required.includes(p) && p !== "internal") {
      return reply.code(403).send({ code: "FORBIDDEN", message: `该凭据不能访问此接口（需要 ${required.join("/")}）`, retryable: false });
    }
  };
}