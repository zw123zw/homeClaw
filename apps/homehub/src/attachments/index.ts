import fs from "node:fs";
import path from "node:path";
import type { Attachment, AttachmentKind } from "@homeclaw/contracts";
import type { Db } from "../db/index.ts";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

type AttachmentRow = {
  home_id: string;
  attachment_id: string;
  name: string;
  mime: string;
  size: number;
  kind: string;
  file_name: string;
  created_at: number;
};

export type SaveAttachmentInput = {
  name: string;
  mime?: string;
  size?: number;
  /** base64（不含 data: 前缀） */
  data: string;
};

export function attachmentKind(mime: string, name: string): AttachmentKind {
  const m = mime.toLowerCase();
  const ext = path.extname(name).toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf" || ext === ".pdf") return "pdf";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (
    m.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript", "application/x-yaml"].includes(m) ||
    [".md", ".markdown", ".txt", ".csv", ".json", ".yaml", ".yml", ".log", ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".css", ".html", ".sql", ".sh"].includes(ext)
  ) {
    return "text";
  }
  return "file";
}

/** 浏览器能安全内联展示的类型；HTML/SVG 一律降级为纯文本，避免同源脚本执行 */
function safeMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m === "text/html" || m === "image/svg+xml" || m === "application/xhtml+xml" || m.endsWith("+xml")) {
    return "text/plain; charset=utf-8";
  }
  return mime || "application/octet-stream";
}

const EXT_RE = /^\.[a-z0-9]{1,12}$/i;

export class Attachments {
  private readonly db: Db;
  private readonly homeId: string;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly newId: (prefix: string) => string;

  constructor(opts: {
    db: Db;
    homeId: string;
    dir: string;
    now: () => number;
    newId: (prefix: string) => string;
  }) {
    this.db = opts.db;
    this.homeId = opts.homeId;
    this.dir = opts.dir;
    this.now = opts.now;
    this.newId = opts.newId;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  save(input: SaveAttachmentInput): Attachment {
    const name = input.name.trim().slice(0, 260) || "未命名文件";
    const mime = (input.mime || "application/octet-stream").slice(0, 160);
    const raw = input.data.replace(/^data:[^;]+;base64,/, "");
    const bytes = Buffer.from(raw, "base64");
    if (bytes.length === 0) throw new Error("文件内容为空");
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("单个附件不能超过 20MB");

    const id = this.newId("att");
    let ext = path.extname(name).toLowerCase();
    if (!EXT_RE.test(ext)) ext = "";
    const fileName = `${id}${ext}`;
    fs.writeFileSync(path.join(this.dir, fileName), bytes, { flag: "wx" });

    const kind = attachmentKind(mime, name);
    this.db.run(
      `INSERT INTO attachments (home_id, attachment_id, name, mime, size, kind, file_name, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      this.homeId, id, name, mime, bytes.length, kind, fileName, this.now(),
    );

    return {
      id,
      name,
      mime,
      size: bytes.length,
      kind,
      url: `/v1/attachments/${encodeURIComponent(id)}`,
    };
  }

  find(id: string): { meta: AttachmentRow; file: string } | undefined {
    const row = this.db.one<AttachmentRow>(
      "SELECT * FROM attachments WHERE home_id = ? AND attachment_id = ?",
      this.homeId, id,
    );
    if (!row) return undefined;
    const file = path.join(this.dir, row.file_name);
    if (!fs.existsSync(file)) return undefined;
    return { meta: row, file };
  }

  /** 供 HTTP 层直接写流；返回 null 表示不存在 */
  read(id: string): { attachment: Attachment; bytes: Buffer; mime: string; fileName: string } | null {
    const found = this.find(id);
    if (!found) return null;
    return {
      attachment: {
        id: found.meta.attachment_id,
        name: found.meta.name,
        mime: found.meta.mime,
        size: found.meta.size,
        kind: found.meta.kind as AttachmentKind,
        url: `/v1/attachments/${encodeURIComponent(found.meta.attachment_id)}`,
      },
      bytes: fs.readFileSync(found.file),
      mime: safeMime(found.meta.mime),
      fileName: found.meta.name,
    };
  }

  remove(id: string): boolean {
    const found = this.find(id);
    if (!found) return false;
    try {
      fs.unlinkSync(found.file);
    } catch {
      /* 元数据仍要删：文件已不在时不能留下悬空卡片 */
    }
    this.db.run("DELETE FROM attachments WHERE home_id = ? AND attachment_id = ?", this.homeId, id);
    return true;
  }
}
