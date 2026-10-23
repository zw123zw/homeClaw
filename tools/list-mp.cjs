const fs = require("fs");
const p = process.env.TEMP + "\\mp-skills\\skills-main";
const f = p + "\\skills\\engineering";
console.log("=== engineering skills ===");
for (const d of fs.readdirSync(f, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const skill = f + "\\" + d.name + "\\SKILL.md";
  let desc = "";
  try {
    const t = fs.readFileSync(skill, "utf8");
    const m = t.match(/^description:\s*(.+)$/m);
    desc = m ? m[1].slice(0, 110) : "(no description)";
  } catch { desc = "(no SKILL.md)"; }
  console.log("  " + d.name.padEnd(32) + desc);
}
console.log("\n=== root files ===");
for (const f2 of fs.readdirSync(p)) console.log("  " + f2);
