import fs from "node:fs";
import path from "node:path";

/**
 * 文件类工具的执行体（file_list / file_rename / file_move / file_write / file_read）。
 *
 * 统一约束（对应「沙箱安全控制」）：
 *  1. 所有路径先解析成绝对路径，再校验仍在 workspaceRoot 内 —— 越界直接抛错，
 *     不做"尽力而为"的裁剪。软链接目录用 realpath 二次校验，否则 `ln -s /` 就能越狱；
 *  2. 写操作只允许写文本，不允许覆盖目录、不允许写到符号链接指向的外部文件；
 *  3. 批量改名默认 dry-run，用户确认后才真改 —— 正则写错一次就能毁掉一批文件名。
 *
 * 为什么这些不做成 MCP 里的一次性脚本：工具要能被模型逐次调用并看到每一步结果，
 * 一次性脚本失败时模型拿不到"哪一步错了"。
 */

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** 路径必须在根内：解析 + realpath（若存在）+ 前缀校验 */
export function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel && rel.trim() ? rel : ".");
  assertInside(root, abs);
  return abs;
}

function assertInside(root: string, abs: string): void {
  const rootReal = realpathOrSelf(root);
  const check = (p: string) => {
    const r = path.relative(rootReal, p);
    if (r.startsWith("..") || path.isAbsolute(r)) {
      throw new ToolError(`路径越界（只能操作工作目录内的文件）：${abs}`);
    }
  };
  check(abs);
  // 已存在的部分走 realpath：防符号链接把写入引到根外
  const real = realpathMaybe(abs);
  if (real) check(real);
}

function realpathMaybe(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function realpathOrSelf(p: string): string {
  return realpathMaybe(p) ?? p;
}
export type FileEntry = { name: string; path: string; kind: "file" | "dir"; size: number; mtime: number };

/** 列目录：默认不递归、不越过根；返回相对路径，方便模型直接拿去调其它工具 */
export function listFiles(
  root: string,
  opts: { dir?: string; recursive?: boolean; pattern?: string; limit?: number } = {},
): { dir: string; entries: FileEntry[]; truncated: boolean } {
  const base = resolveInside(root, opts.dir ?? ".");
  const limit = clamp(opts.limit ?? 200, 1, 2000);
  const re = opts.pattern ? safeRegex(opts.pattern) : null;
  const entries: FileEntry[] = [];
  let truncated = false;

  const walk = (dir: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new ToolError(`读取目录失败：${err instanceof Error ? err.message : String(err)}`);
    }
    for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      // 跳过隐藏与依赖目录：模型不需要看 .git / node_modules，列出来只是浪费上下文
      if (it.name.startsWith(".") || it.name === "node_modules") continue;
      const abs = path.join(dir, it.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (it.isDirectory()) {
        entries.push({ name: it.name, path: rel, kind: "dir", size: 0, mtime: mtimeOf(abs) });
        if (opts.recursive) walk(abs);
        continue;
      }
      if (re && !re.test(it.name)) continue;
      entries.push({ name: it.name, path: rel, kind: "file", size: sizeOf(abs), mtime: mtimeOf(abs) });
    }
  };

  walk(base);
  return { dir: path.relative(root, base).split(path.sep).join("/") || ".", entries, truncated };
}

/** 读文本：二进制（含 \0）拒绝，超长截断并明说 */
export function readTextFile(root: string, opts: { path: string; maxChars?: number }): { path: string; text: string; truncated: boolean } {
  const abs = resolveInside(root, opts.path);
  const max = clamp(opts.maxChars ?? 60_000, 1_000, 400_000);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch (err) {
    throw new ToolError(`读取失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (head.includes(0)) throw new ToolError("这是二进制文件，不能按文本读取（可用 doc_read 读 PDF/Word/Excel/PPT）");
  const text = buf.toString("utf8");
  const cut = text.length > max;
  return { path: opts.path, text: cut ? text.slice(0, max) : text, truncated: cut };
}

/** 写文本：父目录自动创建；默认不覆盖已有文件（覆盖要显式传 overwrite） */
export function writeTextFile(
  root: string,
  opts: { path: string; content: string; overwrite?: boolean },
): { path: string; bytes: number; created: boolean } {
  const abs = resolveInside(root, opts.path);
  if (abs === realpathOrSelf(root)) throw new ToolError("不能把文件写到工作目录本身");
  const exists = fs.existsSync(abs);
  if (exists) {
    if (fs.statSync(abs).isDirectory()) throw new ToolError("目标是一个目录，不能当文件写");
    if (!opts.overwrite) throw new ToolError("文件已存在；确认要覆盖请传 overwrite=true");
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // 写到真实路径：避免通过符号链接写到根外（resolveInside 只校验了原路径）
  const target = realpathMaybe(path.dirname(abs)) ? path.join(realpathOrSelf(path.dirname(abs)), path.basename(abs)) : abs;
  assertInside(root, target);
  fs.writeFileSync(target, opts.content, "utf8");
  return { path: opts.path, bytes: Buffer.byteLength(opts.content), created: !exists };
}

export type RenamePlanItem = { from: string; to: string; ok: boolean; reason?: string };

/**
 * 批量改名（正则）。
 *
 * 默认 dryRun：先返回"会改成什么"，用户/模型确认后再执行。
 * 冲突检测覆盖三种真实事故：改完重名、改完目标已存在、同一文件被两条规则命中。
 * 不接受改到子目录（换目录用 file_move），避免一次操作产生两个语义。
 */
export function renameBatch(
  root: string,
  opts: { dir?: string; pattern: string; replacement: string; flags?: string; dryRun?: boolean; exts?: string[] },
): { dir: string; dry_run: boolean; items: RenamePlanItem[]; renamed: number } {
  const base = resolveInside(root, opts.dir ?? ".");
  const re = safeRegex(opts.pattern, opts.flags ?? "g");
  const exts = (opts.exts ?? []).map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`));

  const files = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith("."))
    .map((d) => d.name)
    .filter((n) => (exts.length ? exts.includes(path.extname(n).toLowerCase()) : true));

  const plans: RenamePlanItem[] = [];
  const seen = new Set<string>();

  for (const name of files) {
    const next = name.replace(re, opts.replacement);
    if (next === name) continue;
    if (/[\\/]/.test(next)) {
      plans.push({ from: name, to: next, ok: false, reason: "新名字不能包含路径分隔符" });
      continue;
    }
    if (seen.has(next.toLowerCase())) {
      plans.push({ from: name, to: next, ok: false, reason: "与本次另一个文件的目标名重复" });
      continue;
    }
    seen.add(next.toLowerCase());
    if (fs.existsSync(path.join(base, next))) {
      plans.push({ from: name, to: next, ok: false, reason: "目标文件已存在" });
      continue;
    }
    plans.push({ from: name, to: next, ok: true });
  }

  const dryRun = opts.dryRun !== false;
  if (dryRun) return { dir: relOf(root, base), dry_run: true, items: plans, renamed: 0 };

  let renamed = 0;
  for (const p of plans) {
    if (!p.ok) continue;
    try {
      fs.renameSync(path.join(base, p.from), path.join(base, p.to));
      renamed += 1;
    } catch (err) {
      p.ok = false;
      p.reason = err instanceof Error ? err.message : String(err);
    }
  }
  return { dir: relOf(root, base), dry_run: false, items: plans, renamed };
}

/** 移动/归档：把文件移进子目录（分类归整的基本操作） */
export function moveFiles(
  root: string,
  opts: { files: string[]; targetDir: string },
): { moved: number; items: Array<{ from: string; to: string; ok: boolean; reason?: string }> } {
  const dir = resolveInside(root, opts.targetDir);
  fs.mkdirSync(dir, { recursive: true });
  assertInside(root, realpathOrSelf(dir));

  const items = opts.files.slice(0, 500).map((f) => {
    const from = resolveInside(root, f);
    const to = path.join(dir, path.basename(from));
    assertInside(root, to);
    try {
      if (!fs.existsSync(from)) return { from: f, to: relOf(root, to), ok: false, reason: "源文件不存在" };
      if (fs.existsSync(to)) return { from: f, to: relOf(root, to), ok: false, reason: "目标已存在" };
      fs.renameSync(from, to);
      return { from: f, to: relOf(root, to), ok: true };
    } catch (err) {
      return { from: f, to: relOf(root, to), ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  return { moved: items.filter((i) => i.ok).length, items };
}

/* ---------------- 内部工具 ---------------- */

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function relOf(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/") || ".";
}

function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function mtimeOf(p: string): number {
  try {
    return Math.floor(fs.statSync(p).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

/** 用户输入的正则是不可信输入：编译失败必须报错，不能静默不匹配 */
function safeRegex(pattern: string, flags = "g"): RegExp {
  const f = [...new Set((flags || "g").split(""))].filter((c) => "gimsuy".includes(c)).join("");
  try {
    return new RegExp(pattern, f.includes("g") ? f : `${f}g`);
  } catch (err) {
    throw new ToolError(`正则表达式无效：${err instanceof Error ? err.message : String(err)}`);
  }
}
