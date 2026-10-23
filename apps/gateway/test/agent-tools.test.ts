import { describe, it, expect } from "./harness.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decide } from "../src/route.ts";
import { createToolRegistry } from "../src/tools/index.ts";
import { readDoc } from "../src/tools/doc-read.ts";
import { htmlToText } from "../src/tools/web.ts";
import { listSkills, renderSkillHint } from "../src/hermes/skills.ts";
import { renderManaged, writeConfig, ensureWorkspace } from "../src/hermes/config.ts";

/**
 * 路由与工具的单测。
 *
 * 这里刻意不测"模型说了什么"——那需要真模型，且答案不稳定。
 * 只测本层自己的逻辑：什么时候选哪条路、沙箱边界、文件怎么读、配置怎么写。
 * 这些错误一旦漏到线上，表现都是"数据被改坏"或"该走的没走"，比答案措辞严重得多。
 */

const base = { text: "", attachmentCount: 0, hermesReady: true, hermesEnabled: true };

describe("路由判定", () => {
  it("L0 命中必须走本地（断网可用）", () => {
    expect(decide({ ...base, text: "打开客厅灯", l0Hit: true }).kind).toBe("l0");
  });

  it("简单单句不走规划", () => {
    expect(decide({ ...base, text: "客厅空调调到 26 度" }).kind).toBe("local");
  });

  it("规划词命中走 Hermes", () => {
    expect(decide({ ...base, text: "帮我整理一下这批文件" }).kind).toBe("hermes");
  });

  it("带附件走 Hermes", () => {
    expect(decide({ ...base, text: "看看这个", attachmentCount: 1 }).kind).toBe("hermes");
  });

  it("用户显式要求深度思考则强制 Hermes", () => {
    expect(decide({ ...base, text: "你好", preferPlanning: true }).kind).toBe("hermes");
  });

  it("运行时未就绪时绝不选 Hermes", () => {
    expect(decide({ ...base, text: "帮我整理资料", hermesReady: false }).kind).toBe("local");
  });

  it("设置里关闭后同样不选 Hermes", () => {
    expect(decide({ ...base, text: "帮我整理资料", hermesEnabled: false }).kind).toBe("local");
  });

  it("长句多动作走 Hermes", () => {
    const text = "先打开书房灯，然后把窗帘关上，接着把空调设成 26 度，最后把客厅灯调到 40%";
    expect(decide({ ...base, text }).kind).toBe("hermes");
  });
});

describe("工具沙箱", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-tools-"));

  it("越界路径被拒绝（../ 逃逸）", async () => {
    const reg = createToolRegistry({ workspaceRoot: root });
    const res = await reg.call("file_write", { path: "../escape.txt", content: "x" });
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("越界");
  });

  it("绝对路径写到根外被拒绝", async () => {
    const reg = createToolRegistry({ workspaceRoot: root });
    const res = await reg.call("file_read", { path: path.join(os.tmpdir(), "nope.txt") });
    expect(res.ok).toBe(false);
  });

  it("写文件默认不覆盖，显式 overwrite 才覆盖", async () => {
    const reg = createToolRegistry({ workspaceRoot: root });
    const first = await reg.call("file_write", { path: "a.txt", content: "v1" });
    expect(first.ok).toBe(true);
    const second = await reg.call("file_write", { path: "a.txt", content: "v2" });
    expect(second.ok).toBe(false);
    expect(second.summary).toContain("overwrite");
    const third = await reg.call("file_write", { path: "a.txt", content: "v2", overwrite: true });
    expect(third.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("v2");
  });

  it("批量改名默认只预演，确认后才真改", async () => {
    const dir = fs.mkdtempSync(path.join(root, "rename-"));
    fs.writeFileSync(path.join(dir, "2026-01-02.txt"), "x");
    const reg = createToolRegistry({ workspaceRoot: root });
    const dry = await reg.call("file_rename", { dir: path.basename(dir), pattern: "(\\d{4})-(\\d{2})-(\\d{2})", replacement: "$2-$3-$1" });
    expect(dry.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "2026-01-02.txt"))).toBe(true);

    const wet = await reg.call("file_rename", {
      dir: path.basename(dir),
      pattern: "(\\d{4})-(\\d{2})-(\\d{2})",
      replacement: "$2-$3-$1",
      dry_run: false,
    });
    expect(wet.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "01-02-2026.txt"))).toBe(true);
  });

  it("非法正则给出可读错误，而不是静默不匹配", async () => {
    const reg = createToolRegistry({ workspaceRoot: root });
    const res = await reg.call("file_rename", { pattern: "([", replacement: "x" });
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("正则");
  });

  it("未知工具返回失败（而不是抛异常）", async () => {
    const reg = createToolRegistry({ workspaceRoot: root });
    const res = await reg.call("nope", {});
    expect(res.ok).toBe(false);
  });

  it("二进制文件不能用 file_read 读", async () => {
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    const reg = createToolRegistry({ workspaceRoot: root });
    const res = await reg.call("file_read", { path: "bin.dat" });
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("二进制");
  });
});

describe("文档解析", () => {
  it("纯文本直接返回", () => {
    const r = readDoc(Buffer.from("你好\n世界", "utf8"), "a.txt", "text/plain");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("你好");
  });

  it("不支持的二进制类型明确报错，不返回空文本", () => {
    const r = readDoc(Buffer.from([0, 1, 2]), "a.bin", "application/octet-stream");
    expect(r.ok).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("伪装的 docx（非 zip）报错而不是返回空", () => {
    const r = readDoc(Buffer.from("not a zip"), "fake.docx");
    expect(r.ok).toBe(false);
  });
});

describe("网页转文本", () => {
  it("剥掉脚本与标签，保留正文与列表", () => {
    const text = htmlToText("<html><head><title>T</title><script>bad()</script></head><body><h1>标题</h1><p>正文</p><ul><li>一</li></ul></body></html>");
    expect(text).toContain("标题");
    expect(text).toContain("- 一");
    expect(text).not.toContain("bad()");
  });

  it("解码常见实体", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt; &#65;</p>")).toContain("a & b <c> A");
  });
});

describe("Skill 与配置", () => {
  it("只识别含清单文件的目录", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hc-skill-"));
    fs.mkdirSync(path.join(home, "skills", "weekly"), { recursive: true });
    fs.writeFileSync(path.join(home, "skills", "weekly", "SKILL.md"), "---\ndescription: 写周报\n---\n正文");
    fs.mkdirSync(path.join(home, "skills", "stray"), { recursive: true });
    fs.writeFileSync(path.join(home, "skills", "stray", "note.txt"), "随手记");

    const list = listSkills(home);
    expect(list.map((s) => s.name)).toEqual(["weekly"]);
    expect(list[0]?.description).toBe("写周报");
    expect(renderSkillHint(list)).toContain("weekly：写周报");
  });

  it("受管段可重复写入而不重复堆叠", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hc-cfg-"));
    const input = { homeDir: home, workspaceRoot: "/tmp/ws", allowShell: false, servers: [] };
    writeConfig(input);
    writeConfig(input);
    const text = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
    expect(text.split("# >>> homeclaw managed begin >>>").length - 1).toBe(1);
    expect(text).toContain("allow_shell: false");
  });

  it("用户自写段落被保留", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hc-cfg2-"));
    fs.writeFileSync(path.join(home, "config.yaml"), "# 我的注释\ncustom_key: 1\n");
    writeConfig({ homeDir: home, workspaceRoot: "/tmp/ws", allowShell: false, servers: [] });
    const text = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
    expect(text).toContain("custom_key: 1");
    expect(text).toContain("# >>> homeclaw managed begin >>>");
  });

  it("MCP 服务器写进 config.yaml，禁用的不写", () => {
    const block = renderManaged({
      homeDir: "/tmp",
      workspaceRoot: "/tmp/ws",
      allowShell: false,
      servers: [
        { name: "homehub", url: "http://127.0.0.1:4020/mcp", enabled: true, token: "t" },
        { name: "off", url: "http://x/mcp", enabled: false },
      ],
    });
    expect(block).toContain("name: homehub");
    expect(block).not.toContain("name: off");
  });

  it("工作目录越出仓库直接拒绝", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hc-repo-"));
    expect(() => ensureWorkspace(repo, "../outside")).toThrow();
    expect(ensureWorkspace(repo, "data/workspace")).toContain("workspace");
  });
});