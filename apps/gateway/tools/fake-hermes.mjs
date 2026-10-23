/**
 * 假 Hermes 启动器：按 ndjson 协议吐事件，用来验证网关侧解析、路由、降级三条路径。
 * 真机上由 hermes-venv 里的 hermes.exe 承担，这里只验证"契约对得上"。
 */
const args = process.argv.slice(2);
const prompt = args.join(" ");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (prompt.includes("崩")) {
    out({ type: "error", code: "UPSTREAM_ERROR", message: "模拟崩溃" });
    process.exit(3);
  }
  out({ type: "delta", text: "先看一下工作目录。" });
  out({ type: "tool.start", id: "t1", tool: "file_list", args: { dir: "." }, summary: "查看目录" });
  await sleep(30);
  out({ type: "tool.result", id: "t1", ok: true, elapsed_ms: 30 });
  out({ type: "delta", text: "目录里没有文件，我先写个说明。" });
  out({ type: "tool.start", id: "t2", tool: "file_write", args: { path: "纪要.md" }, summary: "写入 纪要.md" });
  await sleep(20);
  out({ type: "tool.result", id: "t2", ok: true, elapsed_ms: 20 });
  out({ type: "delta", text: "已完成。" });
  out({ type: "done" });
  process.exit(0);
})();