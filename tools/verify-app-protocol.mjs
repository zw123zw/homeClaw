import path from "node:path";
import fs from "node:fs";

const webRoot = path.resolve("apps/web/dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

async function handle(rawUrl) {
  const url = new URL(rawUrl);
  const rel = decodeURIComponent(url.pathname);
  const file = path.join(webRoot, path.normalize(rel).replace(/^([/\\])+/, ""));
  if (!file.startsWith(webRoot)) return { status: 403 };
  const contentType = MIME[path.extname(file)] ?? "application/octet-stream";
  try {
    const buf = await fs.promises.readFile(file);
    return { status: 200, type: contentType, bytes: buf.length };
  } catch {
    const html = await fs.promises.readFile(path.join(webRoot, "index.html"));
    return { status: 200, type: "text/html", bytes: html.length, fallback: true };
  }
}

const cases = [
  "app://homeclaw/index.html",
  "app://homeclaw/assets/index-DIr-OCRS.js",
  "app://homeclaw/assets/index-Cggcrp46.css",
  "app://homeclaw/chat",              // SPA 路由回落
  "app://homeclaw/../../secret.txt",  // 越界
];
for (const c of cases) console.log(c.padEnd(44), JSON.stringify(await handle(c)));
