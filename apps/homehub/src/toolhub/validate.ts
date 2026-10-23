import type { ToolSpec } from "./spec.ts";
import { expandValues } from "./spec.ts";

/**
 * 参数校验：模型给的参数一律当作不可信输入（§7.3）。
 *
 * 为什么不用 zod 现生成：spec 里已经声明了 type/enum/min/max，
 * 再生成一次 zod schema 等于把同一份约束写两遍，改一处漏一处。
 * 这里只做一次直读，且错误信息面向模型（模型能据此自我修正），不面向开发者。
 */
export type ValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errors: string[] };

export function validateArgs(
  spec: ToolSpec,
  raw: unknown,
  rooms: readonly string[],
): ValidationResult {
  const errors: string[] = [];

  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { ok: false, errors: ["参数必须是 JSON 对象"] };
  }

  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // 未声明的字段直接拒绝：模型凭空加字段往往是"记错了工具"，静默丢弃会让它以为成功了
  const declared = new Set(spec.params.map((p) => p.name));
  for (const key of Object.keys(input)) {
    if (!declared.has(key)) errors.push(`未知参数 ${key}，本工具只接受：${[...declared].join("/") || "（无）"}`);
  }

  for (const p of spec.params) {
    const value = input[p.name];

    if (value === undefined || value === null || value === "") {
      if (p.required) errors.push(`缺少必填参数 ${p.name}${p.desc ? `（${p.desc}）` : ""}`);
      continue;
    }

    if (p.type === "number") {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) {
        errors.push(`${p.name} 必须是数字，收到 ${JSON.stringify(value)}`);
        continue;
      }
      if (p.min !== undefined && n < p.min) errors.push(`${p.name} 不能小于 ${p.min}`);
      if (p.max !== undefined && n > p.max) errors.push(`${p.name} 不能大于 ${p.max}`);
      out[p.name] = n;
      continue;
    }

    if (p.type === "boolean") {
      if (typeof value === "boolean") out[p.name] = value;
      else if (value === "true" || value === "false") out[p.name] = value === "true";
      else errors.push(`${p.name} 必须是布尔值`);
      continue;
    }

    // string / enum
    const s = String(value);
    if (p.type === "enum") {
      const values = expandValues(p, rooms) ?? [];
      // "*" 是"全屋"的通配符，只对 room 有意义
      const allowed = p.name === "room" ? [...values, "*"] : values;
      if (!allowed.includes(s)) {
        errors.push(`${p.name} 只能是 ${allowed.join("/")}，收到「${s}」`);
        continue;
      }
    }
    out[p.name] = s;
  }

  return errors.length ? { ok: false, errors } : { ok: true, args: out };
}