function lum(hex) {
  const c = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
const contrast = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

const BG = "#0F172A", CARD = "#1B2336", MUTED = "#272F42";

// 找最接近设计系统原值、且达标的替代色
console.log("=== destructive（错误文字，需在 bg/card/muted 上均 >=4.5）===");
for (const c of ["#EF4444", "#F05252", "#F26B6B", "#F87171", "#FB8A8A", "#FCA5A5"]) {
  const a = contrast(c, BG), b = contrast(c, CARD), d = contrast(c, MUTED);
  console.log(`  ${c}: bg=${a.toFixed(2)} card=${b.toFixed(2)} muted=${d.toFixed(2)} ${Math.min(a,b,d) >= 4.5 ? "<-- OK" : ""}`);
}

console.log("\n=== border（非文本，需 >=3.0 于 card 与 bg）===");
for (const c of ["#475569", "#5A6B85", "#64748B", "#6E82A0", "#7A8FA8", "#8098B5"]) {
  const a = contrast(c, BG), b = contrast(c, CARD);
  console.log(`  ${c}: bg=${a.toFixed(2)} card=${b.toFixed(2)} ${Math.min(a,b) >= 3.0 ? "<-- OK" : ""}`);
}

console.log("\n=== accent 文字用法（accent 作正文色时需 >=4.5）===");
for (const c of ["#22C55E", "#34D399", "#4ADE80"]) {
  console.log(`  ${c} on bg=${contrast(c, BG).toFixed(2)} on card=${contrast(c, CARD).toFixed(2)}`);
}
