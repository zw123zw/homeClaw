/**
 * 静态站点 + 反向代理（开发自测 / 形态二"手机浏览器访问"都用它）。
 *
 * 为什么不用 `vite preview`：本机策略禁止 spawn，vite 的很多路径要走子进程；
 * 而这里只需要"把 dist 发出去 + 转发两个前缀"，node:http 足够且没有依赖。
 *
 * 代理规则与 apps/web/vite.config.ts 完全一致：
 *   /v1/**   → Gateway  (Gateway 是 L2，信封协议)
 *   /hub/**  → HomeHub  (L3，资源式 REST，转发时去掉 /hub)
 * SSE 必须逐块 flush，否则"流式"会变成"攒满再吐"。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.WEB_PORT ?? 5320);
const ROOT = path.resolve(process.env.WEB_ROOT ?? "apps/web/dist");
const GATEWAY = process.env.GATEWAY_URL ?? "http://127.0.0.1:4030";
const HUB = process.env.HUB_URL ?? "http://127.0.0.1:4020";

/**
 * 运行时配置：客户端首屏先取它。
 *
 * 为什么不让构建期注入票据（VITE_*）：
 *  票据一旦打进 dist 就随产物分发，换一台机器/换一个家庭都得重新构建；
 *  而这里由服务端读环境变量下发，同一份 dist 可以服务多套部署。
 * 注意下发范围：只给用户票据（面板权限），MCP 票据绝不下发（§7.1）。
 */
function runtimeConfig() {
  return {
    gatewayBaseUrl: process.env.PUBLIC_GATEWAY_URL ?? "",
    hubBaseUrl: "/hub/v1",
    hubToken: process.env.HUB_TOKEN ?? "dev-user-token",
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function proxy(req, res, target, stripPrefix) {
  const url = new URL(req.url, "http://placeholder");
  const pathname = stripPrefix ? url.pathname.replace(stripPrefix, "") || "/" : url.pathname;
  const base = new URL(target);

  const headers = { ...req.headers, host: base.host };
  const upstream = http.request(
    {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port,
      method: req.method,
      path: pathname + url.search,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      // 逐块转发：SSE 的每一帧都要立刻到达浏览器
      up.on("data", (chunk) => res.write(chunk));
      up.on("end", () => res.end());
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "UPSTREAM_ERROR", message: `后端不可达：${err.message}`, retryable: true }));
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://placeholder");

  if (url.pathname === "/runtime-config.json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify(runtimeConfig()));
  }

  if (url.pathname.startsWith("/v1/")) return proxy(req, res, GATEWAY, null);
  if (url.pathname.startsWith("/hub/")) return proxy(req, res, HUB, "/hub");

  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ""));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      // 单页应用：未知路径回 index.html，交给前端路由
      fs.readFile(path.join(ROOT, "index.html"), (e2, html) => {
        if (e2) return res.writeHead(404).end("not found");
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(buf);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[web] http://127.0.0.1:${PORT}  (dist=${ROOT})`);
  console.log(`[web] proxy: /v1 → ${GATEWAY} | /hub → ${HUB}`);
});