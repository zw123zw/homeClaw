const fs = require("fs");
const path = require("path");

const src = process.env.TEMP + "\\mp-skills\\skills-main";
const dstRoot = "E:\\note\\homeClaw\\skills";

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
  const gdir = path.join(src, "skills", group);
  if (!fs.existsSync(gdir)) continue;
  for (const d of fs.readdirSync(gdir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    copyDir(path.join(gdir, d.name), path.join(dstRoot, d.name));
    installed.push(group + "/" + d.name);
  }
}
console.log("installed " + installed.length + " skills");
console.log(installed.join("\n"));

for (const f of ["AGENTS.md", "GLOSSARY.md", "SCOPE.md", "CLAUDE.md"]) {
  const from = path.join(src, f);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(dstRoot, "_" + f));
    console.log("copied " + f);
  }
}
