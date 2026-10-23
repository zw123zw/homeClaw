import fs from "node:fs";
import path from "node:path";

/**
 * Skill 列表。
 *
 * 一期不重造 skill 引擎：Hermes 自己有"从经验生成并改进 skill"的机制，
 * 我们只负责把 HERMES_HOME/skills 下的目录读出来，两个用途：
 *  1. 设置页展示（用户要知道自己有哪些能力）；
 *  2. 拼进系统提示，让模型自己决定用哪个。
 *
 * 识别规则保守：目录里有 SKILL.md / skill.md / README.md 才算 skill。
 * 只认目录不认散落文件，避免把随手放的笔记当成能力。
 */
export type SkillInfo = {
  name: string;
  description: string;
  dir: string;
  /** SKILL.md 的字节数，用来区分空壳 */
  size: number;
};

const MANIFESTS = ["SKILL.md", "skill.md", "README.md", "readme.md"];

export function listSkills(homeDir: string): SkillInfo[] {
  const root = path.join(homeDir, "skills");
  let names: string[];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }

  const out: SkillInfo[] = [];
  for (const name of names.sort()) {
    const dir = path.join(root, name);
    for (const m of MANIFESTS) {
      const f = path.join(dir, m);
      try {
        const text = fs.readFileSync(f, "utf8");
        out.push({ name, description: readDescription(text, name), dir, size: Buffer.byteLength(text) });
        break;
      } catch {
        /* 换下一个候选清单文件 */
      }
    }
  }
  return out;
}

/**
 * 描述取法：优先 frontmatter 的 description，其次第一个非标题段落。
 * 不引 markdown 解析器 —— 这里只需要"一句话"，解析整棵树是浪费。
 */
function readDescription(text: string, fallback: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    const m = /^description:\s*(.+)$/m.exec(fm[1] ?? "");
    if (m?.[1]) return m[1].trim().replace(/^["']|["']$/g, "").slice(0, 200);
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (const l of lines) {
    if (!l || l.startsWith("#") || l.startsWith("---") || l.startsWith("|")) continue;
    return l.slice(0, 200);
  }
  return fallback;
}

/** 拼进系统提示用的紧凑清单：名字 + 一句话，不带路径（路径对模型没用） */
export function renderSkillHint(skills: SkillInfo[]): string {
  if (skills.length === 0) return "";
  return `可用技能：\n${skills.map((s) => `- ${s.name}：${s.description}`).join("\n")}`;
}
