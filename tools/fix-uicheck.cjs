const fs = require("fs");
const p = "tools/ui-check.mjs";
let t = fs.readFileSync(p, "utf8");
t = t.replace(
  'const appJs = fs.readFileSync("./preview/app.js", "utf8");',
  'const appJs = fs.readFileSync("./preview/app.js", "utf8");\nconst iconsJs = fs.readFileSync("./preview/icons.js", "utf8");'
);
t = t.replace("window.eval(appJs);", "window.eval(iconsJs);\nwindow.eval(appJs);");
fs.writeFileSync(p, t, "utf8");
console.log("ui-check patched to load icons.js");
