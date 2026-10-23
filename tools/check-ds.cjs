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

const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
check("no emoji as icon", !emojiRe.test(app) && !emojiRe.test(html),
  (app.match(emojiRe) || html.match(emojiRe) || [""])[0]);

const iconNames = [...icons.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
check("consistent linear SVG icon set (" + iconNames.length + ")", iconNames.length >= 10);
check("icon stroke-width unified", (icons.match(/stroke-width="1.75"/g) || []).length >= 1);
check("icons aria-hidden by default", icons.includes('aria-hidden="true"'));

const buttonRule = css.match(/button \{[\s\S]*?\}/);
check("button has cursor:pointer", Boolean(buttonRule && buttonRule[0].includes("cursor: pointer")));
check("session-item has cursor:pointer", /\.session-item \{[\s\S]*?cursor: pointer/.test(css));
check("tab has cursor:pointer", /\.tab \{[\s\S]*?cursor: pointer/.test(css));

check("motion tokens 150-300ms", /--dur-fast: 150ms/.test(css) && /--dur-slow: 300ms/.test(css));
check("button has transition", /button \{[\s\S]*?transition:/.test(css));

check("focus-visible styles", css.includes(":focus-visible") && css.includes("outline: 2px solid"));
check("prefers-reduced-motion", css.includes("prefers-reduced-motion"));

for (const bp of ["1024px", "768px", "480px"]) {
  check("responsive breakpoint " + bp, css.includes("max-width: " + bp));
}

check("viewport meta", html.includes('name="viewport"'));
check("no fixed px container width in grid", !/\.device-grid \{[^}]*width: \d{3,}px/.test(css));

check("icon buttons have aria-label", app.includes("aria-label"));
check("tabs use role=tab + aria-selected", html.includes('role="tab"') && html.includes('aria-selected'));
check("current session uses aria-current", app.includes("aria-current"));
check("status area role=status + aria-live", html.includes('role="status"') && html.includes("aria-live"));

check("offline state not color-only", app.includes("离线 · 无法控制"));
check("online/offline has aria-label", app.includes('"在线" : "离线"'));

check("hit-min 36px token", css.includes("--hit-min: 36px"));
check("button uses min-height hit-min", /button \{[\s\S]*?min-height: var\(--hit-min\)/.test(css));

check("input has visible label", html.includes('class="sr-only" for="input"'));
check("slider has label", app.includes("亮度"));

const bareHex = css.split("\n").filter((l) => /:\s*#[0-9A-Fa-f]{6}/.test(l) && !/^\s*--/.test(l));
check("no bare hex outside tokens", bareHex.length === 0, bareHex.slice(0, 3).join(" | "));

console.log("\nresult: " + pass + " passed, " + bad.length + " failed");
if (bad.length) process.exit(1);
