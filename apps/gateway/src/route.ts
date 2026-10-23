/**
 * 路由：决定一次用户输入走哪条路径（ADR-0007）。
 *
 * 顺序是固定的：L0 直通 → Hermes（复杂任务）→ 自研循环（降级/简单问答）。
 *
 * 为什么判定用纯规则而不是"先问模型"：
 *  判错一次就多花一次模型调用，而这里要回答的问题很简单 —— "这句话是不是需要拆步骤"。
 *  规则判错的代价不对称：把复杂任务判成简单 → 模型自己也能多轮工具调用；
 *  把简单任务判成复杂 → 白起一个 Python 子进程。所以阈值必须保守。
 */

export type RouteKind = "l0" | "hermes" | "local";

export type RouteInput = {
  text: string;
  /**
   * L0 是否已确定命中。
   *
   * 由调用方先用 parseL0 判一次（它需要房间词典，route 本身不该关心数据源）。
   * 命中就必须走本地：这是"断网还能开灯"的那条路径，任何情况下都不能被
   * "复杂任务"判定抢走 —— 否则断网 + 有 venv 时，开灯反而会失败。
   */
  l0Hit?: boolean;
  /** 附件数量：带需要解析的文件基本都要多步 */
  attachmentCount: number;
  /** Hermes 是否就绪：不就绪时不存在 hermes 这个选项 */
  hermesReady: boolean;
  /** 用户显式要求深度思考（聊天框开关） */
  preferPlanning?: boolean;
  /** 设置里关掉 Hermes 后，即使就绪也不走 */
  hermesEnabled: boolean;
};

export type RouteDecision = {
  kind: RouteKind;
  /** 给日志/审计看的原因，用户不一定看得到 */
  reason: string;
};

/** 多步/规划信号：出现任意一个就认为需要拆步骤 */
const PLANNING_WORDS = [
  "帮我", "整理", "汇总", "总结一下", "批量", "然后", "接着", "之后", "再帮我",
  "分几步", "计划", "步骤", "做个方案", "写一份", "生成一份", "对比", "调研",
  "提取", "转换成", "翻译成", "重命名", "归档",
];

/** 单步动作词：用来判断"多个动作并列" */
const ACTION_WORDS = [
  "打开", "关闭", "调", "设", "查", "读", "写", "改", "删", "发", "下载", "上传",
  "搜索", "列表", "运行", "执行", "创建", "合并", "拆分", "导出",
];

export function decide(input: RouteInput): RouteDecision {
  const text = input.text.trim();

  // 空输入不该走到这里（schema 已拦），但兜底成自研循环比抛错好
  if (!text) return { kind: "local", reason: "空输入" };

  if (input.l0Hit) return { kind: "l0", reason: "L0 规则命中，直接执行" };

  if (!input.hermesEnabled) return { kind: "local", reason: "深度规划已在设置中关闭" };
  if (!input.hermesReady) return { kind: "local", reason: "Hermes 运行时未就绪，走降级路径" };
  if (input.preferPlanning) return { kind: "hermes", reason: "用户显式要求深度思考" };

  // 带附件：图片可以单轮理解，其他文件（PDF/Excel/Word）通常要解析+多步处理
  if (input.attachmentCount > 0) {
    return { kind: "hermes", reason: `带 ${input.attachmentCount} 个附件` };
  }

  const hit = PLANNING_WORDS.find((w) => text.includes(w));
  if (hit) return { kind: "hermes", reason: `命中规划词「${hit}」` };

  // 长句 + 多个动作：典型是"把 A 做了再把 B 做了"
  if (text.length > 60) {
    const actions = ACTION_WORDS.filter((w) => text.includes(w)).length;
    if (actions >= 2) return { kind: "hermes", reason: `长句含 ${actions} 个动作` };
  }

  return { kind: "local", reason: "简单单轮，走自研循环" };
}
