const fs = require("fs");
const css = fs.readFileSync("apps/web/src/styles.css", "utf8");
const icons = fs.readFileSync("tools/preview/icons.js", "utf8");
const app = fs.readFileSync("tools/preview/app.js", "utf8");
const html = fs.readFileSync("tools/preview/index.html", "utf8");

const out = html
  .replace('<link rel="stylesheet" href="/styles.css" />', "<style>\n" + css + "\n</style>")
  .replace('<script src="/icons.js"></script>', "<script>\n" + icons + "\n</script>")
  .replace('<script src="/app.js"></script>', "<script>\n" + app + "\n</script>");

fs.writeFileSync("tools/preview/standalone.html", out, "utf8");
console.log("standalone.html:", out.length, "bytes");
console.log("contains icons:", out.includes("ICONS"), "| contains app:", out.includes("hydrateIcons"));
