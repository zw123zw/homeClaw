/**
 * 用 jsdom 真实执行预览页脚本，连真实 mock-server，验证界面逻辑（不是只看语法）。
 * 覆盖：首屏加载 → 发消息 → 流式分片渲染 → 工具卡片两态 → 标签切页 → 设备控制 → 场景执行
 */
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { installGlobals } from "./jsdom-globals.mjs";

const html = fs.readFileSync("../../tools/preview/index.html", "utf8");
const appJs = fs.readFileSync("../../tools/preview/app.js", "utf8");

const dom = new JSDOM(html, {
  url: "http://127.0.0.1:4010/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
const doc = window.document;
installGlobals(window);

const errors = [];
window.addEventListener("error", (e) => errors.push(String(e.message || e)));

let pass = 0;
const bad = [];
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  OK  " + name); }
  else { bad.push(name); console.log("  FAIL " + name + " " + extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

window.eval(appJs);

console.log("\n[界面] 首屏与真实服务联调");
await sleep(1500);

check("健康状态已更新（非『连接中…』）",
  !doc.getElementById("healthText").textContent.includes("连接中"),
  doc.getElementById("healthText").textContent);
check("健康指示灯为 ok", doc.getElementById("healthDot").className.includes("ok"), doc.getElementById("healthDot").className);
check("自动创建并选中会话", doc.querySelectorAll(".session-item").length >= 1);
check("会话项有 active 高亮", Boolean(doc.querySelector(".session-item.active")));
check("SSE 已连上", doc.getElementById("connInfo").textContent.includes("SSE 已连接"), doc.getElementById("connInfo").textContent);

const input = doc.getElementById("input");
input.value = "把客厅灯调到30%暖光";
await window.eval("send()");
await sleep(4000);

const userMsgs = doc.querySelectorAll(".msg.user");
const assistantMsgs = doc.querySelectorAll(".msg.assistant");
const toolCards = doc.querySelectorAll(".tool-card");

check("用户消息已渲染", userMsgs.length === 1, "实际 " + userMsgs.length);
check("assistant 气泡已渲染", assistantMsgs.length === 1, "实际 " + assistantMsgs.length);
check("assistant 气泡内是完整文本（分片已合并）",
  assistantMsgs[0] && assistantMsgs[0].querySelector(".txt").textContent.includes("客厅灯"),
  assistantMsgs[0] ? assistantMsgs[0].querySelector(".txt").textContent : "无气泡");
check("流式结束后 caret 光标已移除", assistantMsgs[0] && !assistantMsgs[0].querySelector(".caret"));
check("工具卡片已渲染", toolCards.length === 1, "实际 " + toolCards.length);
check("工具卡片显示工具名", toolCards[0] && toolCards[0].querySelector(".tool-card__name").textContent === "set_room_light",
  toolCards[0] ? toolCards[0].querySelector(".tool-card__name").textContent : "");
check("工具卡片进入成功态", toolCards[0] && toolCards[0].querySelector(".badge").textContent === "成功",
  toolCards[0] ? toolCards[0].querySelector(".badge").textContent : "");
check("工具卡片显示耗时", toolCards[0] && /ms$/.test(toolCards[0].querySelector(".mono").textContent),
  toolCards[0] ? toolCards[0].querySelector(".mono").textContent : "");
check("工具参数可展开", toolCards[0] && toolCards[0].querySelector("pre").textContent.includes("客厅"));

if (toolCards[0]) {
  toolCards[0].querySelector("button").click();
  check("点击详情后参数区可见", toolCards[0].querySelector(".tool-card__body").style.display !== "none");
}

console.log("\n[界面] 设备面板");
doc.querySelector('.tab[data-tab="devices"]').click();
await sleep(800);

check("对话页已隐藏", doc.getElementById("chatPage").style.display === "none");
check("设备页已显示", doc.getElementById("devicesPage").style.display !== "none");
const devices = doc.querySelectorAll(".device");
check("渲染 12 个设备卡", devices.length === 12, "实际 " + devices.length);
check("按房间分组为 3 组", doc.querySelectorAll(".room-group").length === 3, "实际 " + doc.querySelectorAll(".room-group").length);
check("离线设备有 offline 样式", doc.querySelectorAll(".device.offline").length === 1);
const offlineCard = doc.querySelector(".device.offline");
check("离线设备按钮被禁用", offlineCard && [...offlineCard.querySelectorAll("button")].every((b) => b.disabled));
check("灯设备有亮度滑杆", doc.querySelectorAll('.device input[type="range"]').length > 0);

const lightCard = [...devices].find((d) => d.textContent.includes("客厅主灯"));
if (lightCard) {
  const btn = [...lightCard.querySelectorAll("button")].find((b) => b.textContent === "关闭" || b.textContent === "打开");
  const beforeLabel = btn.textContent;
  btn.click();
  await sleep(1200);
  const lightCard2 = [...doc.querySelectorAll(".device")].find((d) => d.textContent.includes("客厅主灯"));
  const btn2 = [...lightCard2.querySelectorAll("button")].find((b) => b.textContent === "关闭" || b.textContent === "打开");
  check("点击开关后状态回流（按钮文案翻转）", btn2.textContent !== beforeLabel, beforeLabel + " -> " + btn2.textContent);
} else {
  check("找到客厅主灯卡片", false);
}

console.log("\n[界面] 场景页");
doc.querySelector('.tab[data-tab="scenes"]').click();
await sleep(800);
const scenes = doc.querySelectorAll(".scene");
check("渲染 4 个场景卡", scenes.length === 4, "实际 " + scenes.length);
check("每个场景都有执行按钮", [...scenes].every((s) => s.querySelector("button")));

if (scenes[0]) {
  scenes[0].querySelector("button").click();
  await sleep(1200);
  const toastEl = doc.getElementById("toast");
  check("执行场景后有结果提示", toastEl.style.display === "block" && toastEl.textContent.length > 0, toastEl.textContent);
}

console.log("\n未捕获脚本错误: " + (errors.length ? JSON.stringify(errors) : "无"));
console.log("\n结果: " + pass + " passed, " + bad.length + " failed");
if (bad.length || errors.length) { console.log("失败项: " + bad.join(", ")); process.exit(1); }
// SSE 连接会保持事件循环，显式退出
process.exit(0);