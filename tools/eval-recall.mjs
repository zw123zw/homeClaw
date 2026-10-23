/**
 * 工具检索回归（§4.4）：用真实的 ToolSearchIndex 跑 100 条评测集。
 *
 * 指标定义（比"recall@8"更严格，也更贴近真实注入方式）：
 *   候选集 = L1 常驻工具（25 个）+ L2 检索 top-8
 *   hit    = 期望工具 ∈ 候选集
 *   recall = hit 数 / 总数
 * 为什么不用"仅 top-8"：L1 工具永远在上下文里，把它算作未命中会低估实际可用性。
 * 但也不会因为 L1 常驻就把 recall 注水 —— 未命中项会逐条打印，看得见。
 */
import { ToolSearchIndex } from "../apps/homehub/src/toolhub/search.ts";
import { L1_TOOLS, L2_TOOLS } from "../apps/homehub/src/toolhub/catalog.ts";
import { CASES } from "../packages/eval/src/cases.ts";

const THRESHOLD = 0.95;
const index = new ToolSearchIndex([...L1_TOOLS, ...L2_TOOLS]);
const l1Names = new Set(L1_TOOLS.map((t) => t.name));

const misses = [];
let hits = 0;
const byPath = { L0: { hit: 0, total: 0 }, L1: { hit: 0, total: 0 }, L2: { hit: 0, total: 0 } };

for (const c of CASES) {
  const candidates = new Set(l1Names);
  for (const h of index.search(c.text, 8)) candidates.add(h.tool.name);

  const hit = candidates.has(c.expect.tool);
  byPath[c.path].total++;
  if (hit) {
    hits++;
    byPath[c.path].hit++;
  } else {
    misses.push({ id: c.id, text: c.text, expect: c.expect.tool, got: [...candidates].slice(0, 8).join(",") });
  }
}

const recall = hits / CASES.length;
console.log(`\n[eval] 用例 ${CASES.length} 条；recall@(L1+top8) = ${recall.toFixed(4)}（门槛 ${THRESHOLD}）`);
for (const [path, s] of Object.entries(byPath)) {
  console.log(`  ${path}: ${s.hit}/${s.total} = ${(s.hit / s.total).toFixed(3)}`);
}

/*
 * 纯检索能力：只看"期望工具本身是 L2 长尾工具"的用例。
 * 不能把"期望 set_climate 却只搜 L2"算作检索失败 —— set_climate 是 L1 常驻，
 * 本来就不该出现在 L2 检索结果里。算进去只会得到一张假的失败表。
 */
const l2Only = CASES.filter((c) => L2_TOOLS.some((t) => t.name === c.expect.tool));
let l2hit = 0;
const l2miss = [];
for (const c of l2Only) {
  const top = index.search(c.text, 8, "L2").map((h) => h.tool.name);
  if (top.includes(c.expect.tool)) l2hit++;
  else l2miss.push(`${c.id} 「${c.text}」期望 ${c.expect.tool}，top8=${top.slice(0, 8).join(",")}`);
}
console.log(`  L2 纯检索（${l2Only.length} 条期望 L2 工具）: ${l2hit}/${l2Only.length} = ${(l2hit / l2Only.length).toFixed(3)}`);
for (const m of l2miss) console.log("    MISS " + m);

if (misses.length) {
  console.log(`\n[eval] 未命中 ${misses.length} 条：`);
  for (const m of misses) console.log(`  - ${m.id} 「${m.text}」期望 ${m.expect}，候选 ${m.got}`);
}

const pass = recall >= THRESHOLD;
console.log(`\n[eval] ${pass ? "PASS" : "FAIL"}: recall ${recall.toFixed(4)} ${pass ? "≥" : "<"} ${THRESHOLD}`);
process.exit(pass ? 0 : 1);