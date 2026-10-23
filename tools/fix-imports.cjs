const fs = require("fs");
const files = [
  "apps/mock-server/src/chat.ts",
  "apps/mock-server/src/routes/sessions.ts",
  "apps/mock-server/src/server.ts",
];
for (const p of files) {
  let t = fs.readFileSync(p, "utf8");
  t = t.replace('import { NOW } from "./fixtures.ts";', 'import { nowSeconds as NOW } from "@homeclaw/contracts";');
  t = t.replace('import { HOME_ID, NOW } from "../fixtures.ts";', 'import { HOME_ID, nowSeconds as NOW } from "@homeclaw/contracts";');
  t = t.replace('import { HOME_ID, NOW } from "./fixtures.ts";', 'import { HOME_ID, nowSeconds as NOW } from "@homeclaw/contracts";');
  fs.writeFileSync(p, t, "utf8");
  console.log("updated " + p);
}
