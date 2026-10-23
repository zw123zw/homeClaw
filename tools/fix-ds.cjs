const fs = require("fs");
const p = "design-system/homeclaw/MASTER.md";
let t = fs.readFileSync(p, "utf8");

t = t.replace("| Destructive | `#EF4444` | `--color-destructive` |",
"| Destructive | `#F26B6B` | `--color-destructive` |");
t = t.replace("| Border | `#475569` | `--color-border` |",
"| Border | `#64748B` | `--color-border` |");
t = t.replace("**Color Notes:** Dark tech + status green",
`**Color Notes:** Dark tech + status green。destructive 由 #EF4444 调到 #F26B6B、border 由 #475569 调到 #64748B，
原因是原值未通过 WCAG 实测（错误文字在卡片上 4.16:1 < 4.5，边框 2.07:1 < 3.0），详见下方 Contrast Audit。

### Contrast Audit（实测，非估算）

| 组合 | 比值 | 门槛 | 结果 |
|---|---|---|---|
| foreground / background | 17.06:1 | 4.5 | PASS |
| foreground / card | 14.98:1 | 4.5 | PASS |
| muted-foreground / background | 6.96:1 | 4.5 | PASS |
| muted-foreground / card | 6.11:1 | 4.5 | PASS |
| muted-foreground / muted | 5.21:1 | 4.5 | PASS |
| on-accent / accent | 7.83:1 | 4.5 | PASS |
| on-primary / primary | 14.63:1 | 4.5 | PASS |
| destructive / background | 6.03:1 | 4.5 | PASS |
| destructive / card | 5.29:1 | 4.5 | PASS |
| destructive / muted | 4.51:1 | 4.5 | PASS |
| border / background | 3.75:1 | 3.0 | PASS |
| border / card | 3.29:1 | 3.0 | PASS |

复现：\`node tools/contrast.mjs\``);

fs.writeFileSync(p, t, "utf8");
console.log("MASTER.md updated");

// 同步更新对比度校验脚本里的期望值，确保它能守住这次的修正
const cp = "tools/contrast.mjs";
let c = fs.readFileSync(cp, "utf8");
c = c.replace('destructive: "#EF4444"', 'destructive: "#F26B6B"');
c = c.replace('border: "#475569"', 'border: "#64748B"');
c = c.replace('["边框 border / card（非文本，3:1）", P.border, P.card, 3.0],', '["边框 border / card（非文本，3:1）", P.border, P.card, 3.0],\n  ["边框 border / muted（非文本，3:1）", P.border, P.muted, 3.0],');
fs.writeFileSync(cp, c, "utf8");
console.log("contrast.mjs updated");
