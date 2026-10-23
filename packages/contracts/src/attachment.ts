import { z } from "zod";

/** 附件类型只用于选择预览方式，不参与权限判断 */
export const AttachmentKind = z.enum(["image", "pdf", "text", "audio", "video", "file"]);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

/**
 * 附件元数据。url 是 HomeHub 的读取地址；previewUrl 只存在于客户端乐观消息，
 * 服务端回声与历史记录不会带它。
 */
export const Attachment = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(260),
  mime: z.string().default("application/octet-stream"),
  size: z.number().int().nonnegative().default(0),
  kind: AttachmentKind.default("file"),
  url: z.string().default(""),
  previewUrl: z.string().optional(),
});
export type Attachment = z.infer<typeof Attachment>;
