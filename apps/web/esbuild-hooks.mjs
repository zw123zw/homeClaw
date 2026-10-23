/** 把 import "esbuild" 重定向到本目录的纯 JS 替身 */
const SHIM = new URL("./esbuild-shim.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "esbuild") return { url: SHIM, shortCircuit: true };
  return next(specifier, context);
}