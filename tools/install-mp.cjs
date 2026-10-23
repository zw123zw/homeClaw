const fs = require("fs");
const path = require("path");

const src = process.env.TEMP + "\\mp-skills\\skills-main";
const dstRoot = "E:\\note\\homeClaw\\.agents\\skills";

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (!e.isSymbolicLink()) fs.copyFileSync(s, d);
  }
}

const installed = [];
for (const group of ["engineering", "productivity", "misc"]) {
  const gdir = src + "\\skills\\" + group;
  if (!fs.existsSync(gdir)) continue;
  for (const d of fs.readdirSync(gdir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const from = path.join(gdir, d.name);
    const to = path.join(dstRoot, d.name);
    if (fs.existsSync(to)) { console.log("skip (exists):", d.name); continue; }
    copyDir(from, to);
    installed.push(d.name);
  }
}

console.log("installed:", installed.length);
console.log(installed.join(", "));

// 顶层 AGENTS/GLOSSARY 也拷进项目根，方便技能引用
for (const f of ["AGENTS.md", "GLOSSARY.md", "SCOPE.md"]) {
  const from = src + "\\" + f;
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, "E:\\note\\homeClaw\\.agents\\" + f);
    console.log("copied", f);
  }
}
