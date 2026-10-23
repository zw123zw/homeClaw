/**
 * 附件在客户端的处理：压缩、编码、预览 URL 缓存。
 *
 * 三个约束决定了这里的写法：
 *  1. 上行是 base64 JSON（HomeHub 没装 multipart），所以要在前端控制体积；
 *  2. 附件读取要带用户票据，不能直接 <img src>，必须 fetch 成 blob URL；
 *  3. blob URL 必须显式 revoke，否则预览几次就把内存吃满。
 */
import { fetchAttachmentBlob } from "@/api/client";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 5;
/** 图片最长边：超过就等比缩小，视觉无损但体积能降一个量级 */
export const IMAGE_MAX_EDGE = 2048;
export const IMAGE_QUALITY = 0.85;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

/** data URL 只取 base64 段：HomeHub 的 data 字段不含前缀 */
export function stripDataUrl(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ""));
    fr.onerror = () => reject(new Error("文件读取失败"));
    fr.readAsDataURL(blob);
  });
}

/**
 * 图片压缩：canvas 重绘后按 WebP 导出。
 * 任何一步失败（超大图、解码失败、浏览器不支持 webp）都退回原图，
 * 宁可上传大一点，也不能因为"优化"把用户文件弄丢。
 */
export async function compressImage(file: File): Promise<Blob> {
  if (!isImage(file.type) || file.type === "image/gif" || file.type === "image/svg+xml") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", IMAGE_QUALITY));
    if (!blob) return file;
    // 压完反而更大（小图或已高度压缩的图）时保留原文件
    return blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

export type PreparedUpload = { name: string; mime: string; data: string; size: number };

/** File → 上行载荷。超过上限直接抛错，让 UI 给出可读提示而不是等 413 */
export async function prepareUpload(file: File): Promise<PreparedUpload> {
  const blob = await compressImage(file);
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} 超过 20MB`);
  const dataUrl = await readAsDataUrl(blob);
  return {
    name: file.name,
    mime: blob.type || file.type || "application/octet-stream",
    data: stripDataUrl(dataUrl),
    size: blob.size,
  };
}

/* ---------------- 预览 URL 缓存 ---------------- */

const urls = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

/**
 * 取附件可显示 URL。同 id 只下载一次，多个卡片共用同一个 blob URL，
 * 所以 revoke 只在会话整体清理时做（见 releaseAllAttachmentUrls）。
 */
export function attachmentUrl(id: string): Promise<string> {
  const hit = urls.get(id);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(id);
  if (inflight) return inflight;

  const task = fetchAttachmentBlob(id)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      urls.set(id, url);
      pending.delete(id);
      return url;
    })
    .catch((err: unknown) => {
      pending.delete(id);
      throw err;
    });

  pending.set(id, task);
  return task;
}

export function releaseAllAttachmentUrls(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  pending.clear();
}