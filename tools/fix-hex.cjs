const fs = require("fs");
const p = "apps/web/src/styles.css";
let t = fs.readFileSync(p, "utf8");

// 新增 warning 令牌
t = t.replace("  --color-ring: #22C55E;", "  --color-ring: #22C55E;\n  --color-warning: #F5B547;");

// 替换所有裸值
t = t.replaceAll("#F5B547", "var(--color-warning)");
t = t.replaceAll("rgba(245,181,71,.45)", "color-mix(in srgb, var(--color-warning) 45%, transparent)");
t = t.replaceAll("rgba(245,181,71,.1)", "color-mix(in srgb, var(--color-warning) 10%, transparent)");
t = t.replaceAll("rgba(34,197,94,.45)", "color-mix(in srgb, var(--color-accent) 45%, transparent)");
t = t.replaceAll("rgba(34,197,94,.1)", "color-mix(in srgb, var(--color-accent) 10%, transparent)");
t = t.replaceAll("rgba(242,107,107,.45)", "color-mix(in srgb, var(--color-destructive) 45%, transparent)");
t = t.replaceAll("rgba(242,107,107,.1)", "color-mix(in srgb, var(--color-destructive) 10%, transparent)");
t = t.replaceAll("rgba(242,107,107,.12)", "color-mix(in srgb, var(--color-destructive) 12%, transparent)");
t = t.replaceAll("rgba(34,197,94,.18)", "color-mix(in srgb, var(--color-accent) 18%, transparent)");

fs.writeFileSync(p, t, "utf8");

// 校验 warning 对比度
const lum = (hex) => {
  const c = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};
const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };
console.log("warning on bg  :", contrast("#F5B547", "#0F172A").toFixed(2));
console.log("warning on card:", contrast("#F5B547", "#1B2336").toFixed(2));
