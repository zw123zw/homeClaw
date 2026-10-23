import { z } from "zod";
import { Timestamp } from "./common.ts";

export const HealthComponentStatus = z.enum(["ok", "degraded", "down", "disabled"]);
export type HealthComponentStatus = z.infer<typeof HealthComponentStatus>;

export const HealthComponent = z.object({
  status: HealthComponentStatus,
  detail: z.string().optional(),
  latency_ms: z.number().nonnegative().optional(),
});
export type HealthComponent = z.infer<typeof HealthComponent>;

/** 启动自检：客户端首屏据此提示哪一层不可用 */
export const Health = z.object({
  ok: z.boolean(),
  version: z.string(),
  ts: Timestamp,
  adapter: HealthComponent,
  llm: HealthComponent,
  gateway: HealthComponent,
  db: HealthComponent.optional(),
  /**
   * L2 自己的两个能力段（可选）：
   *  - hermes：深度规划内核（可能未安装，属正常的降级状态）
   *  - tools：内置工具端口（文件/文档/联网）
   * 设为可选是为了兼容旧网关：缺字段时客户端显示 "-"，而不是渲染失败。
   */
  hermes: HealthComponent.optional(),
  tools: HealthComponent.optional(),
});
export type Health = z.infer<typeof Health>;
