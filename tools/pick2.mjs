function lum(hex) {
  const c = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };
for (const c of ["#64748B", "#6B7C96", "#6E82A0", "#7488A6"]) {
  console.log(c, "bg=" + contrast(c, "#0F172A").toFixed(2), "card=" + contrast(c, "#1B2336").toFixed(2), "muted=" + contrast(c, "#272F42").toFixed(2));
}
