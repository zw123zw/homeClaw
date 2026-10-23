/* HomeClaw 界面预览：原生 JS 复刻 Vue 版结构与交互，复用同一份 styles.css。
   在无法启动 Vite/Electron 的环境里，也能看到真实界面 + 真实 SSE 流式。 */
const API = "http://127.0.0.1:4010";
const $ = (id) => document.getElementById(id);

let sessionId = null;
let es = null;
let lastSeq = 0;
let activeReplyId = null;
let activeUserMsgId = null;
/* assistant 分片缓冲：按 rAF 批量刷 DOM，复刻 §3.1 的渲染策略 */
let pending = null;
let raf = 0;

/* 把 data-icon 占位替换成内联 SVG（避免模板里堆长串路径） */
function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    const name = el.dataset.icon;
    const size = Number(el.dataset.iconSize || 16);
    el.outerHTML = icon(name, size);
  });
}

function toast(text, isErr = false) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast" + (isErr ? " err" : "");
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 2800);
}

async function api(path, init) {
  /* 只有真的带 body 时才声明 content-type：
     Fastify 对"声明了 JSON 但 body 为空"会直接 400 */
  const headers = { ...(init && init.headers) };
  if (init && init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(API + path, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || "HTTP " + res.status);
  }
  return res.json();
}

const fmtTime = (ts) =>
  new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

/* 健康状态：文字 + 颜色双重编码，不只靠颜色 */
async function pollHealth() {
  const dot = $("healthDot");
  const text = $("healthText");
  try {
    const h = await api("/v1/health");
    const ok = h.ok && h.adapter.status === "ok";
    dot.className = "dot " + (ok ? "ok" : "warn");
    text.textContent = "适配器 " + h.adapter.status + " · 模型 " + h.llm.status;
  } catch {
    dot.className = "dot err";
    text.textContent = "服务不可用";
  }
}

/* ---------- 会话 ---------- */
async function loadSessions() {
  let list = await api("/v1/sessions");
  const box = $("sessionList");

  if (!list.length) {
    const s = await api("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "新会话" }) });
    list = [s];
    sessionId = s.id;
    connectStream();
  }

  box.innerHTML = "";
  for (const s of list) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "session-item";
    el.dataset.sid = s.id;
    el.setAttribute("aria-current", String(s.id === sessionId));
    el.innerHTML = '<span class="session-item__title"></span><span class="dim mono"></span>';
    el.querySelector(".session-item__title").textContent = s.title;
    el.querySelector(".mono").textContent = s.message_count;
    el.onclick = () => selectSession(s.id);
    box.appendChild(el);
  }

  if (!sessionId && list.length) {
    sessionId = list[0].id;
    connectStream();
    highlightSession();
  }
}

function highlightSession() {
  document.querySelectorAll(".session-item").forEach((el) => {
    el.setAttribute("aria-current", String(el.dataset.sid === sessionId));
  });
}

async function selectSession(id) {
  sessionId = id;
  lastSeq = 0;
  activeReplyId = null;
  activeUserMsgId = null;
  $("messages").innerHTML = "";
  $("stopBtn").hidden = true;
  connectStream();
  highlightSession();
}

/* ---------- SSE ---------- */
function connectStream() {
  if (es) es.close();
  $("connInfo").innerHTML = icon("refresh", 14) + "<span>正在连接…</span>";
  es = new EventSource(API + "/v1/stream?session_id=" + encodeURIComponent(sessionId) + "&last_seq=" + lastSeq);
  es.onopen = () => {
    $("connInfo").innerHTML = icon("wifi", 14) + "<span>实时连接正常 · 游标 " + lastSeq + "</span>";
  };
  es.onerror = () => {
    $("connInfo").innerHTML = icon("alert", 14) + "<span>连接中断，正在自动重连…</span>";
  };
  es.addEventListener("envelope", (e) => handleEnvelope(JSON.parse(e.data)));
}

function handleEnvelope(env) {
  if (typeof env.log_seq === "number") lastSeq = Math.max(lastSeq, env.log_seq);
  if (env.type === "session.ready") return;

  if (env.type === "user.message") {
    if (document.getElementById("m-" + env.id)) return;
    appendUser(env.id, env.payload.text, env.ts);
    return;
  }

  if (env.type === "tool.start") {
    appendToolCard(env.id, env.payload);
    return;
  }

  if (env.type === "tool.result") {
    const card = document.getElementById("tool-" + env.id);
    if (!card) return;
    const badge = card.querySelector(".badge");
    badge.className = "badge " + (env.payload.ok ? "ok" : "fail");
    badge.textContent = env.payload.ok ? "成功" : "失败";
    const ms = card.querySelector(".mono");
    if (ms) ms.textContent = env.payload.elapsed_ms + "ms";
    return;
  }

  if (env.type === "assistant.delta") {
    if (!pending) pending = { id: "a_" + env.reply_to, text: "", done: false };
    pending.text += env.payload.text;
    if (env.payload.done) pending.done = true;
    if (!raf) raf = requestAnimationFrame(flushDelta);
    return;
  }

  if (env.type === "error") {
    /* 先取到气泡再清空游标，否则永远找不到要收尾的那条 */
    if (activeReplyId) {
      const el = document.getElementById("m-" + activeReplyId);
      if (el) {
        el.querySelector(".caret")?.remove();
        const err = document.createElement("div");
        err.className = "msg-error";
        err.innerHTML = icon("alert", 14);
        err.appendChild(document.createTextNode(env.payload.message));
        el.appendChild(err);
      }
      activeReplyId = null;
    }
    $("stopBtn").hidden = true;
    toast(env.payload.message, true);
  }
}

function flushDelta() {
  raf = 0;
  if (!pending) return;
  const { id, text, done } = pending;
  pending = null;

  let el = document.getElementById("m-" + id);
  if (!el) {
    el = document.createElement("div");
    el.className = "msg assistant";
    el.id = "m-" + id;
    el.innerHTML =
      '<div class="bubble"><span class="txt"></span><span class="caret"></span></div>' +
      '<div class="msg-meta">' + fmtTime(Date.now() / 1000) + "</div>";
    $("messages").appendChild(el);
    activeReplyId = id;
  }
  el.querySelector(".txt").textContent += text;

  if (done) {
    el.querySelector(".caret")?.remove();
    activeReplyId = null;
  }
  $("stopBtn").hidden = !activeReplyId;
  scrollBottom();
}

/* ---------- 消息渲染 ---------- */
function appendUser(id, text, ts) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.id = "m-" + id;
  el.innerHTML = '<div class="bubble"></div><div class="msg-meta">' + fmtTime(ts || Date.now() / 1000) + "</div>";
  el.querySelector(".bubble").textContent = text;
  $("messages").appendChild(el);
  scrollBottom();
}

function appendToolCard(id, p) {
  const el = document.createElement("div");
  el.className = "card tool-card";
  el.id = "tool-" + id;
  el.innerHTML =
    '<div class="tool-card__head">' +
      '<span class="badge run">执行中</span>' +
      '<span class="tool-card__name"></span>' +
      '<span class="dim mono"></span>' +
      '<button class="ghost icon" type="button" style="margin-left:auto" aria-expanded="false" aria-label="展开参数">' + icon("chevron", 14) + "</button>" +
    "</div>" +
    '<div class="dim" style="margin-top:6px"></div>' +
    '<div class="tool-card__body" hidden>' +
      '<div class="dim" style="font-size:11px;margin-bottom:4px">参数</div>' +
      '<pre class="tool-card__args mono"></pre>' +
    "</div>";

  el.querySelector(".tool-card__name").textContent = p.tool;
  if (p.summary) el.querySelectorAll(".dim")[0].textContent = p.summary;
  el.querySelector("pre").textContent = JSON.stringify(p.args || {}, null, 2);

  const btn = el.querySelector("button");
  const body = el.querySelector(".tool-card__body");
  btn.onclick = () => {
    const open = body.hidden;
    body.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "收起参数" : "展开参数");
  };

  $("messages").appendChild(el);
  scrollBottom();
}

function scrollBottom() {
  const box = $("messages");
  if (!box) return;
  /* 尊重 reduced-motion：动效关闭时直接定位，不做平滑滚动 */
  const reduce =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  /* scrollTo 在部分环境（含 jsdom）不存在，回退到直接赋值 */
  if (typeof box.scrollTo === "function") {
    box.scrollTo({ top: box.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  } else {
    box.scrollTop = box.scrollHeight;
  }
}

/* ---------- 发送 / 停止 ---------- */
async function send() {
  const input = $("input");
  const text = input.value.trim();
  if (!text || !sessionId) return;
  const id = "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  input.value = "";
  activeUserMsgId = id;
  appendUser(id, text);
  $("stopBtn").hidden = false;

  await api("/v1/chat/message", {
    method: "POST",
    body: JSON.stringify({
      v: 1, type: "user.message", id, session_id: sessionId,
      ts: Math.floor(Date.now() / 1000),
      payload: { text, attachments: [] },
    }),
  });
}

async function stop() {
  if (!sessionId || !activeUserMsgId) return;
  await api("/v1/chat/cancel", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, target: activeUserMsgId }),
  });
  activeReplyId = null;
  $("stopBtn").hidden = true;
  document.querySelectorAll(".caret").forEach((c) => c.remove());
  toast("已停止生成");
}

/* ---------- 设备面板 ---------- */
const DEVICE_ICON = {
  light: "light", cover: "cover", sensor: "sensor",
  binary_sensor: "sensor", switch: "plug", fan: "sensor",
};

function stateText(e) {
  if (!e.available) return "离线 · 无法控制";
  if (e.type === "light") {
    return e.state.on
      ? "开 · " + (e.state.brightness ?? "-") + "% · " + (e.state.color_temp ?? "-") + "K"
      : "关";
  }
  if (e.type === "cover") return "开合 " + (e.state.position ?? "-") + "%";
  if (e.type === "sensor") return (e.state.temperature ?? "-") + "°C · " + (e.state.humidity ?? "-") + "%";
  return e.state.on ? "开" : "关";
}

async function loadDevices() {
  const list = await api("/v1/entities");
  const rooms = new Map();
  for (const e of list) rooms.set(e.room, [...(rooms.get(e.room) || []), e]);

  const box = $("devicesPage");
  box.innerHTML = "";

  for (const [room, items] of [...rooms.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const g = document.createElement("section");
    g.className = "room-group";
    g.innerHTML =
      '<h2 class="room-title">' + room + " · " + items.length + " 个设备</h2>" +
      '<div class="device-grid"></div>';
    const grid = g.querySelector(".device-grid");

    for (const e of items) {
      const d = document.createElement("article");
      d.className = "device" + (e.available ? "" : " offline");
      d.setAttribute("aria-label", e.name + "，" + stateText(e));

      d.innerHTML =
        '<div class="device__head">' +
          '<div><div class="device__name">' + icon(DEVICE_ICON[e.type] || "devices", 16) +
            '<span class="device__label"></span></div>' +
            '<div class="device__state"></div></div>' +
          '<span class="dot ' + (e.available ? "ok" : "err") + '" role="img" aria-label="' +
            (e.available ? "在线" : "离线") + '"></span>' +
        "</div>";
      d.querySelector(".device__label").textContent = e.name;
      d.querySelector(".device__state").textContent = stateText(e);

      const row = document.createElement("div");
      row.className = "row";

      if (e.type === "light" || e.type === "switch") {
        const on = e.state.on === true;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = on ? "关闭" : "打开";
        btn.disabled = !e.available;
        btn.onclick = () => command(e.id, on ? "turn_off" : "turn_on");
        row.appendChild(btn);

        if (e.capabilities.includes("brightness")) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ghost";
          b.textContent = "30%";
          b.disabled = !e.available;
          b.onclick = () => command(e.id, "set_brightness", { brightness_pct: 30 });
          row.appendChild(b);
        }
      }

      if (e.type === "cover") {
        for (const [label, svc] of [["打开", "open_cover"], ["关闭", "close_cover"]]) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = label;
          b.disabled = !e.available;
          b.onclick = () => command(e.id, svc);
          row.appendChild(b);
        }
      }

      if (row.children.length) d.appendChild(row);

      if (e.type === "light" && e.capabilities.includes("brightness")) {
        const wrap = document.createElement("div");
        const id = "br-" + e.id.replace(/\W/g, "_");
        wrap.innerHTML = '<label class="sr-only" for="' + id + '">' + e.name + " 亮度</label>";
        const slider = document.createElement("input");
        slider.className = "slider";
        slider.id = id;
        slider.type = "range";
        slider.min = 1;
        slider.max = 100;
        slider.value = e.state.brightness ?? 50;
        slider.disabled = !e.available;
        slider.onchange = (ev) => command(e.id, "set_brightness", { brightness_pct: Number(ev.target.value) });
        wrap.appendChild(slider);
        d.appendChild(wrap);
      }

      grid.appendChild(d);
    }
    box.appendChild(g);
  }

  const offline = list.filter((e) => !e.available).length;
  const foot = document.createElement("p");
  foot.className = "dim";
  foot.style.fontSize = "12px";
  foot.textContent = "共 " + list.length + " 个实体 · 离线 " + offline + " 个";
  box.appendChild(foot);
}

async function command(entityId, service, data = {}) {
  try {
    await api("/v1/entities/" + encodeURIComponent(entityId) + "/command", {
      method: "POST",
      body: JSON.stringify({ service, data }),
    });
    await loadDevices();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 场景 ---------- */
async function loadScenes() {
  const list = await api("/v1/scenes");
  const box = $("scenesPage");
  box.innerHTML = '<div class="scene-grid"></div>';
  const grid = box.querySelector(".scene-grid");

  for (const s of list) {
    const el = document.createElement("article");
    el.className = "scene";
    el.innerHTML =
      '<div class="scene__name">' + icon("scenes", 16) + '<span></span></div>' +
      '<div class="scene__meta">' + s.actions.length + " 个动作</div>";
    el.querySelector(".scene__name span").textContent = s.name;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "primary";
    btn.textContent = "一键执行";
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "执行中…";
      try {
        const res = await api("/v1/scenes/" + encodeURIComponent(s.id) + "/run", { method: "POST" });
        const failed = res.results.filter((r) => !r.ok);
        toast(
          failed.length ? "部分动作未执行：" + failed.length + " 个" : "场景执行成功",
          failed.length > 0
        );
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "一键执行";
      }
    };
    el.appendChild(btn);
    grid.appendChild(el);
  }
}

/* ---------- 标签切换 ---------- */
const PAGES = { chat: "chatPage", devices: "devicesPage", scenes: "scenesPage" };
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = async () => {
    const target = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => {
      t.setAttribute("aria-selected", String(t === tab));
    });
    for (const [k, id] of Object.entries(PAGES)) {
      $(id).hidden = k !== target;
    }
    if (target === "devices") await loadDevices();
    if (target === "scenes") await loadScenes();
  };
});

/* ---------- 输入 ---------- */
$("sendBtn").onclick = () => send().catch((e) => toast(e.message, true));
$("stopBtn").onclick = () => stop().catch((e) => toast(e.message, true));
$("input").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send().catch((err) => toast(err.message, true));
  }
};
$("newSession").onclick = async () => {
  const s = await api("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "新会话" }) });
  await selectSession(s.id);
  await loadSessions();
};

/* ---------- 启动 ---------- */
(async () => {
  hydrateIcons();
  await pollHealth();
  setInterval(pollHealth, 15000);
  await loadSessions();
})();
