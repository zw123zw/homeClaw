const fs = require("fs");
const p = "apps/web/src/env.d.ts";
fs.writeFileSync(p, `/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
`, "utf8");
console.log("env.d.ts written");
