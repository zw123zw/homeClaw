const fs = require("fs");
const p = "tools/ui-check.mjs";
let t = fs.readFileSync(p, "utf8");

// 语义化改造后：高亮用 aria-current，不隐藏用 hidden 属性
t = t.replace(
  'check("session highlighted", Boolean(doc.querySelector(".session-item.active")));',
  'check("session highlighted", doc.querySelector(\'.session-item[aria-current="true"]\') !== null);'
);
t = t.replace(
  'check("chat hidden", doc.getElementById("chatPage").style.display === "none");',
  'check("chat hidden", doc.getElementById("chatPage").hidden === true);'
);
t = t.replace(
  'check("devices shown", doc.getElementById("devicesPage").style.display !== "none");',
  'check("devices shown", doc.getElementById("devicesPage").hidden === false);'
);
t = t.replace(
  'check("SSE connected", doc.getElementById("connInfo").textContent.includes("SSE"));',
  'check("SSE connected", doc.getElementById("connInfo").textContent.includes("实时连接"));'
);
t = t.replace(
  'check("scene run shows toast", toast.style.display === "block" && toast.textContent.length > 0, toast.textContent);',
  'check("scene run shows toast", toast.hidden === false && toast.textContent.length > 0, toast.textContent);'
);
// toast 显示判断
t = t.replace(
  /const toast = doc\.getElementById\("toast"\);\s*check\("scene run shows toast"/,
  'const toast = doc.getElementById("toast");\n  check("scene run shows toast"'
);
fs.writeFileSync(p, t, "utf8");
console.log("ui-check assertions updated");
