/**
 * 无子进程构建（本机策略禁止 spawn），产物用于 Electron 加载与离线预览。
 *
 * 三个坑与对策：
 *  1) Vite 在 Windows 上 exec("net use") → 换成"立刻失败"的空实现，走 realpath 兜底；
 *  2) esbuild 是子进程服务 → 用 Node 模块解析钩子换成纯 JS 替身（见 esbuild-shim.mjs）；
 *  3) .ts 的类型剥离同样原本由 esbuild 做 → 替身内部用 Node 22 的 stripTypeScriptTypes。
 *
 * 用法：node --import ./esbuild-register.mjs build.mjs
 */
import cp from "node:child_process";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";

const noSpawn = (_cmd, cb) => {
  if (typeof cb === "function") cb(new Error("spawn disabled in this sandbox"), "", "");
  return { on() {}, kill() {} };
};
cp.exec = noSpawn;
cp.execFile = (file, args, opts, cb) => noSpawn(file, typeof opts === "function" ? opts : cb);
if (cp.default) {
  cp.default.exec = noSpawn;
  cp.default.execFile = cp.execFile;
}

const { build } = await import("vite");
const vue = (await import("@vitejs/plugin-vue")).default;

const root = import.meta.dirname;

/** 兜底：node_modules 外的 .ts 也走内置剥离（NormalModule 的 transform 由 esbuild 替身处理） */
const tsPlugin = {
  name: "homeclaw-strip-ts",
  enforce: "pre",
  transform(code, id) {
    if (!/\.ts$/.test(id) || id.includes("node_modules") || id.endsWith(".d.ts")) return null;
    return { code: stripTypeScriptTypes(code, { mode: "strip" }), map: null };
  },
};

/**
 * 产物格式：
 *  - 默认 ESM（给 Electron / 现代浏览器用）；
 *  - `--iife` 时打成单文件 IIFE，给 jsdom 验收脚本用（jsdom 不执行 ESM）。
 * 两条路径共用同一份源码，避免"验收跑的是另一份代码"这种自欺。
 */
const wantIife = process.argv.includes("--iife");

await build({
  root,
  base: "./",
  /**
   * 必须显式替换 process.env.NODE_ENV。
   *
   * 依赖（vue 等）的 esm-bundler 产物里带着 `process.env.NODE_ENV !== "production"`，
   * 浏览器里没有 process，一执行就抛 `process is not defined`，后果就是整页白屏、
   * 且控制台只有一行错误。dev 模式构建时 Vite 会自己注入，这里走的是免子进程的
   * 自建构建链，得自己补上。
   */
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  configFile: false,
  plugins: [vue(), tsPlugin],
  resolve: { alias: { "@": path.join(root, "src") } },
  build: {
    outDir: wantIife ? path.join(root, "dist-iife") : path.join(root, "dist"),
    emptyOutDir: true,
    minify: false,
    target: "es2022",
    sourcemap: false,
    ...(wantIife
      ? {
          lib: { entry: path.join(root, "src/main.ts"), formats: ["iife"], name: "HomeClawApp", fileName: () => "app.js" },
          // IIFE 不能有 code-splitting，也不该外置任何依赖
          rollupOptions: { output: { inlineDynamicImports: true } },
        }
      : {}),
  },
  logLevel: "warn",
});

console.log("BUILD OK →", wantIife ? path.join(root, "dist-iife") : path.join(root, "dist"));