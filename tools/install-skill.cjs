const fs = require("fs");
const path = require("path");

const src = process.env.TEMP + "\\skill-unpack\\ui-ux-pro-max-skill-main\\.claude\\skills\\ui-ux-pro-max";
const dst = "E:\\note\\homeClaw\\.agents\\skills\\ui-ux-pro-max";

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isSymbolicLink()) {
      // 符号链接跳过（Windows 权限问题），实际内容通常已重复存在
      console.log("skip symlink:", entry.name);
    } else fs.copyFileSync(s, d);
  }
}

fs.rmSync(dst, { recursive: true, force: true });
copyDir(src, dst);

let files = 0, bytes = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else { files++; bytes += fs.statSync(p).size; }
  }
})(dst);
console.log("installed to", dst);
console.log("files:", files, "size:", (bytes / 1024).toFixed(1), "KB");
