/** jsdom 不提供 EventSource，这里用 node:http 实现最小可用版本，真实走 SSE */
import http from "node:http";

export class NodeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    this.onopen = null;
    this.onerror = null;
    this._connect();
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  _emit(type, event) {
    const handler = type === "open" ? this.onopen : type === "error" ? this.onerror : null;
    if (handler) handler(event);
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  _connect() {
    if (this.closed) return;
    const req = http.get(this.url, (res) => {
      this._emit("open", {});
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (block.startsWith(":")) continue;
          let name = "message";
          const dataLines = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) name = line.slice(7);
            else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
          }
          if (dataLines.length) {
            this._emit(name, { data: dataLines.join("\n") });
            this._emit("message", { data: dataLines.join("\n") });
          }
        }
      });
      res.on("end", () => this._emit("error", {}));
    });
    req.on("error", () => this._emit("error", {}));
    this._req = req;
  }

  close() {
    this.closed = true;
    this._req?.destroy();
  }
}
