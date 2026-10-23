/**
 * 零依赖测试骨架。
 *
 * 为什么不用 vitest 跑这些用例：本机策略禁止 spawn 子进程，
 * 而 vitest 在 Windows 上要用 exec 去解析真实路径，直接 EPERM。
 * 这里的断言集只覆盖本仓库实际用到的几种（相等、包含、匹配、抛错），
 * 实现不到 100 行，换来的是"任何机器上 node 就能跑"，比引入测试框架更值。
 *
 * 用法：node --experimental-strip-types test/run.ts
 */

type Case = { name: string; fn: () => void | Promise<void>; suite: string };

const cases: Case[] = [];
let currentSuite = "(root)";

export function describe(name: string, fn: () => void): void {
  const prev = currentSuite;
  currentSuite = name;
  try {
    fn();
  } finally {
    currentSuite = prev;
  }
}

export function it(name: string, fn: () => void | Promise<void>): void {
  cases.push({ name, fn, suite: currentSuite });
}

class AssertionError extends Error {}

function show(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 部分匹配：对象只比给出的键，数组按下标逐个匹配（用于断言事件字段） */
function partial(actual: unknown, expected: unknown): boolean {
  if (expected === actual) return true;
  if (expected === null || typeof expected !== "object") return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((v, i) => partial(actual[i], v));
  }
  if (typeof actual !== "object" || actual === null) return false;
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) => partial((actual as Record<string, unknown>)[k], v));
}

export function expect(actual: unknown) {
  const fail = (msg: string): never => {
    throw new AssertionError(msg);
  };
  /**
   * not.* 的取反只针对"能明确取反"的断言（包含/相等/为 null），
   * 不给 toThrow 之流做取反 —— 那种取反语义含糊，写了也没人看得懂。
   */
  const not = {
    toContain(needle: unknown) {
      const hit = typeof actual === "string" ? actual.includes(String(needle)) : Array.isArray(actual) && actual.includes(needle);
      if (hit) fail(`不应包含 ${show(needle)}，实际 ${show(actual)}`);
    },
    toBe(expected: unknown) {
      if (Object.is(actual, expected)) fail(`不应等于 ${show(expected)}`);
    },
    toBeNull() {
      if (actual === null) fail("不应为 null");
    },
  };
  return {
    not,
    toBe(expected: unknown) {
      if (!Object.is(actual, expected)) fail(`期望 ${show(expected)}，实际 ${show(actual)}`);
    },
    toEqual(expected: unknown) {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) fail(`期望 ${b}，实际 ${a}`);
    },
    toMatchObject(expected: unknown) {
      if (!partial(actual, expected)) fail(`期望匹配 ${show(expected)}，实际 ${show(actual)}`);
    },
    toContain(needle: unknown) {
      const ok = typeof actual === "string" ? actual.includes(String(needle)) : Array.isArray(actual) && actual.includes(needle);
      if (!ok) fail(`期望包含 ${show(needle)}，实际 ${show(actual)}`);
    },
    toHaveLength(n: number) {
      const len = (actual as { length?: number })?.length;
      if (len !== n) fail(`期望长度 ${n}，实际 ${String(len)}`);
    },
    toBeGreaterThan(n: number) {
      if (!(typeof actual === "number" && actual > n)) fail(`期望 > ${n}，实际 ${show(actual)}`);
    },
    toBeNull() {
      if (actual !== null) fail(`期望 null，实际 ${show(actual)}`);
    },
    toThrow() {
      if (typeof actual !== "function") return fail("toThrow 需要传函数");
      let threw = false;
      try {
        (actual as () => void)();
      } catch {
        threw = true;
      }
      if (!threw) fail("期望抛错，但没有抛");
    },
  };
}

/** 供各测试文件引用：由 test/run.ts 汇总执行 */
export function allCases(): Case[] {
  return cases;
}