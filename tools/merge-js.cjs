const fs = require("fs");
const parts = ["app-01.js", "app-02.js", "app-03.js"];
const out = parts.map((p) => fs.readFileSync("tools/preview/" + p, "utf8").trimEnd()).join("\n");
fs.writeFileSync("tools/preview/app.js", out + "\n", "utf8");
console.log("app.js:", out.length, "chars");

// 语法检查
const { execSync } = require("child_process");
try {
  execSync("node --check tools/preview/app.js", { stdio: "pipe" });
  console.log("syntax OK");
} catch (e) {
  console.log("syntax FAIL:", e.stderr.toString());
}

// 清理分片
for (const p of parts) fs.unlinkSync("tools/preview/" + p);
console.log("parts cleaned");
