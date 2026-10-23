const fs = require("fs");
// 检查是否还有别处引用已删除的 fixtures.ts
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = d + "/" + e.name;
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|vue)$/.test(e.name)) files.push(p);
  }
})("apps");
for (const f of files) {
  const t = fs.readFileSync(f, "utf8");
  if (/from "\.\/fixtures\.ts"|from "\.\.\/fixtures\.ts"/.test(t)) console.log("still imports fixtures:", f);
}
console.log("check done");
