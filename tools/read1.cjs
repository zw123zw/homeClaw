const fs = require("fs");
const p = process.env.TEMP + "\\skill-unpack\\ui-ux-pro-max-skill-main";
const files = [
  "README.zh.md",
  "skill.json",
  ".claude/skills/ui-ux-pro-max/SKILL.md",
];
for (const f of files) {
  const full = p + "\\" + f.replace(/\//g, "\\");
  try {
    const t = fs.readFileSync(full, "utf8");
    console.log("\n========== " + f + " (" + t.length + " chars) ==========");
    console.log(t.slice(0, 3500));
  } catch (e) {
    console.log("\n[missing] " + f);
  }
}
