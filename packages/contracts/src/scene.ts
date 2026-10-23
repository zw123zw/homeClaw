import { z } from "zod";
import { Id, RoomId, Timestamp } from "./common.ts";

export const SceneAction = z.object({
  action: z.literal("entity.command"),
  entity: Id,
  service: z.string().min(1),
  data: z.record(z.unknown()).default({}),
  delay_ms: z.number().int().nonnegative().optional(),
});
export type SceneAction = z.infer<typeof SceneAction>;

export const Scene = z.object({
  id: Id,
  home_id: Id,
  name: z.string().min(1),
  room: RoomId.optional(),
  icon: z.string().optional(),
  actions: z.array(SceneAction).default([]),
});
export type Scene = z.infer<typeof Scene>;

export const SceneRunResult = z.object({
  ok: z.boolean(),
  trace_id: Id,
  results: z.array(
    z.object({
      entity: Id,
      service: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      elapsed_ms: z.number().nonnegative(),
    }),
  ),
});
export type SceneRunResult = z.infer<typeof SceneRunResult>;
