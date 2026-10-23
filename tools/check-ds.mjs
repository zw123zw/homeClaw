const fs = require("fs");
const css = fs.readFileSync("apps/web/src/styles.css", "utf8");
const app = fs.readFileSync("tools/preview/app.js", "utf8");
const html = fs.readFileSync("tools/preview/index.html", "utf8");
const icons = fs.readFileSync("tools/preview/icons.js", "utf8");

let pass = 0; const bad = [];
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  OK   " + name); }
  else { bad.push(name); console.log("  FAIL " + name + (extra ? "  " + extra : "")); }
};

console.log("\n[Design System] Pre-Delivery Checklist\n");

// 1. 禁止 emoji 当图标
const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
check("无 emoji 当图标", !emojiRe.test(app) && !emojiRe.test(html),
  (app.match(emojiRe) || html.match(emojiRe) || [""])[0]);

// 2. 图标统一来自同一套线性 SVG
const iconNames = [...icons.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
check("图标为统一线性 SVG 集（" + iconNames.length + " 个）", iconNames.length >= 10);
check("图标统一 stroke-width", (icons.match(/stroke-width="1.75"/g) || []).length >= 1);
check("图标默认 aria-hidden", icons.includes('aria-hidden="true"'));

// 3. 可点击元素有 cursor:pointer
const buttonRule = css.match(/button \{[\s\S]*?\}/);
check("button 有 cursor:pointer", Boolean(buttonRule && buttonRule[0].includes("cursor: pointer")));
check("session-item 有 cursor:pointer", /\.session-item \{[\s\S]*?cursor: pointer/.test(css));
check("tab 有 cursor:pointer", /\.tab \{[\s\S]*?cursor: pointer/.test(css));

// 4. hover 过渡 150-300ms
check("定义动效时长令牌", /--dur-fast: 150ms/.test(css) && /--dur-slow: 300ms/.test(css));
check("button 有 transition", /button \{[\s\S]*?transition:/.test(css));

// 5. 焦点可见
check("有 :focus-visible 样式", css.includes(":focus-visible") && css.includes("outline: 2px solid"));

// 6. reduced-motion
check("尊重 prefers-reduced-motion", css.includes("prefers-reduced-motion"));

// 7. 响应式断点
for (const bp of ["1024px", "768px", "480px"]) {
  check("响应式断点 " + bp, css.includes("max-width: " + bp));
}

// 8. 无横向滚动（viewport meta + 允许换行）
check("有 viewport meta", html.includes('name="viewport"'));
check("弹窗/栅格不写死 px 宽度", !/\.device-grid \{[^}]*width: \d{3,}px/.test(css));

// 9. 语义化与标签
check("图标按钮有 aria-label", app.includes("aria-label"));
check("标签页用 role=tab/aria-selected", html.includes('role="tab"') && html.includes('aria-selected'));
check("当前会话用 aria-current", app.includes("aria-current"));
check("状态区用 role=status + aria-live", html.includes('role="status"') && html.includes("aria-live"));

// 10. 状态不只靠颜色
check("离线态除颜色外有文字说明", app.includes("离线 · 无法控制"));
check("在线/离线状态有 aria-label", app.includes('aria-label="' ) && /aria-label="' \+\s*\(e\.available/.test(app.replace(/\n/g, " ")) || app.includes('e.available ? "在线" : "离线"'));

// 11. 触控尺寸
check("定义最小命中尺寸 36px", css.includes("--hit-min: 36px"));
check("按钮使用 min-height 命中尺寸", /button \{[\s\S]*?min-height: var\(--hit-min\)/.test(css));

// 12. 表单有可见标签
check("输入框有 label（sr-only）", html.includes('class="sr-only" for="input"'));
check("滑杆有独立 label", app.includes("亮度"));

// 13. 无裸 hex（组件用令牌）
const bareHex = css.split("\n").filter((l) => /:\s*#[0-9A-Fa-f]{6}/.test(l) && !l.includes("--color-") && !/^\s*--/.test(l));
check("样式表内无裸 hex 直写（除令牌定义与数据色）", bareHex.length === 0, bareHex.slice(0, 3).join(" | "));

console.log("\n结果: " + pass + " passed, " + bad.length + " failed");
if (bad.length) process.exit(1);
