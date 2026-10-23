/**
 * 用 jsdom 真实执行预览页脚本，连真实 mock-server，验证界面逻辑（不是只看语法）。
 * 覆盖：首屏加载 -> 发消息 -> 流式分片渲染 -> 工具卡片两态 -> 标签切页 -> 设备控制 -> 场景执行
 */
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { installGlobals } from "./jsdom-globals.mjs";

const html = fs.readFileSync("./preview/index.html", "utf8");
const appJs = fs.readFileSync("./preview/app.js", "utf8");
const iconsJs = fs.readFileSync("./preview/icons.js", "utf8");

const dom = new JSDOM(html, { url: "http://127.0.0.1:4010/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
installGlobals(window);

const errors = [];
window.addEventListener("error", (e) => errors.push(String(e.message || e)));

let pass = 0;
const bad = [];
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  OK   " + name); }
  else { bad.push(name); console.log("  FAIL " + name + " " + extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

window.eval(iconsJs);
window.eval(appJs);

console.log("\n[UI] first paint");
await sleep(1500);
check("health text updated", !doc.getElementById("healthText").textContent.includes("\u8fde\u63a5\u4e2d"), doc.getElementById("healthText").textContent);
check("health dot ok", doc.getElementById("healthDot").className.includes("ok"), doc.getElementById("healthDot").className);
check("session auto created", doc.querySelectorAll(".session-item").length >= 1);
check("session highlighted", doc.querySelector('.session-item[aria-current="true"]') !== null);
check("SSE connected", doc.getElementById("connInfo").textContent.includes("实时连接"));

doc.getElementById("input").value = "\u628a\u5ba2\u5385\u706f\u8c03\u523030%\u6696\u5149";
await window.eval("send()");
await sleep(4000);

const userMsgs = doc.querySelectorAll(".msg.user");
const asst = doc.querySelectorAll(".msg.assistant");
const tools = doc.querySelectorAll(".tool-card");
check("user message rendered", userMsgs.length >= 1, "n=" + userMsgs.length);
check("assistant bubble rendered", asst.length >= 1, "n=" + asst.length);
const lastAsst = asst[asst.length - 1];
check("assistant text merged from chunks", lastAsst && lastAsst.querySelector(".txt").textContent.length > 3, lastAsst ? lastAsst.querySelector(".txt").textContent : "");
check("caret removed after done", lastAsst && !lastAsst.querySelector(".caret"));
check("tool card rendered", tools.length >= 1, "n=" + tools.length);
const lastTool = tools[tools.length - 1];
check("tool card shows name", lastTool && lastTool.querySelector(".tool-card__name").textContent === "set_room_light");
check("tool card success state", lastTool && lastTool.querySelector(".badge").textContent === "\u6210\u529f", lastTool ? lastTool.querySelector(".badge").textContent : "");
check("tool card shows elapsed", lastTool && /ms$/.test(lastTool.querySelector(".mono").textContent), lastTool ? lastTool.querySelector(".mono").textContent : "");
check("tool args present", lastTool && lastTool.querySelector("pre").textContent.includes("\u5ba2\u5385"));
if (lastTool) {
  lastTool.querySelector("button").click();
  check("args panel expands", lastTool.querySelector(".tool-card__body").style.display !== "none");
}

console.log("\n[UI] devices");
doc.querySelector('.tab[data-tab="devices"]').click();
await sleep(800);
check("chat hidden", doc.getElementById("chatPage").hidden === true);
check("devices shown", doc.getElementById("devicesPage").hidden === false);
const devices = doc.querySelectorAll(".device");
check("12 device cards", devices.length === 12, "n=" + devices.length);
check("3 room groups", doc.querySelectorAll(".room-group").length === 3, "n=" + doc.querySelectorAll(".room-group").length);
check("1 offline device", doc.querySelectorAll(".device.offline").length === 1);
const offline = doc.querySelector(".device.offline");
check("offline buttons disabled", offline && [...offline.querySelectorAll("button")].every((b) => b.disabled));
check("light has slider", doc.querySelectorAll('.device input[type="range"]').length > 0);

const lightCard = [...devices].find((d) => d.textContent.includes("\u5ba2\u5385\u4e3b\u706f"));
check("found living room light", Boolean(lightCard));
if (lightCard) {
  const btn = [...lightCard.querySelectorAll("button")].find((b) => b.textContent === "\u5173\u95ed" || b.textContent === "\u6253\u5f00");
  const before = btn.textContent;
  btn.click();
  await sleep(1200);
  const card2 = [...doc.querySelectorAll(".device")].find((d) => d.textContent.includes("\u5ba2\u5385\u4e3b\u706f"));
  const btn2 = [...card2.querySelectorAll("button")].find((b) => b.textContent === "\u5173\u95ed" || b.textContent === "\u6253\u5f00");
  check("toggle flips state", btn2.textContent !== before, before + " -> " + btn2.textContent);
}

console.log("\n[UI] scenes");
doc.querySelector('.tab[data-tab="scenes"]').click();
await sleep(800);
const scenes = doc.querySelectorAll(".scene");
check("4 scene cards", scenes.length === 4, "n=" + scenes.length);
check("each scene has button", [...scenes].every((s) => s.querySelector("button")));
if (scenes[0]) {
  scenes[0].querySelector("button").click();
  await sleep(1200);
  const toast = doc.getElementById("toast");
  check("scene run shows toast", toast.hidden === false && toast.textContent.length > 0, toast.textContent);
}

console.log("\nuncaught errors: " + (errors.length ? JSON.stringify(errors) : "none"));
console.log("\nresult: " + pass + " passed, " + bad.length + " failed");
if (bad.length || errors.length) { console.log("failed: " + bad.join(", ")); process.exit(1); }
process.exit(0);
