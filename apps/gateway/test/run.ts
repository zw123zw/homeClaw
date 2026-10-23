/**
 * 测试入口：加载所有 *.test.ts 并逐个执行。
 *
 * 顺序固定（文件名字母序），失败也继续跑完 —— 一次跑完看到全部问题，
 * 比改一个跑一个快得多。
 */
import { allCases } from "./harness.ts";

const files = ["agent-tools.test.ts", "hermes-events.test.ts", "mcp.test.ts", "runner.test.ts"];

for (const f of files) {
  await import(new URL("./" + f, import.meta.url).href);
}

const cases = allCases();
let failed = 0;
let lastSuite = "";

for (const c of cases) {
  if (c.suite !== lastSuite) {
    console.log("\n" + c.suite);
    lastSuite = c.suite;
  }
  try {
    await c.fn();
    console.log("  ok   " + c.name);
  } catch (err) {
    failed += 1;
    console.log("  FAIL " + c.name);
    console.log("       " + (err instanceof Error ? err.message : String(err)));
  }
}

console.log(`\n${cases.length - failed}/${cases.length} 通过`);
if (failed > 0) process.exitCode = 1;