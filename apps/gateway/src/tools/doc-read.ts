import zlib from "node:zlib";
import { readZip } from "./zip.ts";

/**
 * 文档读取（PDF / Word / Excel / PPT / 纯文本）。
 *
 * 定位：**够用**，不追求排版还原。目标是让模型拿到"内容"，
 * 而不是把一份 docx 渲染成 Markdown。
 *
 * 每种格式都走最短路径：
 *  - docx / pptx / xlsx：ZIP 里取 XML，剥标签，按段落断行；
 *  - pdf：解 Flate 流，取文本绘制操作符里的字符串；扫不出来就明说，不编内容；
 *  - 其余：按 UTF-8 解，二进制（含 \0）拒绝。
 *
 * 所有"读不出来"都必须返回明确的失败原因。假装读到了空内容，
 * 模型就会基于零信息编答案 —— 这是最难事后发现的一类错误。
 */
export type DocKind = "pdf" | "word" | "excel" | "ppt" | "text" | "unknown";

/** 单文档上限：再大就该走 RAG，硬塞进 prompt 只会挤掉工具 schema */
const MAX_CHARS = 60_000;

export function detectKind(name: string, mime: string): DocKind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "word";
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return "excel";
  if (ext === "pptx" || ext === "ppt") return "ppt";
  if (/^(text\/|application\/(json|xml|javascript|yaml))/.test(mime)) return "text";
  if (/\.(md|markdown|txt|json|ya?ml|log|ini|toml|html|htm|ts|js|py|sh)$/.test(ext)) return "text";
  return "unknown";
}

export function readDoc(buf: Buffer, name: string, mime = ""): { ok: boolean; text: string; kind: DocKind } {
  const kind = detectKind(name, mime);
  try {
    switch (kind) {
      case "pdf":
        return withText(kind, pdfText(buf));
      case "word":
        return withText(kind, docxText(buf));
      case "excel":
        return withText(kind, xlsxText(buf));
      case "ppt":
        return withText(kind, pptxText(buf));
      case "text":
        return withText(kind, plainText(buf));
      default:
        return { ok: false, text: `不支持的文件类型（${mime || name}）。可用：PDF / Word / Excel / PPT / 纯文本。`, kind };
    }
  } catch (err) {
    return { ok: false, text: `读取失败：${err instanceof Error ? err.message : String(err)}`, kind };
  }
}

function withText(kind: DocKind, raw: string): { ok: boolean; text: string; kind: DocKind } {
  const text = cleanup(raw);
  if (!text.trim()) {
    return { ok: false, text: "没读到文本内容（可能是扫描件或受保护的文档）。", kind };
  }
  return { ok: true, text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n…（已截断，原文 ${text.length} 字）` : text, kind };
}

/** 去掉多余空行与控制字符；保留段落结构（模型读段落比读一行好） */
function cleanup(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---------------- Word ---------------- */

function docxText(buf: Buffer): string {
  const zip = readZip(buf);
  const doc = zip.get("word/document.xml");
  if (!doc) throw new Error("docx 缺少 word/document.xml");
  return xmlToText(doc.toString("utf8"), { br: "w:br", tab: "w:tab", para: "w:p" });
}

/* ---------------- PPT ---------------- */

function pptxText(buf: Buffer): string {
  const zip = readZip(buf);
  // slide 顺序按文件名排序：slide1, slide2, ..., slide10 —— 用数字排序避免 10 排在 2 前
  const slides = [...zip.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => num(a) - num(b));
  if (slides.length === 0) throw new Error("pptx 里没有幻灯片");
  return slides
    .map((k) => {
      const t = xmlToText(zip.get(k)!.toString("utf8"), { br: "a:br", tab: "a:tab", para: "a:p" });
      return `## 第 ${num(k)} 页\n${t}`;
    })
    .join("\n\n");
}

function num(p: string): number {
  const m = /(\d+)/.exec(p.split("/").pop() ?? "");
  return m ? Number(m[1]) : 0;
}

/* ---------------- Excel ---------------- */

/**
 * xlsx 的最小可用读法：共享字符串表 + 每个 sheet 的单元格。
 * 不处理公式计算、合并单元格、样式 —— 那些对"读内容"没有增量。
 */
function xlsxText(buf: Buffer): string {
  const zip = readZip(buf);
  const shared: string[] = [];
  const ss = zip.get("xl/sharedStrings.xml");
  if (ss) {
    for (const m of ss.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(decodeXml((m[1] ?? "").replace(/<[^>]+>/g, "")));
    }
  }

  const sheets = [...zip.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b));
  if (sheets.length === 0) throw new Error("xlsx 里没有工作表");

  const out: string[] = [];
  for (const key of sheets) {
    const xml = zip.get(key)!.toString("utf8");
    const rows: string[] = [];
    for (const rowM of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cellM of (rowM[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellM[1] ?? "";
        const body = cellM[2] ?? "";
        const isShared = /\bt="s"/.test(attrs);
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v === undefined) {
          const inline = /<is>([\s\S]*?)<\/is>/.exec(body);
          cells.push(inline ? decodeXml(inline[1]!.replace(/<[^>]+>/g, "")) : "");
          continue;
        }
        cells.push(isShared ? (shared[Number(v)] ?? "") : decodeXml(v));
      }
      if (cells.some((c) => c.trim())) rows.push(cells.join("\t"));
    }
    out.push(`### 工作表 ${num(key)}\n${rows.join("\n")}`);
  }
  return out.join("\n\n");
}

/* ---------------- PDF ---------------- */

/**
 * PDF 文本抽取。
 *
 * 真实的 PDF 是"内容流 + 字体编码"，完整还原需要字体表。
 * 这里做的是工业上常见的近似：解压所有 Flate 流，从文本绘制操作符
 * （Tj / TJ / ' / "）里取字面量，按换行操作符断行。
 * 对扫描件（纯图片）必然读不到 —— 会明确返回"没读到文本"。
 */
function pdfText(buf: Buffer): string {
  const chunks: string[] = [];
  let p = 0;

  while (p < buf.length - 6) {
    const idx = buf.indexOf("stream", p);
    if (idx < 0) break;
    let start = idx + 6;
    // stream 关键字后跟 CRLF 或 LF
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;

    const end = buf.indexOf("endstream", start);
    if (end < 0) break;

    const raw = buf.subarray(start, end);
    const text = tryInflate(raw);
    if (text) chunks.push(textFromContentStream(text));
    p = end + 9;
  }

  // 未压缩的内容流（部分生成器直接写明文）
  if (chunks.length === 0) chunks.push(textFromContentStream(buf.toString("latin1")));

  return chunks.filter(Boolean).join("\n");
}

function tryInflate(raw: Buffer): string | null {
  try {
    const out = zlib.inflateSync(raw);
    // 内容流基本都是 ASCII 操作符 + 字面量；含大量 NUL 的说明不是内容流
    const s = out.toString("latin1");
    return s.includes("\u0000") ? null : s;
  } catch {
    try {
      const out = zlib.inflateRawSync(raw);
      const s = out.toString("latin1");
      return s.includes("\u0000") ? null : s;
    } catch {
      return null;
    }
  }
}

/** 从内容流里取括号与尖括号字面量，遇 Td / TD / T* 操作符断行 */
function textFromContentStream(s: string): string {
  const out: string[] = [];
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bT[dD*]\b|\bTJ\b|\bTj\b/g;
  let line = "";

  for (const m of s.matchAll(re)) {
    const tok = m[0];
    if (tok === "Td" || tok === "TD" || tok === "T*") {
      if (line.trim()) out.push(line);
      line = "";
      continue;
    }
    if (tok === "TJ" || tok === "Tj") continue;

    if (tok.startsWith("(")) {
      line += unescapePdfString(tok.slice(1, -1));
      continue;
    }
    if (tok.startsWith("<")) {
      line += hexToText(tok.slice(1, -1));
    }
  }
  if (line.trim()) out.push(line);
  return out.join("\n");
}

function unescapePdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_all, g: string) => {
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8));
    const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };
    return map[g] ?? g;
  });
}

/** PDF 的 <hex> 多为 UTF-16BE（含中文），先按 4 位一组试，失败回退 latin1 */
function hexToText(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 4 === 0 && clean.length > 0) {
    const units: number[] = [];
    for (let i = 0; i < clean.length; i += 4) units.push(parseInt(clean.slice(i, i + 4), 16));
    const s = String.fromCharCode(...units);
    // 含可打印字符才算解码成功
    if (/[\u4e00-\u9fa5A-Za-z0-9]/.test(s)) return s;
  }
  const bytes = Buffer.from(clean, "hex");
  return bytes.toString("utf8");
}

/* ---------------- 公共 ---------------- */

function plainText(buf: Buffer): string {
  if (buf.subarray(0, 4096).includes(0)) throw new Error("这是二进制文件，不能按文本读取");
  return buf.toString("utf8");
}

/** XML → 文本：段落换行，<w:br/> 换行，剥掉其余标签 */
function xmlToText(xml: string, opts: { br: string; tab: string; para: string }): string {
  return decodeXml(
    xml
      .replace(new RegExp(`<${opts.para}\\b[^>]*/>`, "g"), "\n")
      .replace(new RegExp(`</${opts.para}>`, "g"), "\n")
      .replace(new RegExp(`<${opts.br}\\b[^>]*/>`, "g"), "\n")
      .replace(new RegExp(`<${opts.tab}\\b[^>]*/>`, "g"), "\t")
      .replace(/<[^>]+>/g, ""),
  );
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_a, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}
