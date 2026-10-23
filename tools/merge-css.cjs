const fs = require("fs");
const files = ["01-base.css", "02-controls.css", "03-layout.css", "04-chat.css", "05-pages.css"];
const out = files.map((f) => fs.readFileSync("tools/css/" + f, "utf8").trimEnd()).join("\n\n");
fs.writeFileSync("apps/web/src/styles.css", out + "\n", "utf8");
console.log("merged styles.css:", out.length, "chars");

// 检查括号配平
const open = (out.match(/{/g) || []).length;
const close = (out.match(/}/g) || []).length;
console.log("braces:", open, "open /", close, "close", open === close ? "OK" : "MISMATCH");
