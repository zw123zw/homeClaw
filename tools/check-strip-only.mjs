/**
 * 检查所有 .ts 源码是否只用了 `--experimental-strip-types` 支持的语法。
 *
 * 为什么需要这个检查：Node 的 strip-only 模式不做类型转换，只删类型注解。
 * 因此"参数属性"（constructor(private readonly x: T)）与 enum / namespace 会直接报
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX —— 而 tsc 是接受的，类型检查一片绿，
 * 服务却起不来。这个坑在本次开发里踩过两次，必须由脚本守住。
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["apps", "packages", "tools"];
const SKIP = new Set(["node_modules", ".git", "dist", "data"]);

const problems = [];

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts")) check(full);
  }
}

function check(file) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);

  lines.forEach((line, i) => {
    const no = i + 1;

    // 参数属性：constructor(...) 的形参列表里出现修饰符
    // 需要跨行判断，所以先在"整个 constructor 签名"上匹配，再定位行号
    if (/^\s*(export\s+)?(const\s+)?enum\s+\w+/.test(line)) {
      problems.push({ file, line: no, kind: "enum", text: line.trim() });
    }
    if (/^\s*(export\s+)?namespace\s+\w+/.test(line)) {
      problems.push({ file, line: no, kind: "namespace", text: line.trim() });
    }
  });

  // 参数属性：抓 constructor 之后到第一个 ")" 或 "{" 之间的形参文本
  const ctorRe = /constructor\s*\(([\s\S]*?)\)\s*(?::\s*[^{]+)?\{/g;
  let m;
  while ((m = ctorRe.exec(src)) !== null) {
    const params = m[1];
    if (/^\s*(private|public|protected|readonly)\s/m.test(params) || /(^|,)\s*(private|public|protected|readonly)\s+\w+\s*:/.test(params)) {
      const line = src.slice(0, m.index + src.slice(m.index).indexOf("constructor")).split(/\r?\n/).length;
      problems.push({ file, line, kind: "参数属性", text: ("constructor(" + params).replace(/\s+/g, " ").trim().slice(0, 110) });
    }
  }
}

for (const root of ROOTS) if (fs.existsSync(root)) walk(root);

if (problems.length === 0) {
  console.log("[strip-only] 通过：没有参数属性 / enum / namespace");
  process.exit(0);
}

console.log(`[strip-only] 发现 ${problems.length} 处 Node strip-only 不支持的语法：`);
for (const p of problems) console.log(`  ${p.file}:${p.line}  ${p.kind}  ${p.text.slice(0, 100)}`);
process.exit(1);