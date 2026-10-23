const fs = require("fs");
const base = "skills";
const files = [
  "codebase-design/SKILL.md",
  "domain-modeling/SKILL.md",
];
for (const f of files) {
  const t = fs.readFileSync(base + "/" + f, "utf8");
  console.log("\n========== " + f + " (" + t.length + ") ==========");
  console.log(t.slice(0, 4200));
}
