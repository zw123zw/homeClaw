import { CASES } from "./cases.ts";

/**
 * 评测执行器骨架（§4.4）。
 * M0 阶段先做"评测集自洽性校验"，M2 ToolHub 就绪后接入真实检索：
 *   recall@8 = |top8 ∩ 期望工具| / |期望工具|
 * 硬门槛：recall@8 ≥ 0.95，未达标 CI 直接失败。
 */
const RECALL_THRESHOLD = 0.95;

function validateCaseSet() {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const c of CASES) {
    if (ids.has(c.id)) problems.push(`重复 id: ${c.id}`);
    ids.add(c.id);
    if (!c.text.trim()) problems.push(`${c.id} 缺少指令文本`);
    if (!c.expect.tool) problems.push(`${c.id} 缺少期望工具`);
    // 参数枚举化要求（§4.3）：房间必须来自固定词典，不能是自由文本
    const room = c.expect.args?.room;
    if (typeof room === "string" && room !== "*" && !["客厅", "主卧", "书房", "厨房", "浴室", "阳台", "门口"].includes(room)) {
      problems.push(`${c.id} 房间不在词典内: ${room}`);
    }
  }

  // 分类覆盖度：三层路径都要有样本，否则评测会失真
  for (const path of ["L0", "L1", "L2"] as const) {
    const n = CASES.filter((c) => c.path === path).length;
    if (n < 20) problems.push(`${path} 样本不足（${n} < 20）`);
  }

  return { problems, ids };
}

console.log(`\n[eval] 评测集规模: ${CASES.length} 条`);
for (const path of ["L0", "L1", "L2"] as const) {
  console.log(`  ${path}: ${CASES.filter((c) => c.path === path).length} 条`);
}

const { problems } = validateCaseSet();
if (problems.length) {
  console.error("\n[eval] 评测集自检失败:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("[eval] 评测集自检通过（无重复 id / 参数枚举化 / 三层覆盖）");

/**
 * 占位：真实检索接入后，这里对每条 case 调用 ToolHub.search_tools(query, 8)，
 * 计算 recall@8 并打印未命中明细。
 */
const recall = Number(process.env.EVAL_RECALL ?? "");
if (Number.isFinite(recall) && recall > 0) {
  const pass = recall >= RECALL_THRESHOLD;
  console.log(`[eval] recall@8 = ${recall.toFixed(3)} (门槛 ${RECALL_THRESHOLD}) → ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exit(1);
} else {
  console.log("[eval] 未提供 EVAL_RECALL，跳过阈值判定（M2 后由 CI 注入真实 recall）");
}