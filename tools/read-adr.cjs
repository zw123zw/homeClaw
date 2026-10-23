const fs = require("fs");
const t = fs.readFileSync("skills/domain-modeling/ADR-FORMAT.md", "utf8");
console.log(t.slice(0, 2000));
