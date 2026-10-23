/**
 * 极简 Markdown 渲染器（L1 自研）。
 *
 * 为什么不用 marked / markdown-it：
 *  本机策略禁止装包，依赖列表里也没有它们。自己实现一份"够用且安全"的子集，
 *  比塞一个来路不明的渲染器更可控。
 *
 * 安全底线（这是全项目唯一用 v-html 的地方）：
 *  1. 先 escape 全部 HTML，原文里的 <script> 只会变成可见文本；
 *  2. 链接只放行 http/https/mailto，javascript: / data: 一律当普通文本；
 *  3. 不接受任何 HTML 透传，渲染结果里的标签全部由本文件生成。
 *
 * 支持：标题、粗体/斜体/删除线、行内代码、围栏代码块、链接、有序/无序列表（含一层嵌套）、
 *      引用、分隔线、表格。流式输出时未闭合的代码块会自动补全，不会把后面的正文吞掉。
 */

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** 私有区字符做占位符：正文里出现它的概率极低，且入口处会被剔除 */
const MARK = "\uE000";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

/** 链接白名单：解析不了的直接不生成 <a>，退回纯文本 */
function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (/^https?:\/\/[^\s]+$/i.test(url)) return url;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(url)) return url;
  return null;
}

/** 行内语法。顺序有讲究：先转义 → 再保护代码/链接 → 最后处理强调 */
function inline(src: string): string {
  const tokens: string[] = [];
  const stash = (html: string): string => {
    tokens.push(html);
    return `${MARK}${tokens.length - 1}${MARK}`;
  };

  let out = escapeHtml(src);

  // 行内代码最先：里面的 * _ [ ] 不该被当语法
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => stash(`<code>${code}</code>`));

  // 链接：URL 部分已在转义后，& 变成 &amp; 正好是属性需要的形状
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
    const href = safeUrl(url);
    if (!href) return m;
    return stash(`<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`);
  });

  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, "$1<em>$2</em>");

  return out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_m, idx: string) => tokens[Number(idx)] ?? "");
}
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEAD_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

type ListItem = { indent: number; ordered: boolean; content: string };

/** 单元格切分：去掉首尾竖线后按 | 拆分 */
function cells(row: string): string[] {
  return row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

function buildList(items: ListItem[], from: number, indent: number): { html: string; next: number } {
  const ordered = items[from]?.ordered ?? false;
  const parts: string[] = [];
  let i = from;
  while (i < items.length && items[i]!.indent >= indent) {
    const cur = items[i]!;
    // 同一层级切换列表类型（- 变 1.）就是新列表，不能并进同一个 <ul>
    if (cur.indent === indent && cur.ordered !== ordered) break;
    if (cur.indent > indent) {
      const sub = buildList(items, i, cur.indent);
      const last = parts.length - 1;
      if (last >= 0) parts[last] = parts[last]!.replace(/<\/li>$/, sub.html + "</li>");
      i = sub.next;
      continue;
    }
    parts.push(`<li>${inline(cur.content)}</li>`);
    i += 1;
  }
  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}>${parts.join("")}</${tag}>`, next: i };
}

function renderBlocks(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2] ?? "";
      const body: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        const cur = lines[i]!;
        if (FENCE_RE.test(cur) && cur.trim().startsWith(marker[0]!)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(cur);
        i += 1;
      }
      // 流式输出时围栏还没闭合：照常渲染成代码块，不能把后面的正文吞进段落
      void closed;
      const cls = lang ? ` class="lang-${escapeHtml(lang).replace(/[^\w-]/g, "")}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const head = HEAD_RE.exec(line);
    if (head) {
      const level = head[1]!.length;
      out.push(`<h${level}>${inline(head[2]!.trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i]!)) {
        inner.push(QUOTE_RE.exec(lines[i]!)![1] ?? "");
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(inner.join("\n"))}</blockquote>`);
      continue;
    }    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        body.push(cells(lines[i]!));
        i += 1;
      }
      const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
      const rows = body
        .map((r) => `<tr>${head.map((_c, idx) => `<td>${inline(r[idx] ?? "")}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`);
      continue;
    }

    const list = LIST_RE.exec(line);
    if (list) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]!);
        if (m) {
          items.push({
            indent: (m[1] ?? "").replace(/\t/g, "    ").length,
            ordered: /\d/.test(m[2]!),
            content: m[3] ?? "",
          });
          i += 1;
          continue;
        }
        // 列表项之间的空行不打断列表，但连续空行要停
        if (!lines[i]!.trim() && i + 1 < lines.length && LIST_RE.test(lines[i + 1]!)) {
          i += 1;
          continue;
        }
        break;
      }
      // 一次收集可能含多个列表（中间夹空行或换列表类型），按块逐个产出
      let at = 0;
      while (at < items.length) {
        const built = buildList(items, at, items[at]!.indent);
        out.push(built.html);
        at = built.next;
      }
      continue;
    }

    // 段落：连续非空行合并，行内换行按 Markdown 规则转成空格
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !FENCE_RE.test(lines[i]!) && !HEAD_RE.test(lines[i]!) && !HR_RE.test(lines[i]!) && !QUOTE_RE.test(lines[i]!) && !LIST_RE.test(lines[i]!)) {
      para.push(lines[i]!.trim());
      i += 1;
    }
    out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br />")}</p>`);
  }

  return out.join("");
}

/** 入口：Markdown 文本 → 安全 HTML。空输入返回空串，调用方据此跳过 v-html */
export function renderMarkdown(src: string): string {
  if (!src) return "";
  return renderBlocks(src.replace(/[\uE000\uE001]/g, ""));
}