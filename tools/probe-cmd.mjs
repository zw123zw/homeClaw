const http = require("http");
const BASE = "http://127.0.0.1:4010";
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(BASE + path, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on("error", reject); req.write(data); req.end();
  });
}
const get = (p) => new Promise((res, rej) => http.get(BASE + p, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));

(async () => {
  const before = await get("/v1/entities/light.living_room_ceiling");
  console.log("before:", before.state);
  const r = await post("/v1/entities/light.living_room_ceiling/command", { service: "set_brightness", data: { brightness_pct: 30 }, idempotency_key: "idem-probe-" + Date.now() });
  console.log("command:", r.status, r.body);
  const after = await get("/v1/entities/light.living_room_ceiling");
  console.log("after :", after.state);
})();
