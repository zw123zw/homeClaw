const fs = require("fs");
const p = "tools/preview/app.js";
let t = fs.readFileSync(p, "utf8");
t = t.replace(
`  const box = $("messages");
  /* 尊重 reduced-motion：动效关闭时直接定位，不做平滑滚动 */
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  box.scrollTo({ top: box.scrollHeight, behavior: reduce ? "auto" : "smooth" });`,
`  const box = $("messages");
  if (!box) return;
  /* 尊重 reduced-motion：动效关闭时直接定位，不做平滑滚动 */
  const reduce =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  /* scrollTo 在部分环境（含 jsdom）不存在，回退到直接赋值 */
  if (typeof box.scrollTo === "function") {
    box.scrollTo({ top: box.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  } else {
    box.scrollTop = box.scrollHeight;
  }`
);
fs.writeFileSync(p, t, "utf8");
console.log("scrollBottom hardened");
