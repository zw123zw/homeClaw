const fs = require("fs");
const p = "tools/acceptance-m0.mjs";
let t = fs.readFileSync(p, "utf8");

// 幂等键加唯一后缀：脚本可重复运行，且幂等断言仍验证"同键不重复执行"
t = t.replace(
  'const cmd1 = await post("/v1/entities/light.living_room_ceiling/command", { service: "set_brightness", data: { brightness_pct: 30 }, idempotency_key: "idem-1" });',
  'const idemKey = "idem-" + Date.now().toString(36);\nconst cmd1 = await post("/v1/entities/light.living_room_ceiling/command", { service: "set_brightness", data: { brightness_pct: 30 }, idempotency_key: idemKey });'
);
t = t.replace(
  'const cmd2 = await post("/v1/entities/light.living_room_ceiling/command", { service: "turn_off", data: {}, idempotency_key: "idem-1" });',
  'const cmd2 = await post("/v1/entities/light.living_room_ceiling/command", { service: "turn_off", data: {}, idempotency_key: idemKey });'
);

fs.writeFileSync(p, t, "utf8");
console.log("acceptance-m0 made idempotent-safe");
