import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const esbuild = req("esbuild");
console.log("keys", Object.keys(esbuild).join(","));
try {
  esbuild.transform = async (c) => ({ code: c, map: "" });
  console.log("assign ok", typeof esbuild.transform);
} catch (e) {
  console.log("assign FAIL", e.message);
}