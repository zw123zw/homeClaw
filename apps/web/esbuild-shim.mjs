/**
 * esbuild 的纯 JS 替身（本机策略禁止 spawn 子进程，esbuild 原生服务起不来）。
 *
 * 只实现 Vite 构建链路真正用到的三个函数：
 *  - transform：TS 剥离用 Node 22 内置 stripTypeScriptTypes，define 用字符串替换；
 *  - transformSync：同上的同步版；
 *  - formatMessages：把错误拼成可读文本。
 * 足够跑通 vite build，不足以当 esbuild 用 —— 只在本沙箱里生效。
 */
import { stripTypeScriptTypes } from "node:module";

export const version = "0.25.12-shim";

/** Vite 会 JSON.parse(result.map)，空字符串会炸；给一个合法空映射 */
const EMPTY_MAP = JSON.stringify({ version: 3, sources: [], names: [], mappings: "" });

/**
 * define 替换必须带标识符边界。
 *
 * 踩过的坑：早期版本直接 out.split(k).join(v)，于是 TDesign 里的
 * _process.env.NODE_ENV 被当成 process.env.NODE_ENV 替换，拼出
 * _ 加上 "production" 这种非法表达式，rollup 报 Expected ',', got '{'。
 * 这里要求前后都不是标识符字符，也不会落在 a.b 的属性名位置。
 */
function applyDefine(code, define) {
  let out = code;
  for (const [k, v] of Object.entries(define ?? {})) {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`, "g");
    out = out.replace(re, () => String(v));
  }
  return out;
}

function transformImpl(code, opts = {}) {
  let out = String(code);
  const loader = opts.loader ?? "js";
  const isTs = loader === "ts" || loader === "tsx" || loader === "jsx";

  if (isTs) {
    out = loader === "jsx" ? out : stripTypeScriptTypes(out, { mode: "strip" });
  }

  out = applyDefine(out, opts.define);
  return { code: out, map: EMPTY_MAP, warnings: [], legalComments: [] };
}

export async function transform(code, opts) {
  return transformImpl(code, opts);
}

export function transformSync(code, opts) {
  return transformImpl(code, opts);
}

export async function formatMessages(msgs) {
  return (msgs ?? []).map((m) => `${m.level ?? "error"}: ${m.text ?? ""}`).join("\n");
}

export async function build() {
  throw new Error("esbuild.build 在沙箱里不可用：本项目构建只走 vite + 类型剥离");
}

export function context() {
  return Promise.reject(new Error("esbuild.context 在沙箱里不可用"));
}

export default { version, transform, transformSync, formatMessages, build, context };
