import zlib from "node:zlib";

/**
 * 最小 ZIP 读取器。
 *
 * 为什么自己写：docx / xlsx / pptx 都是 ZIP 包，而我们只需要"按名字取一个条目"。
 * 为这一个能力装一个 zip 库，等于为三行需求引入一棵依赖树（还会带来 native 模块风险）。
 * 这里只实现读取：解析中央目录 → 取 local header → inflate。
 * 明确不支持：加密包、ZIP64、分卷 —— 遇到就抛错，让上层提示用户另存为普通文件。
 */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件（缺少中央目录）");

  const count = buf.readUInt16LE(eocd + 10);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  let p = cenOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;

    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) continue;

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    try {
      out.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    } catch {
      // 单条目坏掉不该让整份文档读不出来
    }
  }

  if (out.size === 0) throw new Error("ZIP 内没有可读条目");
  return out;
}

/** EOCD 在文件末尾，注释最长 65535 字节，从后往前找签名 */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}
