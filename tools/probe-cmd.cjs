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
  console.log("before brightness:", before.state.brightness);

  // 模拟验收脚本：固定幂等键 idem-1 第二次提交
  const r2 = await post("/v1/entities/light.living_room_ceiling/command", { service: "turn_off", data: {}, idempotency_key: "idem-1" });
  const after = await get("/v1/entities/light.living_room_ceiling");
  console.log("idem-1 replay status:", r2.status, "ok:", r2.body.ok, "returned brightness:", r2.body.state.brightness);
  console.log("after on:", after.state.on, "(若为 true 说明幂等拒了第二次 turn_off，符合预期)");
})();
