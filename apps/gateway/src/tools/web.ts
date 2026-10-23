/**
 * 联网抓取（web_fetch）：把网页转成纯文本给模型读。
 *
 * 边界刻意收得很紧：
 *  - 只允许 http/https，且拒绝本机/内网地址 —— 否则模型一句 "fetch http://127.0.0.1:4020/v1/..." 就能
 *    让网关自己打自己的内部接口，绕过票据鉴权；
 *  - 只取 HTML/纯文本，其它（图片/压缩包/二进制）明说不可读；
 *  - 限制字节数与字符数，超时 15s。网页正文动辄几百 KB，全塞进上下文只会挤掉工具 schema。
 *
 * 不做 JS 渲染：需要渲染的站点返回"空正文"时如实告知，而不是编造内容。
 */

const MAX_BYTES = 2_000_000;
const MAX_CHARS = 30_000;
const TIMEOUT_MS = 15_000;

export type FetchResult = { ok: boolean; url: string; title?: string; text: string; truncated: boolean; error?: string };

/** 内网/回环判定：按主机名与解析后的字面量判断，不看 DNS（避免 DNS rebinding 讨论，先按字面量挡） */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export async function webFetch(url: string, opts: { maxChars?: number; signal?: AbortSignal } = {}): Promise<FetchResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, url, text: "", truncated: false, error: "URL 不合法" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, url, text: "", truncated: false, error: "只支持 http/https" };
  }
  if (isPrivateHost(u.hostname)) {
    return { ok: false, url, text: "", truncated: false, error: "不允许访问本机或内网地址" };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(u.toString(), {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        // 伪装成普通浏览器：不少站点对非浏览器 UA 直接 403
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HomeClaw/1.0",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });

    if (!res.ok) {
      return { ok: false, url: u.toString(), text: "", truncated: false, error: `HTTP ${res.status}` };
    }

    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!/text\/html|text\/plain|application\/xhtml|application\/json|text\/xml/.test(ctype)) {
      return { ok: false, url: u.toString(), text: "", truncated: false, error: `不支持的内容类型：${ctype || "未知"}` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      return { ok: false, url: u.toString(), text: "", truncated: false, error: "页面超过 2MB，请换更具体的地址" };
    }

    const raw = decodeBody(buf, ctype);
    const max = Math.max(500, Math.min(opts.maxChars ?? MAX_CHARS, MAX_CHARS));
    const isHtml = /html|xml/.test(ctype);
    const title = isHtml ? matchTitle(raw) : undefined;
    const text = isHtml ? htmlToText(raw) : raw;
    const cut = text.length > max;

    return {
      ok: true,
      url: u.toString(),
      ...(title ? { title } : {}),
      text: cut ? text.slice(0, max) : text,
      truncated: cut,
    };
  } catch (err) {
    const aborted = ac.signal.aborted;
    return {
      ok: false,
      url: u.toString(),
      text: "",
      truncated: false,
      error: aborted ? `抓取超时（${TIMEOUT_MS / 1000}s）` : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** 编码：先看 meta charset，再按 UTF-8 解；解出大量替换符时回退 GBK（中文站点常见） */
function decodeBody(buf: Buffer, ctype: string): string {
  const fromHeader = /charset=([\w-]+)/i.exec(ctype)?.[1];
  const head = buf.subarray(0, 2048).toString("latin1");
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  const charset = (fromHeader ?? fromMeta ?? "utf-8").toLowerCase();

  const tryDecode = (cs: string): string | null => {
    try {
      return new TextDecoder(cs).decode(buf);
    } catch {
      return null;
    }
  };

  const primary = tryDecode(charset) ?? tryDecode("utf-8");
  if (primary === null) return buf.toString("utf8");
  // 替换符占比过高说明编码猜错：GBK 页面按 UTF-8 解会满屏 
  const bad = (primary.match(/\uFFFD/g) ?? []).length;
  if (bad > 20 && /gb|big5/.test(charset) === false) {
    const gb = tryDecode("gb18030");
    if (gb && (gb.match(/\uFFFD/g) ?? []).length < bad) return gb;
  }
  return primary;
}

function matchTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  return m?.[1] ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : undefined;
}

/**
 * HTML → 纯文本。
 *
 * 只用正则，不引 DOM 解析器：这里的目标是"给模型读正文"，
 * 不是还原网页。先删 script/style/nav/footer（这些是噪声主体），
 * 再把块级标签换成换行，最后压掉多余空行。
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, " ");

  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<t[dh][^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");

  s = decodeEntities(s);
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 只处理最常见的命名实体与数字实体：网页正文里 99% 就是这几个 */
export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", hellip: "…", mdash: "—", ndash: "–",
    copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", times: "×", divide: "÷",
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 1 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}