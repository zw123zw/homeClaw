const fs = require("fs");
for (const f of ["tdd/SKILL.md", "implement/SKILL.md"]) {
  const t = fs.readFileSync("skills/" + f, "utf8");
  console.log("\n========== " + f + " ==========");
  console.log(t.slice(0, 3800));
}
