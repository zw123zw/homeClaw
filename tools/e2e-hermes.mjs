import { ClientEnvelope } from "@homeclaw/contracts";
import { buildGateway } from "../apps/gateway/src/server.ts";
import { ModelRegistry } from "../apps/gateway/src/models.ts";
import { HermesSettingsStore } from "../apps/gateway/src/hermes/settings.ts";
import { HermesService } from "../apps/gateway/src/hermes/index.ts";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * 端到端：真起一个网关（假 Hermes 当启动器），跑三种输入，看 SSE 收到什么。
 * 这条脚本覆盖的是最容易被"看起来能跑"骗过的部分：路由、降级、工具卡、落库。
 */
const repoRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hc-e2e-"));
const modelsFile = path.join(tmp, "models.json");
fs.writeFileSync(
  modelsFile,
  JSON.stringify({
    active_id: null,
    models: [
      { id: "m_x", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-fake", wireApi: "chat_completions" },
    ],
  }),
);

const hermesSettings = new HermesSettingsStore({ file: path.join(tmp, "hermes.json") });
const fake = path.join(repoRoot, "tools", "fake-hermes.mjs");
hermesSettings.update({ launcher: fake, timeoutMs: 20_000, workspaceRoot: "data/workspace" });

const hermes = new HermesService({ repoRoot, settings: hermesSettings });
const app = await buildGateway({
  config: {
    host: "127.0.0.1",
    port: 4199,
    hub: { baseUrl: "http://127.0.0.1:4020", mcpToken: "dev-mcp-token", userToken: "dev-user-token" },
    llm: { provider: "mock", baseUrl: "", apiKey: "", model: "" },
    modelsFile,
    repoRoot,
    workspaceRoot: "data/workspace",
    runTimeoutMs: 30_000,
  },
  models: new ModelRegistry({ file: modelsFile }),
  hermes,
  startToolMcp: false,
});
await app.listen({ port: 4199, host: "127.0.0.1" });

const sse = async (sessionId) => {
  const res = await fetch(`http://127.0.0.1:4199/v1/stream?session_id=${sessionId}&last_seq=0`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events = [];
  return { events, stop: () => reader.cancel(), pump: (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          try { events.push(JSON.parse(line.slice(6))); } catch {}
        }
      }
    }
  })() };
};

const run = async (label, payload) => {
  const sessionId = "s_e2e_" + label + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const ch = await sse(sessionId);
  const env = { v: 1, type: "user.message", id: "c_" + label + "_" + Date.now().toString(36), session_id: sessionId, ts: Math.floor(Date.now() / 1000), payload };
  const parsed = ClientEnvelope.safeParse(env);
  if (!parsed.success) throw new Error("envelope invalid: " + JSON.stringify(parsed.error.issues));
  const res = await fetch("http://127.0.0.1:4199/v1/chat/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(env),
  });
  if (res.status !== 202) throw new Error(`${label}: HTTP ${res.status} ${await res.text()}`);
  await new Promise((r) => setTimeout(r, 2500));
  ch.stop();
  const types = ch.events.map((e) => e.type + (e.type === "tool.start" ? `:${e.payload.tool}` : ""));
  const text = ch.events.filter((e) => e.type === "assistant.delta").map((e) => e.payload.text).join("");
  console.log(`\n[${label}] ${res.status}`);
  console.log("  事件：" + types.join(" → "));
  console.log("  文本：" + text.replace(/\n/g, " ⏎ ").slice(0, 220));
  return ch.events;
};

try {
  console.log("hermes probe:", JSON.stringify(hermes.probe()));
  await run("l0", { text: "打开客厅灯", attachments: [] });
  await run("plan", { text: "帮我整理这批资料，然后汇总成一份纪要", attachments: [] });
  await run("force", { text: "你好", attachments: [], prefer_planning: true });
  await run("broken", { text: "帮我崩一下", attachments: [] });
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}