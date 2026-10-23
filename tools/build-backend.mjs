/**
 * 把 HomeHub 与 Gateway 各打成**单文件 ESM**，供 Electron 正式包直接 spawn。
 *
 * 为什么需要这一步：
 *  - dev 走 `node --experimental-strip-types src/server.ts`，而 Node 的 strip-types 只是
 *    "官方实验特性"，且要求 .ts 后缀能被 runtime 识别；安装包里把 src 原样塞进去，
 *    一旦用户机器上的 Electron 内置 Node 版本不同，就会变成"能起进程但立刻退出"；
 *  - 打成 .mjs 之后只剩 Node 标准库 + 已内联的第三方依赖，跨机器启动行为稳定。
 *
 * 本机约束：spawn 被策略禁止，而 vite 内部会 exec("net use") / esbuild 服务。
 * 所以这里复用 apps/web 里那套"纯 JS 替身"（esbuild-shim.mjs），并且自己 build，
 * 不经过 pnpm/vite CLI。
 *
 * 用法（有两种）：
 *   node tools/build-backend.mjs
 *   node --import ./apps/web/esbuild-register.mjs tools/build-backend.mjs
 */
import cp from "node:child_process";

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

const path = await import("node:path");
const { fileURLToPath } = await import("node:url");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "dist-backend");

/**
 * vite 装在 apps/web 而不是根目录：直接从 tools/ 里 import 解析不到。
 * 用 createRequire 以 apps/web 为基准解析，拿到真实的包入口绝对路径再动态 import。
 */
const { createRequire } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const webRequire = createRequire(path.join(root, "apps/web/package.json"));
const viteEntry = webRequire.resolve("vite");
const { build } = await import(pathToFileURL(viteEntry).href);

const targets = [
  { name: "homehub", entry: path.join(root, "apps/homehub/src/server.ts") },
  { name: "gateway", entry: path.join(root, "apps/gateway/src/server.ts") },
];

for (const t of targets) {
  await build({
    configFile: false,
    root,
    logLevel: "warn",
    build: {
      ssr: t.entry,
      outDir,
      emptyOutDir: t.name === targets[0].name,
      minify: false,
      target: "node20",
      // 单文件：任何 node_modules 里的依赖都内联，避免安装包里还要带一份 node_modules
      rollupOptions: { output: { format: "esm", entryFileNames: `${t.name}.mjs` } },
      ssrEmitAssets: false,
    },
    ssr: { noExternal: true, target: "node" },
  });
  console.log(`[backend] ${t.name} → ${path.relative(root, outDir)}/${t.name}.mjs`);
}

console.log("BUILD OK →", outDir);
