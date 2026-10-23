const fs = require("fs");
for (const p of ["tools/contrast.mjs", "design-system/homeclaw/MASTER.md"]) {
  let t = fs.readFileSync(p, "utf8");
  t = t.replaceAll("#64748B", "#6B7C96");
  t = t.replace("| border / background | 3.75:1 | 3.0 | PASS |", "| border / background | 4.21:1 | 3.0 | PASS |");
  t = t.replace("| border / card | 3.29:1 | 3.0 | PASS |", "| border / card | 3.69:1 | 3.0 | PASS |\n| border / muted | 3.15:1 | 3.0 | PASS |");
  fs.writeFileSync(p, t, "utf8");
}
console.log("border -> #6B7C96");
