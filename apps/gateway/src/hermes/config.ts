import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "./settings.ts";

/**
 * 生成 HERMES_HOME/config.yaml。
 *
 * 为什么"生成"而不是"让用户手写"：Hermes 的配置文件格式会升级，
 * 而我们的设置页有确定字段（模型、MCP 服务器、沙箱目录）。
 * 每次启动前重写一遍，用户就不用懂 YAML；上游格式变了也只改这一个文件。
 *
 * 边界：只写我们负责的段（model / mcp / tools），其余段原样保留。
 * 直接整文件覆盖会把用户自己在 config.yaml 里加的东西抹掉。
 */

export type HermesModel = {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** chat_completions | responses | anthropic */
  wireApi?: string;
  reasoningEffort?: string;
  contextWindow?: number;
};

export type ConfigInput = {
  homeDir: string;
  workspaceRoot: string;
  allowShell: boolean;
  model?: HermesModel;
  servers: McpServerConfig[];
};

const BEGIN = "# >>> homeclaw managed begin >>>";
const END = "# <<< homeclaw managed end <<<";

/** YAML 标量：只做最小必要转义，避免引入 yaml 依赖改变字节级输出 */
function scalar(v: string): string {
  if (v === "") return '""';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(v)) return v;
  return JSON.stringify(v);
}

export function renderManaged(input: ConfigInput): string {
  const lines: string[] = [BEGIN];

  lines.push("model:");
  if (input.model) {
    lines.push(`  provider: ${scalar(input.model.provider)}`);
    lines.push(`  base_url: ${scalar(input.model.baseUrl)}`);
    lines.push(`  api_key: ${scalar(input.model.apiKey)}`);
    lines.push(`  name: ${scalar(input.model.model)}`);
    if (input.model.wireApi) lines.push(`  wire_api: ${scalar(input.model.wireApi)}`);
    if (input.model.reasoningEffort) lines.push(`  reasoning_effort: ${scalar(input.model.reasoningEffort)}`);
    if (input.model.contextWindow) lines.push(`  context_window: ${input.model.contextWindow}`);
  } else {
    lines.push("  provider: none");
  }

  lines.push("tools:");
  lines.push(`  workspace: ${scalar(input.workspaceRoot)}`);
  lines.push(`  allow_shell: ${input.allowShell ? "true" : "false"}`);
  lines.push("  allow_network: true");

  lines.push("mcp:");
  lines.push("  servers:");
  const enabled = input.servers.filter((s) => s.enabled);
  if (enabled.length === 0) {
    lines.push("    []");
  } else {
    for (const s of enabled) {
      lines.push(`    - name: ${scalar(s.name)}`);
      lines.push(`      url: ${scalar(s.url)}`);
      lines.push("      transport: http");
      if (s.token) lines.push(`      token: ${scalar(s.token)}`);
    }
  }

  lines.push(END);
  return lines.join("\n") + "\n";
}

/**
 * 写入 config.yaml：替换受管段，保留其余内容。
 * 没有受管段就追加到末尾；文件不存在就新建。
 */
export function writeConfig(input: ConfigInput): { file: string; changed: boolean } {
  fs.mkdirSync(input.homeDir, { recursive: true });
  const file = path.join(input.homeDir, "config.yaml");
  const block = renderManaged(input);

  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = "";
  }

  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  let next: string;

  if (start >= 0 && end > start) {
    const head = existing.slice(0, start);
    const tail = existing.slice(end + END.length).replace(/^\n+/, "");
    next = head + block + (tail ? `\n${tail}` : "");
  } else {
    next = existing.trim() ? `${existing.replace(/\s+$/, "")}\n\n${block}` : block;
  }

  if (next === existing) return { file, changed: false };
  fs.writeFileSync(file, next, "utf8");
  return { file, changed: true };
}

/** 工作目录必须在 HERMES_HOME 外、仓库内，且必须真实存在（子进程 cwd 不存在会直接 spawn 失败） */
export function ensureWorkspace(repoRoot: string, workspaceRoot: string): string {
  const abs = path.resolve(repoRoot, workspaceRoot);
  const inside = path.relative(repoRoot, abs);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new Error(`工作目录必须位于仓库内：${abs}`);
  }
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}
