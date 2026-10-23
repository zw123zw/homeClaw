import fs from "node:fs";
import path from "node:path";
import type { Llm } from "../llm.ts";
import { readDoc, detectKind } from "./doc-read.ts";
import { listFiles, readTextFile, writeTextFile, renameBatch, moveFiles, resolveInside, ToolError } from "./file-ops.ts";
import { webFetch } from "./web.ts";

/**
 * 内置工具注册表（Gateway 侧）。
 *
 * 两条执行路径共用同一张表：
 *  1. 自研薄循环（agent.ts）通过本地 MCP 服务调用；
 *  2. Hermes 也通过同一个本地 MCP 服务调用（写进 HERMES_HOME/config.yaml 的 mcp.servers）。
 * 共用是刻意的 —— 两套实现必然漂移，而"同一句话在两条路径下结果不同"是最难解释的 bug。
 *
 * 每个工具都必须：
 *  - 说明自己做什么（模型据此选择）；
 *  - 声明 inputSchema（模型据此传参）；
 *  - 在失败时返回 ok:false + 可读原因，绝不假装成功。
 */
export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
};

export type ToolResult = { ok: boolean; summary: string; data?: unknown; error?: string };

export type ToolRegistry = {
  list: () => ToolSpec[];
  get: (name: string) => ToolSpec | undefined;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /** 给 MCP tools/list 用的公开形状 */
  describe: () => Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
};

export type RegistryOptions = {
  /**
   * 沙箱根：所有文件类工具只能在此目录内活动。
   *
   * 允许传函数：用户在设置里改工作目录后必须立刻生效。
   * 注册表是启动时建的常驻对象，缓存成常量就会出现「设置改了还按旧目录执行」。
   */
  workspaceRoot: string | (() => string);
  /** 生成摘要/翻译时用；没有模型时这两个工具返回明确失败 */
  llm?: () => Llm | undefined;
};

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});

export function createToolRegistry(opts: RegistryOptions): ToolRegistry {
  const root = (): string => {
    const dir = path.resolve(typeof opts.workspaceRoot === "function" ? opts.workspaceRoot() : opts.workspaceRoot);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const tools: ToolSpec[] = [
    {
      name: "file_list",
      description: "列出工作目录下的文件与子目录（不递归越界，跳过隐藏目录与 node_modules）。用于先看清有哪些文件再操作。",
      inputSchema: obj(
        {
          dir: { type: "string", description: "相对工作目录的子目录，默认根目录" },
          recursive: { type: "boolean", description: "是否递归子目录，默认 false" },
          pattern: { type: "string", description: "文件名过滤（正则，如 ^\\d{4}-.*\\.xlsx$）" },
          limit: { type: "number", description: "最多返回条数，默认 200" },
        },
      ),
      async run(args) {
        const res = listFiles(root(), {
          ...(typeof args.dir === "string" ? { dir: args.dir } : {}),
          ...(typeof args.recursive === "boolean" ? { recursive: args.recursive } : {}),
          ...(typeof args.pattern === "string" ? { pattern: args.pattern } : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        });
        return {
          ok: true,
          summary: `${res.dir} 下有 ${res.entries.length} 项${res.truncated ? "（已截断）" : ""}`,
          data: res,
        };
      },
    },
    {
      name: "file_read",
      description: "读取工作目录内的纯文本文件（txt/md/csv/json/yaml/代码）。PDF/Word/Excel/PPT 请用 doc_read。",
      inputSchema: obj(
        {
          path: { type: "string", description: "相对工作目录的文件路径" },
          max_chars: { type: "number", description: "最多返回多少字符，默认 60000" },
        },
        ["path"],
      ),
      async run(args) {
        const p = str(args.path);
        if (!p) return { ok: false, summary: "缺少 path", error: "需要 path" };
        const res = readTextFile(root(), { path: p, ...(typeof args.max_chars === "number" ? { maxChars: args.max_chars } : {}) });
        return {
          ok: true,
          summary: `已读取 ${p}（${res.text.length} 字${res.truncated ? "，已截断" : ""}）`,
          data: res,
        };
      },
    },
    {
      name: "doc_read",
      description: "提取文档正文：PDF / Word(docx) / Excel(xlsx,csv) / PPT(pptx) / Markdown / 纯文本。返回纯文本，不还原排版。",
      inputSchema: obj(
        {
          path: { type: "string", description: "相对工作目录的文件路径" },
        },
        ["path"],
      ),
      async run(args) {
        const p = str(args.path);
        if (!p) return { ok: false, summary: "缺少 path", error: "需要 path" };
        const abs = resolveInside(root(), p);
        const buf = fs.readFileSync(abs);
        const res = readDoc(buf, path.basename(abs));
        return {
          ok: res.ok,
          summary: res.ok ? `已提取 ${p}（${res.kind}，${res.text.length} 字）` : res.text,
          data: res.ok ? { kind: res.kind, text: res.text } : undefined,
          ...(res.ok ? {} : { error: res.text }),
        };
      },
    },
    {
      name: "file_write",
      description: "在工作目录内写文本文件（md/txt/json/csv）。默认不覆盖已存在文件，需覆盖时传 overwrite=true。",
      inputSchema: obj(
        {
          path: { type: "string", description: "相对工作目录的文件路径" },
          content: { type: "string", description: "文件内容（纯文本）" },
          overwrite: { type: "boolean", description: "是否覆盖已存在的文件" },
        },
        ["path", "content"],
      ),
      async run(args) {
        const p = str(args.path);
        const content = typeof args.content === "string" ? args.content : "";
        if (!p) return { ok: false, summary: "缺少 path", error: "需要 path" };
        if (!content) return { ok: false, summary: "内容为空", error: "content 不能为空" };
        const res = writeTextFile(root(), { path: p, content, overwrite: args.overwrite === true });
        return {
          ok: true,
          summary: `${res.created ? "已创建" : "已覆盖"} ${res.path}（${res.bytes} 字节）`,
          data: res,
        };
      },
    },
    {
      name: "file_rename",
      description: "按正则批量重命名目录内的文件。默认只预演（dry_run），确认无误后传 dry_run=false 才真正改名。",
      inputSchema: obj(
        {
          dir: { type: "string", description: "目标子目录，默认根目录" },
          pattern: { type: "string", description: "匹配用正则，如 (\\d{2})-(\\d{2})-(\\d{4})" },
          replacement: { type: "string", description: "替换模板，如 $3-$1-$2" },
          flags: { type: "string", description: "正则修饰符，默认 g" },
          exts: { type: "array", items: { type: "string" }, description: "只处理这些扩展名，如 ['jpg','png']" },
          dry_run: { type: "boolean", description: "true=只预演（默认），false=真正执行" },
        },
        ["pattern", "replacement"],
      ),
      async run(args) {
        const pattern = str(args.pattern);
        const replacement = typeof args.replacement === "string" ? args.replacement : "";
        if (!pattern) return { ok: false, summary: "缺少 pattern", error: "需要 pattern" };
        const res = renameBatch(root(), {
          ...(typeof args.dir === "string" ? { dir: args.dir } : {}),
          pattern,
          replacement,
          ...(typeof args.flags === "string" ? { flags: args.flags } : {}),
          ...(Array.isArray(args.exts) ? { exts: args.exts.filter((x): x is string => typeof x === "string") } : {}),
          dryRun: args.dry_run !== false,
        });
        const bad = res.items.filter((i) => !i.ok).length;
        return {
          ok: true,
          summary: res.dry_run
            ? `预演：${res.items.length} 个文件会被改名${bad ? `，${bad} 个有冲突` : ""}`
            : `已改名 ${res.renamed} 个文件${bad ? `，${bad} 个失败` : ""}`,
          data: res,
        };
      },
    },
    {
      name: "file_move",
      description: "把若干文件移动到工作目录内的目标子目录（分类归档用）。目标已存在同名文件时跳过。",
      inputSchema: obj(
        {
          files: { type: "array", items: { type: "string" }, description: "要移动的相对路径列表" },
          target_dir: { type: "string", description: "目标子目录，如 合同/2026" },
        },
        ["files", "target_dir"],
      ),
      async run(args) {
        const files = Array.isArray(args.files) ? args.files.filter((x): x is string => typeof x === "string") : [];
        const target = str(args.target_dir);
        if (!files.length) return { ok: false, summary: "没有要移动的文件", error: "files 不能为空" };
        if (!target) return { ok: false, summary: "缺少 target_dir", error: "需要 target_dir" };
        const res = moveFiles(root(), { files, targetDir: target });
        return {
          ok: res.moved > 0,
          summary: `已移动 ${res.moved}/${files.length} 个文件到 ${target}`,
          data: res,
        };
      },
    },
    {
      name: "web_fetch",
      description: "抓取网页并转成纯文本（联网调研用）。只支持 http/https 公网地址，不支持需要 JS 渲染的页面。",
      inputSchema: obj(
        {
          url: { type: "string", description: "完整网址" },
          max_chars: { type: "number", description: "最多返回多少字符，默认 30000" },
        },
        ["url"],
      ),
      async run(args) {
        const url = str(args.url);
        if (!url) return { ok: false, summary: "缺少 url", error: "需要 url" };
        const res = await webFetch(url, { ...(typeof args.max_chars === "number" ? { maxChars: args.max_chars } : {}) });
        return {
          ok: res.ok,
          summary: res.ok ? `已抓取 ${res.title ?? res.url}（${res.text.length} 字）` : `抓取失败：${res.error ?? "未知原因"}`,
          data: res.ok ? res : undefined,
          ...(res.ok ? {} : { error: res.error }),
        };
      },
    },
    llmTool("file_summarize", "批量读取工作目录内的文档并逐份生成摘要（需要已配置模型）。", opts, root, async (llm, text) => {
      const turn = await llm.chat({
        messages: [
          { role: "system", content: "你是文档摘要助手。用中文输出 3-5 条要点，不要复述标题，不要编造原文没有的内容。" },
          { role: "user", content: text },
        ],
        tools: [],
        maxTokens: 600,
      });
      return turn.kind === "text" ? turn.text : "";
    }),
    llmTool("file_translate", "批量读取工作目录内的文档并翻译（需要已配置模型）。默认译成中文。", opts, root, async (llm, text, args) => {
      const to = typeof args.target === "string" && args.target ? args.target : "简体中文";
      const turn = await llm.chat({
        messages: [
          { role: "system", content: `你是翻译。把用户内容翻译成${to}，保留段落结构与专有名词，不要加解释。` },
          { role: "user", content: text },
        ],
        tools: [],
        maxTokens: 2000,
      });
      return turn.kind === "text" ? turn.text : "";
    }),
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));

  return {
    list: () => tools,
    get: (name) => byName.get(name),
    describe: () => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    async call(name, args) {
      const tool = byName.get(name);
      if (!tool) return { ok: false, summary: `没有这个工具：${name}`, error: "unknown_tool" };
      try {
        return await tool.run(args ?? {});
      } catch (err) {
        // ToolError 是"用户输入问题"，其余是内部错误；两者都要如实报给模型
        const message = err instanceof ToolError ? err.message : err instanceof Error ? err.message : String(err);
        return { ok: false, summary: message, error: message };
      }
    },
  };
}

/** 摘要/翻译这类"读文件 + 调模型"的工具：骨架一致，只有提示词不同 */
function llmTool(
  name: string,
  description: string,
  opts: RegistryOptions,
  root: () => string,
  run: (llm: Llm, text: string, args: Record<string, unknown>) => Promise<string>,
): ToolSpec {
  // 工作目录每次调用现取：设置改了立刻生效
  return {
    name,
    description,
    inputSchema: obj(
      {
        files: { type: "array", items: { type: "string" }, description: "要处理的相对路径列表" },
        target: { type: "string", description: "翻译目标语言（仅 file_translate），默认简体中文" },
      },
      ["files"],
    ),
    async run(args) {
      const llm = opts.llm?.();
      if (!llm) return { ok: false, summary: "未配置模型，无法执行该操作", error: "no_model" };

      const files = Array.isArray(args.files) ? args.files.filter((x): x is string => typeof x === "string") : [];
      if (!files.length) return { ok: false, summary: "没有指定文件", error: "files 不能为空" };

      const out: Array<{ file: string; ok: boolean; text: string }> = [];
      for (const f of files.slice(0, 20)) {
        try {
          const abs = resolveInside(root(), f);
          const buf = fs.readFileSync(abs);
          const kind = detectKind(path.basename(abs), "");
          const doc = kind === "text"
            ? { ok: true, text: buf.toString("utf8").slice(0, 20_000) }
            : readDoc(buf, path.basename(abs));
          if (!doc.ok || !doc.text.trim()) {
            out.push({ file: f, ok: false, text: doc.text || "没有可读内容" });
            continue;
          }
          const text = await run(llm, doc.text, args);
          out.push({ file: f, ok: Boolean(text.trim()), text });
        } catch (err) {
          out.push({ file: f, ok: false, text: err instanceof Error ? err.message : String(err) });
        }
      }

      const okCount = out.filter((o) => o.ok).length;
      return {
        ok: okCount > 0,
        summary: `处理完成 ${okCount}/${files.length} 个文件`,
        data: { items: out },
      };
    },
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 给模型看的一句话摘要：工具卡标题用它，不要把参数 JSON 直接甩到界面上 */
export function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const p = typeof args.path === "string" ? args.path : "";
  switch (name) {
    case "file_list":
      return `查看目录 ${typeof args.dir === "string" && args.dir ? args.dir : "根目录"}`;
    case "file_read":
      return `读取 ${p}`;
    case "doc_read":
      return `解析文档 ${p}`;
    case "file_write":
      return `写入 ${p}`;
    case "file_rename":
      return `批量改名 ${String(args.pattern ?? "")} → ${String(args.replacement ?? "")}`;
    case "file_move":
      return `归档 ${Array.isArray(args.files) ? args.files.length : 0} 个文件`;
    case "web_fetch":
      return `抓取网页 ${String(args.url ?? "")}`.slice(0, 80);
    case "file_summarize":
      return `批量摘要 ${Array.isArray(args.files) ? (args.files as string[]).length : 0} 个文件`;
    case "file_translate":
      return `批量翻译 ${Array.isArray(args.files) ? (args.files as string[]).length : 0} 个文件`;
    default:
      return name;
  }
}