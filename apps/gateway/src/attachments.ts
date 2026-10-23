import type { Attachment } from "@homeclaw/contracts";
import type { HubClient } from "./hub-client.ts";
import type { LlmContentPart, LlmUserContent } from "./llm.ts";

/** 文本附件进 prompt 的截断长度：太长的日志会挤掉工具 schema 预算 */
const MAX_TEXT_CHARS = 20_000;
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml))/i;
const TEXT_EXT = /\.(md|markdown|txt|csv|json|ya?ml|log|ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|html|sql|sh)$/i;

function isTextLike(a: Attachment): boolean {
  return a.kind === "text" || TEXT_MIME.test(a.mime) || TEXT_EXT.test(a.name);
}

function decodeText(bytes: Buffer): string {
  // 二进制内容不该被当文本塞进 prompt；解码失败直接跳过
  const s = bytes.toString("utf8");
  return s.includes("\u0000") ? "" : s.slice(0, MAX_TEXT_CHARS);
}

export type AttachmentPayload = {
  /** 直接作为 user 消息 content 传给模型 */
  content: LlmUserContent;
  /** 给 UI/日志看的摘要，不含正文 */
  summary: string;
};

/**
 * 把附件转成模型输入。
 *
 * 规则：
 *  - 图片 → data URL，走 OpenAI 兼容的 image_url 块。
 *    不要求用户预先声明模型是否支持视觉：上游拒绝时 llm.ts 会自动摘掉图片重试一次。
 *  - 文本类（含代码/JSON/CSV）→ 截断后拼进 prompt；
 *  - 其余（PDF/Office/音视频）→ 只给文件名与类型，不伪造解析结果。
 */
export async function buildAttachmentPayload(
  attachments: Attachment[],
  opts: { hub: HubClient },
): Promise<AttachmentPayload> {
  if (attachments.length === 0) return { content: "", summary: "" };

  const parts: LlmContentPart[] = [];
  const notes: string[] = [];

  for (const a of attachments) {
    const head = `[附件] ${a.name}（${a.mime || "未知类型"}，${formatSize(a.size)}）`;

    if (a.kind === "image") {
      try {
        const { bytes, mime } = await opts.hub.attachment(a.id);
        const mimeSafe = mime.split(";")[0]?.trim() || "image/png";
        parts.push({ type: "image_url", image_url: { url: `data:${mimeSafe};base64,${bytes.toString("base64")}` } });
        notes.push(`${head} 已作为图片输入`);
      } catch {
        notes.push(`${head} 读取失败，仅按文件名理解`);
      }
      continue;
    }


    if (isTextLike(a)) {
      try {
        const { bytes } = await opts.hub.attachment(a.id);
        const text = decodeText(bytes);
        if (text) {
          notes.push(`${head} 内容如下：\n\`\`\`\n${text}\n\`\`\``);
        } else {
          notes.push(`${head} 无法按文本解码`);
        }
      } catch {
        notes.push(`${head} 读取失败，仅按文件名理解`);
      }
      continue;
    }

    notes.push(`${head} 暂不支持内容解析，仅按文件名理解`);
  }

  const noteText = notes.join("\n\n");
  if (parts.length === 0) return { content: noteText, summary: noteText };

  parts.unshift({ type: "text", text: noteText });
  return { content: parts, summary: noteText };
}

function formatSize(size: number): string {
  if (!size) return "未知大小";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
