const fs = require("fs");
const p = process.env.TEMP + "\\skill-unpack\\ui-ux-pro-max-skill-main";
const t = fs.readFileSync(p + "\\.claude\\skills\\ui-ux-pro-max\\SKILL.md", "utf8");
console.log(t.slice(12000));
