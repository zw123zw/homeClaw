// WCAG 对比度实测：六套主题的正文/次要/状态色必须达标。
// 颜色与 apps/web/src/styles.css 的 :root[data-theme] 保持一致，改一处要同步改另一处。
function lum(hex) {
  const c = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a, b) {
  const l1 = lum(a), l2 = lum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = {
  void: {
    bg: "#070a12", panel: "#0a0e18", raise: "#0f1522", hover: "#161e2e",
    fg: "#e9eef9", dim: "#93a1b8", faint: "#7d8aa0",
    accent: "#2fe39b", onAccent: "#04140d", danger: "#ff7a85", warn: "#f5b544",
    control: "#58657e",
  },
  abyss: {
    bg: "#050a13", panel: "#08101c", raise: "#0c1726", hover: "#132238",
    fg: "#e6f1ff", dim: "#9bb0c9", faint: "#8498b2",
    accent: "#5cc8ff", onAccent: "#04121a", danger: "#ff7f8f", warn: "#f2b84b",
    control: "#5c7595",
  },
  ember: {
    bg: "#0b0807", panel: "#120d0b", raise: "#1a1210", hover: "#241915",
    fg: "#f4eae2", dim: "#c3ac9d", faint: "#a48f80",
    accent: "#ffb05c", onAccent: "#1b0f04", danger: "#ff8a80", warn: "#ffd166",
    control: "#7e6555",
  },
  dawn: {
    bg: "#eef3f9", panel: "#f7fafd", raise: "#ffffff", hover: "#e4ecf5",
    fg: "#0f1724", dim: "#4a5b72", faint: "#5a6c83",
    accent: "#0c7c5e", onAccent: "#ffffff", danger: "#b4232f", warn: "#8a5a00",
    control: "#6b7a8f",
  },
  jade: {
    bg: "#eaf2ee", panel: "#f0f7f4", raise: "#ffffff", hover: "#dceae3",
    fg: "#10251d", dim: "#466055", faint: "#4d6662",
    accent: "#0a7a52", onAccent: "#ffffff", danger: "#b3261e", warn: "#8a5a00",
    control: "#5c7869",
  },
  sakura: {
    bg: "#f2efe9", panel: "#f7f4ee", raise: "#ffffff", hover: "#eae5dc",
    fg: "#241f18", dim: "#6b6151", faint: "#6f655a",
    accent: "#a05a1e", onAccent: "#ffffff", danger: "#b3261e", warn: "#8a5a00",
    control: "#877b68",
  },
};

console.log("配色对比度实测（WCAG AA）\n");
let fail = 0;
for (const [theme, p] of Object.entries(THEMES)) {
  const pairs = [
    ["正文 / bg", p.fg, p.bg, 4.5],
    ["正文 / raise", p.fg, p.raise, 4.5],
    ["正文 / hover", p.fg, p.hover, 4.5],
    ["次要 / bg", p.dim, p.bg, 4.5],
    ["次要 / raise", p.dim, p.raise, 4.5],
    ["次要 / hover", p.dim, p.hover, 4.5],
    ["弱化 / bg", p.faint, p.bg, 4.5],
    ["弱化 / raise", p.faint, p.raise, 4.5],
    ["弱化 / hover", p.faint, p.hover, 4.5],
    ["强调文字 / bg", p.accent, p.bg, 4.5],
    ["强调文字 / raise", p.accent, p.raise, 4.5],
    ["主按钮文字 / 强调底", p.onAccent, p.accent, 4.5],
    ["错误 / bg", p.danger, p.bg, 4.5],
    ["错误 / raise", p.danger, p.raise, 4.5],
    ["警告 / bg", p.warn, p.bg, 4.5],
    ["警告 / raise", p.warn, p.raise, 4.5],
    ["控件边 / raise（非文本 3:1）", p.control, p.raise, 3.0],
    ["控件边 / bg（非文本 3:1）", p.control, p.bg, 3.0],
    ["强调色 / bg（非文本 3:1）", p.accent, p.bg, 3.0],
  ];
  console.log("[" + theme + "]");
  for (const [name, fg, bg, min] of pairs) {
    const r = contrast(fg, bg);
    const ok = r >= min;
    if (!ok) fail++;
    console.log(
      (ok ? "  PASS " : "  FAIL ") + name.padEnd(28) +
      fg + " on " + bg + " = " + r.toFixed(2) + ":1 (需 " + min + ":1)",
    );
  }
  console.log("");
}
console.log(fail ? fail + " 项未达标" : "全部达标");
process.exit(fail ? 1 : 0);
