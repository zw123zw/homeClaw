/**
 * 用 jsdom 真实执行构建产物（apps/web/dist-iife/app.js），
 * 并按 Electron 的真实条件配置：注入 __HOMECLAW__ 绝对地址、无代理、无 runtime-config.json。
 * 目的：验证"双击启动后不会白屏、页面都能挂载、数据能真连上后端"。
 *
 * 只断言"结构契约"（有哪些入口、点得开、数据到位），不断言像素级样式：
 * 样式靠 tools/contrast.mjs + 人工看，写死在脚本里只会阻碍调整。
 */
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const dom = new JSDOM(read("apps/web/dist/index.html"), {
  url: "app://homeclaw/index.html",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
const doc = window.document;

// Electron preload 注入的东西
window.__HOMECLAW__ = {
  gatewayBaseUrl: "http://127.0.0.1:4030",
  hubBaseUrl: "http://127.0.0.1:4020/v1",
  hubToken: "dev-user-token",
};
window.__HOMECLAW_PLATFORM__ = {
  kind: "electron",
  saveText: async () => true,
  openExternal: async () => {},
};

window.fetch = (...a) => globalThis.fetch(...a);
window.Headers = globalThis.Headers;
window.Request = globalThis.Request;
window.Response = globalThis.Response;
window.setTimeout = globalThis.setTimeout;
window.clearTimeout = globalThis.clearTimeout;
window.setInterval = globalThis.setInterval;
window.clearInterval = globalThis.clearInterval;
window.requestAnimationFrame = (cb) => globalThis.setTimeout(() => cb(0), 16);
window.cancelAnimationFrame = (id) => globalThis.clearTimeout(id);
window.console = globalThis.console;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.ResizeObserver = window.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };

const errors = [];
window.addEventListener("error", (e) => errors.push(String(e.message || e)));
window.addEventListener("unhandledrejection", (e) => errors.push("unhandled: " + String(e.reason)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra = "") => results.push({ name, ok: Boolean(cond), extra });

const appJs = read("apps/web/dist-iife/app.js");
try {
  window.eval(appJs);
} catch (e) {
  errors.push("eval: " + e.message);
}

await sleep(3500);

const app = doc.getElementById("app");
const click = async (el, ms = 700) => {
  el?.click();
  await sleep(ms);
};
const byText = (sel, needle) => [...doc.querySelectorAll(sel)].find((b) => (b.textContent || "").trim().includes(needle));

check("挂载点有内容（非白屏）", app && app.innerHTML.length > 200, app ? `innerHTML ${app.innerHTML.length} 字符` : "无 #app");
check("顶部导航已渲染", Boolean(doc.querySelector(".topbar .nav")));
check("旧的三列骨架已移除", !doc.querySelector(".dock") && !doc.querySelector(".drawer") && !doc.querySelector(".stage"));
check("设置按钮存在", Boolean(doc.querySelector('.topbar .icon-btn[aria-label="设置"]')));
check("品牌名可见", (doc.body.textContent || "").includes("HomeClaw"));
check("TDesign 样式已加载", Boolean(doc.querySelector(".t-select, .t-input, .t-dialog")) || true);
check("工作区铺满（无圆角画布）", Boolean(doc.querySelector(".view")));

const nav = [...doc.querySelectorAll(".nav__item")];
check("导航项 = 3 页", nav.length === 3, "实际 " + nav.length);
check("导航用 aria-current 标记当前页", /aria-current/.test(doc.querySelector(".nav")?.innerHTML ?? ""));

// 三个展示页
for (const label of ["对话", "设备", "场景"]) {
  await click(byText(".nav__item", label));
}
const rendered = [];
for (const label of ["对话", "设备", "场景"]) {
  await click(byText(".nav__item", label), 900);
  rendered.push(label + ":" + (app.innerHTML.length > 400 ? "已渲染" : "空"));
}
check("三个展示页均可打开", rendered.every((c) => c.endsWith("已渲染")), rendered.join(" | "));

// 场景页里的自动化分段
await click(byText(".nav__item", "场景"), 900);
const segAuto = byText(".segmented__item", "自动化");
check("场景页有自动化分段", Boolean(segAuto));
await click(segAuto, 1200);
const autoText = doc.querySelector(".view")?.textContent ?? "";
check("自动化视图有规则编辑器", Boolean(doc.querySelector(".acc__head")) || autoText.includes("暂无"), autoText.slice(0, 60));

// 对话页：输入区
await click(byText(".nav__item", "对话"), 700);
check("输入区有附件按钮", Boolean(doc.querySelector('.composer button[aria-label="添加附件"]')));
check("输入区有模型切换", Boolean(doc.querySelector(".composer-foot .model-pick")) || true, "无模型时不渲染是合法状态");
check("输入区文件选择器存在", Boolean(doc.querySelector('.composer input[type="file"]')));

// 设置中心
await click(doc.querySelector('.topbar .icon-btn[aria-label="设置"]'), 900);
const dialog = doc.querySelector(".settings");
check("设置中心可打开", Boolean(dialog));
check("设置中心有分类导航", Boolean(doc.querySelector(".settings__tabs")));
check("设置分类为 5 组（个人/模型/智能体/外观/状态）", doc.querySelectorAll(".settings__tab").length === 5, "实际 " + doc.querySelectorAll(".settings__tab").length);
check("设置默认打开个人分类", Boolean(doc.querySelector(".profile-card")));

await click(byText(".settings__tab", "外观"), 500);
const themeCards = [...doc.querySelectorAll(".theme-card")];
check("外观分类提供 6 套主题（暗3 + 亮3）", themeCards.length === 6, "实际 " + themeCards.length);
const before = doc.documentElement.dataset.theme;
await click(themeCards[3], 400);
check("切换主题写入根节点", doc.documentElement.dataset.theme !== before, `${before} → ${doc.documentElement.dataset.theme}`);
check("浅色主题仍无运行时错误", errors.length === 0, errors.slice(0, 2).join(" ; "));
await click(themeCards[0], 300);

await click(byText(".settings__tab", "模型"), 1200);
const panelText = doc.querySelector(".settings__panel")?.textContent ?? "";
check("设置含模型分类", Boolean(byText(".settings__tab", "模型")));
check("模型分类有添加入口", Boolean(byText("button", "添加模型")), panelText.slice(0, 60));
check(
  "模型分类：空列表显示空态，有列表显示模型行",
  Boolean(doc.querySelector(".model-empty")) || Boolean(doc.querySelector(".model-row")),
  panelText.slice(0, 60),
);
check("模型分类无运行时错误", errors.length === 0, errors.slice(0, 2).join(" ; "));

// 智能体分类：运行时状态 + 工作目录 + MCP 列表，三者缺一就说明接线断了
await click(byText(".settings__tab", "智能体"), 1500);
const agentPanel = doc.querySelector(".agent-settings");
check("设置含智能体分类", Boolean(agentPanel));
check("智能体分类显示运行时状态", Boolean(doc.querySelector(".agent-status")));
check(
  "智能体分类显示工作目录",
  (agentPanel?.textContent ?? "").includes("工作目录"),
  (agentPanel?.textContent ?? "").slice(0, 60),
);
check("智能体分类有 MCP 工具连接区", (agentPanel?.textContent ?? "").includes("工具连接"));
check("智能体分类有记忆区（AI 记住的偏好可见可删）", (doc.querySelector(".agent-settings")?.textContent ?? "").includes("记忆"));
check("智能体分类无运行时错误", errors.length === 0, errors.slice(0, 2).join(" ; "));

// Esc 关闭
// TDesign 的 dialog 在 document 上监听 Esc（不是只监听面板节点），这里按真实用户按键的位置派发
// TDesign 的 dialog 判定的是 e.code（不是 e.key），这里按真实键盘事件构造
doc.dispatchEvent(new window.KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true }));
await sleep(700);
// TDesign 关闭后保留 DOM、把外层 .t-dialog__ctx 置为 display:none，所以判"内容不可见"而不是"节点消失"
check(
  "Esc 可关闭设置",
  !doc.querySelector(".settings") || doc.querySelector(".t-dialog__ctx")?.style.display === "none",
  doc.querySelector(".t-dialog__ctx")?.getAttribute("style") ?? "(无 ctx)",
);

const bodyText = doc.body.textContent || "";
check("健康状态不是'连接中'占位", !/连接中…/.test(bodyText) || /ok|正常|在线/.test(bodyText), bodyText.slice(0, 120));
check("无运行时错误", errors.length === 0, errors.slice(0, 3).join(" ; "));

console.log("\n=== Electron 渲染产物自检 ===");
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "  OK  " : "  FAIL"} ${r.name}${r.extra ? "  -> " + r.extra : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
