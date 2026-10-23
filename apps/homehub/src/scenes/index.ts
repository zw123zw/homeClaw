import type { Scene } from "@homeclaw/contracts";
import type { CommandPipeline } from "../command.ts";

/**
 * 场景执行器。
 *
 * 为什么单独抽出来：场景有三个调用方 —— HTTP 路由（面板一键执行）、
 * ToolHub（run_scene 工具）、规则引擎（then: scene.run）。
 * 三处各写一遍是最典型的漂移源：一处加了 delay、另一处忘了，
 * 用户就会看到"点按钮和让 AI 执行结果不一样"。
 */
export type SceneRunOutcome = {
  ok: boolean;
  traceId: string;
  results: Array<{ entity: string; service: string; ok: boolean; error?: string; elapsed_ms: number }>;
};

export function createSceneRunner(deps: {
  scenes: () => Scene[];
  pipeline: CommandPipeline;
}): (sceneIdOrName: string, traceId: string, actor: string) => Promise<SceneRunOutcome> {
  return async (sceneIdOrName, traceId, actor) => {
    const all = deps.scenes();
    const scene =
      all.find((s) => s.id === sceneIdOrName) ??
      all.find((s) => s.name === sceneIdOrName) ??
      all.find((s) => s.name.includes(sceneIdOrName) || sceneIdOrName.includes(s.name));

    if (!scene) {
      return { ok: false, traceId, results: [] };
    }

    const results: SceneRunOutcome["results"] = [];

    // 动作串行执行：后一个动作常依赖前一个的状态（先关灯再关窗帘）
    for (const action of scene.actions) {
      if (action.delay_ms) await new Promise((r) => setTimeout(r, action.delay_ms));

      const outcome = await deps.pipeline.execute({
        entityId: action.entity,
        service: action.service,
        data: action.data,
        origin: actor.startsWith("rule:") ? "rule" : actor.startsWith("ai:") ? "ai" : "user",
        actor,
        traceId,
      });

      results.push({
        entity: action.entity,
        service: action.service,
        ok: outcome.ok,
        error: outcome.ok ? undefined : outcome.message,
        elapsed_ms: outcome.ok ? outcome.elapsedMs : 0,
      });
    }

    return { ok: results.every((r) => r.ok), traceId, results };
  };
}