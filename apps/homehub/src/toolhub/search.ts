import type { ToolSpec } from "./spec.ts";

/**
 * 工具检索（§4.2 L2）。
 *
 * 为什么是"关键词命中 + 字符 bigram BM25"而不是纯 embedding：
 *  1. 一期没有 embedding 服务，也不能起子进程去调模型；
 *  2. 中文家居指令的关键信息是**词**（扫地机、晾衣架、静音），不是语义向量；
 *  3. BM25 完全确定，同一查询永远同一结果 —— 评测集才能当回归门禁用。
 * 二期接 embedding 时，只需在 score() 里做加权融合，接口不变。
 */

type Doc = {
  tool: ToolSpec;
  /** 参与打分的词元：中文 bigram + 英文整词 */
  tokens: string[];
  /** 原始关键词，用于精确短语命中加分 */
  keywords: string[];
  length: number;
};

/** 中文没有空格，用 bigram 代替分词：不依赖词典，召回稳定 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();

  // 英文 / 数字整词
  for (const m of lower.matchAll(/[a-z][a-z0-9_.]+/g)) out.push(m[0]);

  // 中文连续片段 → 单字 + bigram（单字保证"灯"这种短词能命中）
  for (const m of lower.matchAll(/[\u3400-\u9fff]+/g)) {
    const s = m[0];
    for (let i = 0; i < s.length; i++) {
      out.push(s[i]!);
      if (i + 1 < s.length) out.push(s.slice(i, i + 2));
    }
  }
  return out;
}

export class ToolSearchIndex {
  private docs: Doc[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;

  constructor(tools: readonly ToolSpec[]) {
    this.docs = tools.map((tool) => {
      // 描述 + 关键词 + 工具名一起进索引：名字里的 set_room_light 也是信号
      const text = [tool.name.replace(/_/g, " "), tool.desc, ...(tool.keywords ?? [])].join(" ");
      const tokens = tokenize(text);
      return { tool, tokens, keywords: tool.keywords ?? [], length: tokens.length || 1 };
    });

    const df = new Map<string, number>();
    for (const d of this.docs) {
      for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    this.df = df;
    this.avgLen = this.docs.reduce((a, d) => a + d.length, 0) / (this.docs.length || 1);
  }

  get size(): number {
    return this.docs.length;
  }

  /** 返回按相关度降序的工具，最多 limit 个；分数为 0 的不返回 */
  search(query: string, limit = 8, tier?: "L1" | "L2"): Array<{ tool: ToolSpec; score: number }> {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];

    const qUnique = [...new Set(qTokens)];
    const N = this.docs.length;
    const k1 = 1.2;
    const b = 0.75;

    const scored = this.docs
      .filter((d) => (tier ? d.tool.tier === tier : true))
      .map((doc) => {
        const tf = new Map<string, number>();
        for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

        let score = 0;
        for (const t of qUnique) {
          const f = tf.get(t);
          if (!f) continue;
          const df = this.df.get(t) ?? 0;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / this.avgLen)));
        }

        // 精确短语命中额外加权：用户说"扫地机"，命中关键词"扫地机"比命中两个单字强得多
        let phrase = 0;
        for (const kw of doc.keywords) {
          if (kw.length >= 2 && query.includes(kw)) phrase += Math.min(kw.length, 6) * 0.9;
        }
        // 工具名被直接提到（模型或人指名道姓）几乎确定就是它
        if (query.toLowerCase().includes(doc.tool.name)) phrase += 20;

        return { tool: doc.tool, score: score + phrase };
      })
      .filter((x) => x.score > 0);

    scored.sort((a, b2) => b2.score - a.score || a.tool.name.localeCompare(b2.tool.name));
    return scored.slice(0, limit);
  }
}