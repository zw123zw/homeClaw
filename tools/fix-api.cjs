const fs = require("fs");
const p = "tools/preview/app.js";
let t = fs.readFileSync(p, "utf8");

t = t.replace(
`async function api(path, init) {
  const res = await fetch(API + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init && init.headers) },
  });`,
`async function api(path, init) {
  /* 只有真的带 body 时才声明 content-type：
     Fastify 对"声明了 JSON 但 body 为空"会直接 400 */
  const headers = { ...(init && init.headers) };
  if (init && init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(API + path, { ...init, headers });`
);

fs.writeFileSync(p, t, "utf8");
console.log("api() hardened");
