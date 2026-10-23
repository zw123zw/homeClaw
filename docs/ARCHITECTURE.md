# 全屋智能 AI 系统｜架构技术方案（合并定稿）

| 项 | 内容 |
|---|---|
| 版本 | v1.1 |
| 日期 | 2026-10-23 |
| 状态 | 定稿（L1–L3 开工；L4/L5 未排期） |
| 实现现状 | 本文档描述**目标架构**；§0.2 列出与当前代码的差异 |
| 取代 | 《AI-LLM全屋智能管家｜正式产品级架构技术方案（标准分层版）》<br>《最终定稿｜Electron+Hermes+HomeHub+HA 全屋智能AI系统 完整开发计划》 |
| 架构原则 | 五层架构保持不变，本文只明确每层内部实现与接口契约 |

---

## 0. 本文与旧文档的关系

两份旧文档内容重合约 90%，且存在互相矛盾的约束（见 10.1）。本文做三件事：

1. **合并为唯一源文件**，旧文档归档，不再维护；
2. **架构层级一字不改**，冲突全部在"层内实现约束"里消解；
3. **补齐可直接开工的部分**：接口契约、数据模型、协议信封、里程碑验收标准。

### 0.1 主要变更摘要

| 旧文档写法 | 本文写法 | 原因 |
|---|---|---|
| Electron 是"唯一用户入口"，同时支持网页/小程序内嵌 | 一期只有桌面客户端；网页/消息通道只留接口，不实现 | "唯一入口"与"内嵌网页"矛盾，且多入口会改变鉴权模型 |
| Hermes 有"无设备权限"，又可"原生操作文件/shell" | 保留电脑操控能力，但**默认关闭 + 跑在沙箱容器 + 出网白名单** | Agent 能跑 shell 就能绕过一切分层，权限隔离必须落在进程与凭据上 |
| 传感器事件 → LLM 实时决策（唯一路径） | 保留该链路，但强制加**去抖合并/频率上限/预算上限/防环**四件套 | 人体传感器一小时可触发数十次，无约束会造成费用与延迟失控 |
| 注册所有设备 Schema 给 LLM | 常驻 35 个**语义工具** + 长尾**检索式下发** + 高频指令**确定性直通** | 200+ 实体全量注入约 15k–30k tokens/轮，且降低选对率 |
| HomeHub 一期做全套（含 RAG、ASR/TTS） | 一期只做**策略代理 + 工具层 + 审计 + 事件总线**，RAG/语音后置 | 语音已定后置；RAG 需真实使用数据才能设计 |
| Electron↔Hermes 用"ACP 协议" | 自定义消息信封（SSE 优先，WS 兜底），**不假定 ACP** | ACP 是编辑器与 Agent 的 stdio 协议，与 Electron 远程客户端不是一回事 |
| 高危操作靠"操作分级" | 一期靠系统提示词 + 一份硬拒绝清单（保险丝） | 已确认不做分级体系，但概率性约束不能替代确定性拒绝 |
| 7 阶段 24 天产品级上线 | 8 个里程碑，每期有明确验收，不设总工期承诺 | 原排期严重低估设备入网与联调成本 |

---

## 0.2 实现现状（与本文档的差异）

本文档是**目标架构**。当前代码已落地 L1–L3，L4/L5 未开始。以下为逐文件核对后的实际状态。

| 层 | 文档目标 | 当前实现 |
|---|---|---|
| L1 | Vue3 + Vite + TS；shadcn-vue + Tailwind；markdown-it + Shiki | `apps/web` + `apps/desktop`；Vue3 + Vite + TS + Pinia + TanStack Query；样式为自研 CSS 变量（四套主题）；Markdown 由自研安全子集渲染器输出（`apps/web/src/chat/markdown.ts`）；附件上传/预览与运行时模型配置已接入 |
| L2 | Hermes 内核（第三方，容器沙箱） | `apps/gateway`：**Hermes（vendor + uv venv）子进程** + 接入层；自研薄循环保留为降级路径；9 个内置工具经本地 MCP（`127.0.0.1:4031`）统一暴露；偏好注入两条路径；无容器、无出网白名单；仅经 MCP 访问 L3 |
| L3 | Fastify + SQLite + Drizzle | `apps/homehub`：Fastify + Node 内置 `node:sqlite`（无 ORM）；`MockAdapter` 可用，`HaAdapter` 未实现 |
| L4 | HomeAssistant | **未实现**（`adapter/factory.ts` 对 `ha` 直接抛错） |
| L5 | 物理设备 | **未实现** |

其他已核对的差异：

- 工具数量：L1 常驻 25 个；L2 内置 9 个（`file_list` / `file_read` / `file_write` / `file_rename` / `file_move` / `doc_read` / `web_fetch` / `file_summarize` / `file_translate`）；
- 工具检索：字符 bigram BM25，无 embedding 服务（文档 §4.2 写「embedding + BM25 混合」）；
- 客户端直连 HomeHub 读面板与会话，按 §5.2 执行；C5 的「只认网关地址」仅指对话链路；
- 记忆：`preferences` 表已建，且已注入两条执行路径（自研循环拼系统提示、Hermes 走 `withInstructions()` 拼「用户偏好 + 可用技能」）；
- 打包：dev 模式由 Electron 主进程直接 `spawn node` 跑源码；正式包形态见 §9.5（尚未接入 electron-builder，本机离线装不了该依赖）。

已修复（本轮）：

- ~~L2 落库分片撞唯一索引~~ → HomeHub 迁移 v4 把唯一索引改为 `(home_id, session_id, message_id)`，工具 id 跨会话重名不再丢历史；
- ~~L3 `/v1/health` 把 `llm`/`gateway` 写死~~ → 改为真探测 Gateway 的 `/v1/health`，失败才降级为 `down`；
- ~~DELETE / POST test 带 `content-type: application/json` 但无 body 时 400~~ → L2/L3 均加空 body 容错解析器（这才是"删除模型报错"的真实原因）。

已知缺陷（仍未修，按优先级）：

- `/v1/internal/*`、`/v1/_debug/*` 无鉴权；L2 与 L3 的 CORS 均为 `origin: true`；
- `log_seq` 只存内存，L2 重启后归零，客户端带旧游标重连会静默漏消息（§5.1 已写明回落策略）。

---

## 0.3 本期范围（L1–L3）

L4/L5 本期不做，接口按 §3.4 / §3.5 预留。

| 层 | 本期交付 | 不交付 |
|---|---|---|
| L1 | 对话/设备/场景三页、SSE 流式渲染、工具卡、主题、设置中心、Markdown 渲染、附件上传与预览、模型切换 | 虚拟滚动、语音 |
| L2 | Hermes 子进程接入、任务规划、内置工具集、Skill 列表、多 MCP 服务器、L0 直通、自研循环降级、SSE 流、模型适配、附件送入模型 | 容器沙箱与出网白名单 |
| L3 | ToolHub、Policy、Audit、EventBus、Sessions、附件存储、MockAdapter | HaAdapter、RAG、语音 |

### 0.3.1 附件契约（本期新增）

附件属用户消息资源，由 L3 存储与提供读取。

```ts
type Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "pdf" | "text" | "audio" | "video" | "file";
  url: string;          // /v1/attachments/<id>
  previewUrl?: string;  // 仅客户端乐观消息使用，服务端不返回
};
```

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/attachments` | 上传（base64 JSON），单文件 ≤20MB，需用户票据 |
| GET | `/v1/attachments/:id` | 读取字节，按元数据设置 Content-Type |
| DELETE | `/v1/attachments/:id` | 删除文件与元数据 |

约束：单消息 ≤5 个附件；文件名只作元数据，落盘用服务端生成的 ID + 安全扩展名；HTML/SVG 等以纯文本返回。

`UserMessage.payload.attachments`、`AssistantDelta.payload.attachments`、`Message.attachments` 均为 `Attachment[]`。

### 0.3.2 模型配置契约（本期新增）

模型配置由 L2 持有，API key 不下发客户端。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 列表（apiKey 只返回 `has_key`） |
| POST | `/v1/models` | 新建 |
| PUT | `/v1/models/:id` | 更新（apiKey 为空表示保持原值） |
| DELETE | `/v1/models/:id` | 删除（内置不可删） |
| PUT | `/v1/models/active` | 切换当前模型 |
| POST | `/v1/models/:id/test` | 测试连接 |

`UserMessage.payload.model_id` 可选；缺省时用当前 active 模型。运行中切换不影响已开始的 run。

---

## 1. 目标与非目标

### 1.1 目标

- 自然语言控制全屋设备，支持多步任务与模糊指令；
- 主动自动化：传感器事件可触发 AI 决策（频率可配、可开关）；
- 分层安全可控：AI 内核不持有设备凭据，所有设备操作经中枢鉴权与审计；
- 跨端可扩展：一期桌面客户端，二期网页/移动端复用同一后端；
- 可交付：SaaS 化代码结构 + 一客户一盒子部署。

### 1.2 非目标（一期明确不做）

- 不做设备驱动与协议栈（复用 HomeAssistant）；
- 不做本地大模型（LLM 走云端 API，provider 可配置）；
- 不做一台机器服务多个家庭的共享部署（HA 一个实例对应一套物理家庭）；
- 不做语音（ASR/TTS 后置）；
- 不做多租户计费、注册、找回密码。

---

## 2. 架构总览

### 2.1 五层结构（保持不变）

```
交互展示层 → AI-Agent内核层 → 智能中枢层 → IoT执行层 → 物理设备层
Electron客户端 → Hermes(Harness) → HomeHub → HomeAssistant → 全屋IoT设备
```

| 层 | 命名 | 职责 | 绝对不做 |
|---|---|---|---|
| L1 | 交互展示层（Electron 客户端） | 呈现、输入、流式渲染、工具过程可视化 | 不推理、不调设备、不存密钥 |
| L2 | AI-Agent 内核层（Hermes 内核） | 会话管理、推理循环、任务拆解、工具编排 | 不直连 HA、不持有设备 token、不改源码扩展 |
| L3 | 智能中枢层（HomeHub） | 唯一业务安全层：工具实现、策略鉴权、审计、事件调度、设备适配 | 不推理、不直连前端、不管电脑操控 |
| L4 | IoT 执行层（HomeAssistant） | 设备接入、协议解析、指令下发、状态上报 | 无业务、无 AI、无权限逻辑 |
| L5 | 物理设备层 | 全屋 IoT 终端 | — |

### 2.2 拓扑图

```
┌─ L1 交互展示层 ─────────────────────────────────────────────┐
│  Electron + Vue3  (会话列表 / 对话流 / 设备面板 / 场景页)      │
└───────────────┬──────────────────────────────────────────┘
                │  HTTPS + SSE (自定义信封, 仅 UI)
┌───────────────▼─ L2 AI-Agent 内核层 ───────────────────────┐
│  Hermes 内核（vendor + uv venv，子进程）· 目标: 容器沙箱      │
│  ├─ 推理循环 / 会话 / 流式                                   │
│  ├─ MCP 客户端 ──┐                                          │
│  └─ 电脑操控(默认关闭, 仅限沙箱工作目录)                       │
└─────────────────┼──────────────────────────────────────────┘
                  │  MCP (JSON-RPC over stdio/HTTP)
┌─────────────────▼─ L3 智能中枢层 ──────────────────────────┐
│  HomeHub (TypeScript / Fastify)                            │
│  ├─ ToolHub (MCP Server)   语义工具 + search_tools 元工具    │
│  ├─ Policy   实体白名单 / 频率 / 预算 / 硬拒绝清单            │
│  ├─ Audit    全量操作留痕 (who/what/why/result/trace_id)     │
│  ├─ EventBus 去抖合并 / 防环 / 规则规则引擎                  │
│  ├─ Sessions 会话与消息持久化                                │
│  └─ DeviceAdapter 接口 ──► MockAdapter | HaAdapter          │
└─────────────────┬──────────────────────────────────────────┘
                  │  REST + WebSocket
┌─────────────────▼─ L4 IoT 执行层（本期未实现）──────────────┐
│  HomeAssistant (Docker)  ·  设备驱动 / 协议 / 状态 / 事件    │
└─────────────────┬──────────────────────────────────────────┘
                  │  Zigbee / Matter / WiFi / BLE
┌─────────────────▼─ L5 物理设备层（本期未实现）──────────────┐
│  灯 / 窗帘 / 空调 / 地暖 / 传感器 / 插座 / 家电             │
└────────────────────────────────────────────────────────────┘
```

> 注：MCP 传输与 HTTP 工具调用同属 L2→L3 通道，实现上可二选一，协议语义一致。

### 2.3 八条硬约束

| # | 约束 | 落点 |
|---|---|---|
| C1 | 单向依赖：上层调下层，下层只以事件回调上层 | 全部 |
| C2 | 设备凭据只存在于 HomeHub，L1/L2 永不持有 | HomeHub 配置 |
| C3 | Hermes 只通过**配置文件 + MCP** 使用，不 fork、不 import 内部模块、不改源码 | 仓库依赖规则；本期 L2 为自研实现，按同一接缝设计 |
| C4 | Hermes 进程跑在容器内，出网白名单，禁止访问 HA 与 HomeHub 管理端口 | 部署 |
| C5 | 客户端只认「网关地址 + 消息信封」，不直连 HomeHub / HA / LLM 厂商 | 客户端；面板/场景/会话按 §5.2 直连 HomeHub |
| C6 | 任何设备操作必须经 HomeHub，且留审计 | HomeHub |
| C7 | 所有数据表带 `home_id`，所有查询带 `home_id` | 数据层 |
| C8 | 高频指令走确定性直通，不消耗模型调用 | ToolHub |

---

## 3. 分层设计

### 3.1 L1 交互展示层｜Electron 客户端

**定位**：纯视图容器，零业务逻辑、零设备权限。

**技术栈**

| 项 | 选型 | 备注 |
|---|---|---|
| 框架 | Vue 3 + Vite + TypeScript | 实际使用 |
| 样式 | 自研 CSS 变量 + 四套主题 | 不引入 Tailwind/shadcn：当前组件面小，语义 token 已够用（ADR-04） |
| 状态 | Pinia（本地 UI 态）+ TanStack Query（服务端态） | 流式增量走独立 reducer，不进全局 store |
| 渲染 | 自研安全子集 Markdown 渲染器 | 本期无网络安装依赖，先转义原始 HTML 再渲染 |
| 列表 | 分页加载（50 条/页） | 虚拟滚动未做，长会话靠分页 |
| 桌面壳 | Electron | 主进程仅做三件事：窗口、sidecar 拉起、更新 |
| 协议 | SSE，上行 POST | 上行只有"发消息/取消"两条（ADR-0001） |

**三个页面（一期）**

1. **对话页**：会话列表 + 消息流 + 流式输出 + 工具调用卡片 + 停止生成；
2. **设备面板**：按房间分组、在线/离线态、实时状态、快捷控制；
3. **场景页**：场景列表、一键执行、执行结果反馈。

**硬规则**

- UI 层禁止 `import electron`，全部经 `src/platform/` 适配层（将来换 Tauri 只改此目录）；
- 禁止在客户端存放任何 API Key / HA Token；
- `webContents` 禁止 `will-navigate` 到外部 URL；`setPermissionRequestHandler` 默认拒绝；
- 内嵌 WebView 必须 `contextIsolation: true` + `sandbox: true` + CSP + URL 白名单。

**备选方案（工期紧时）**

设备面板可改为**内嵌 HomeAssistant 仪表盘**（iframe + 专用受限用户），可节省 2–3 周；但必须处理：iframe 的 CSP 放行、HA 侧独立账号与权限、以及"面板风格不统一"的体验问题。一期按自研面板执行，此方案作为 M1 延期时的降级选项。

**性能要求**

- 流式分片按 `requestAnimationFrame` 批量合并渲染，避免每个 token 一次 patch；
- 消息超过 500 条启用虚拟滚动 + 历史分页（`GET /v1/sessions/{id}/messages?before=`）；
- 单会话连续 20 轮对话不掉帧。

﻿### 3.2 L2 AI-Agent 内核层｜Hermes

**定位**：唯一负责思考与决策的层（不定稿其内部实现细节，只锁定接入方式）。

**实现**：L2 = **Hermes（NousResearch/hermes-agent，MIT 开源）** + **Gateway 接入层**。
接入层负责三件事：把消息变成一次 Hermes run、把 Hermes 的输出翻译成 `RunEvent`、把 HomeHub 的工具经 MCP 交给 Hermes。
**不改 Hermes 源码、不 import 其内部模块**（C3）。

自研薄循环（`agent.ts`）保留为**降级路径**：Hermes 运行时未就绪时自动回落，对话不中断。
详细规范见 [`docs/HERMES.md`](./HERMES.md)。

**部署形态**

| 项 | 做法 |
|---|---|
| 源码 | `vendor/hermes-agent`（git submodule，固定 tag） |
| 运行时 | `hermes-venv`（uv 虚拟环境，**平台绑定，不进 git**） |
| 分发 | 打包时 venv 走 `extraResources`，解包后为 `resources/hermes-venv` |
| 调用 | Gateway `spawn` 启动器（`Scripts/hermes.exe` / `bin/hermes`），stdio 交互 |
| 隔离 | 独立进程，独立工作目录，`HERMES_HOME` 指向 `data/hermes` |

不用 npm 桥 `hermes-agent`：它没有可 import 的 API，运行时落在 `node_modules` 里，
electron-builder 打包会丢，且 npm 重装会替换 venv。桌面应用要的是确定、可打包、可离线启动的运行时。

**模块**

| 模块 | 职责 | 文件 |
|---|---|---|
| `hermes/runtime` | 解析 venv、探测启动器、报告 ready/not_ready | `src/hermes/runtime.ts` |
| `hermes/runner` | spawn、按行解析、事件映射、超时与取消 | `src/hermes/runner.ts` |
| `hermes/config` | 生成 `HERMES_HOME/config.yaml`（模型、MCP 服务器） | `src/hermes/config.ts` |
| `hermes/skills` | 列 `HERMES_HOME/skills`，供系统提示使用 | `src/hermes/skills.ts` |
| `route` | L0 / Hermes / 自研循环 的路由判定 | `src/route.ts` |
| `tools/*` | 内置工具集（文档、文件、联网），经 MCP 暴露 | `src/tools/` |
| `agent` | 自研薄循环（降级路径，语义与 Hermes 路径完全一致） | `src/agent.ts` |
| `l0` | 高频指令确定性解析，命中即执行，不进模型 | `src/l0.ts` |
| `llm` / `models` | 三协议模型适配（chat_completions / responses / anthropic） | `src/llm.ts`、`src/models.ts` |
| `mcp-client` | JSON-RPC 2.0 客户端，支持多服务器 | `src/mcp-client.ts` |
| `stream` | 事件日志 + SSE 扇出（`log_seq` 游标） | `src/stream.ts` |
| `server` | `/v1/stream`、`/v1/chat/*`、`/v1/models`、`/v1/hermes/*` | `src/server.ts` |

**接入方式（C3 约束）**

| 接触面 | 用途 | 允许 |
|---|---|---|
| 配置文件 | 模型、MCP 服务器、工具开关、沙箱目录 | ✅ |
| MCP 客户端 | 连接 HomeHub ToolHub 与用户自定义 MCP | ✅ |
| CLI 子进程 | 一次 run 的输入输出 | ✅ |
| 源码/内部模块 | 改推理循环、加私有钩子 | ❌ 禁止 |

**能力裁剪**

- 电脑操控（文件/代码/shell）：保留，但**默认关闭**，开启后只作用于 `data/workspace`；
- 浏览器/无关内置工具：默认关闭，减少工具选择噪音；
- 每 `home` 一个 workspace 目录，每 `session` 一个上下文，禁止跨会话共享记忆。

**记忆策略**

| 类型 | 载体 | 生命周期 | 注入方式 |
|---|---|---|---|
| 单轮上下文 | Hermes session / 自研循环上下文 | 单次 run | 进程内，随 run 结束释放 |
| 会话历史 | HomeHub `sessions` / `messages` 表 | 长期，可删 | 前端分页读，不进 prompt |
| 用户偏好 | HomeHub `preferences` 表 | 长期，显式可查改 | 自研循环拼系统提示；Hermes 走 `withInstructions()` |
| 家庭知识库（户型、设备位置、作息） | `rag` 模块 | ⏳ 二期 | — |

约束：**记忆必须可查、可改、可删**。禁止把偏好做成不可见的隐式向量记忆。

对外接口（客户端"设置 → 智能体 → 记忆"就是这张表的增删改查）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/memory` | 网关侧只读视图（键值对数组），供设置页展示 |
| GET | `/v1/preferences` | HomeHub 原始列表（用户票据） |
| PUT | `/v1/preferences/:key` | 写入/覆盖一条偏好，body `{ "value": "..." }` |
| DELETE | `/v1/preferences/:key` | 删除一条偏好（空 body，已容错） |

**内置工具的统一出口**

9 个内置工具注册在 Gateway，并起一个**只监听回环**的 MCP 端口 `127.0.0.1:4031/mcp`
（`TOOL_MCP_PORT` 可覆盖），票据每进程随机生成、不落盘：

| 调用方 | 路径 | 说明 |
|---|---|---|
| Hermes | 写进 `HERMES_HOME/config.yaml` 的 `mcp.servers`（条目名 `homeclaw-tools`） | 子进程通过 MCP 调用 |
| 自研循环 | 进程内直调（`LocalToolMcp`） | 不经过网络，少一跳 |
| 其他 MCP | `MultiMcp` 转发到 HomeHub ToolHub | 本地名命中走本地，其余转发 |

为什么不用"让 Hermes 直接 import 工具"：那需要改 Hermes 源码（C3 禁止），且进程内共享状态会把
沙箱边界和取消语义一起搞乱。MCP 是唯一稳定的跨进程接缝。

**分发的现实约束**

打包形态不在本层定，但有两件事现在就必须成立，否则"能跑"只存在于开发机：
venv 与平台绑定（Windows/macOS/Linux 各自生成），以及 Hermes 未就绪时必须静默回落（§10 of `docs/HERMES.md`）。

**内核能力核对**

替换内核时下面每一项都必须有等价实现，否则客户端会出现"卡片停在执行中"这类状态残留：

| 能力 | Hermes 路径 | 自研路径 |
|---|---|---|
| 对外 API 形态 | 不变：SSE + 两条 POST，信封见 §5.1 | 同左 |
| `tools/list` 动态变化 | Hermes 每次 run 重新拉 MCP 工具列表 | 按 `session_id` + `query` 返回 |
| 工具中间态 | 从 stdout 事件映射为 `tool.start` / `tool.result` | 原生两态 |
| 取消语义 | kill 子进程树 + 补 `done` 帧 | `AbortController` |
| 并发 run | 同会话串行（409），不同会话并行 | 同左 |

### 3.3 L3 智能中枢层｜HomeHub

**定位**：唯一业务安全层，也是唯一持有设备凭据的进程。

**技术栈**：TypeScript + Fastify + SQLite(WAL)。用 Node 内置 `node:sqlite`，不用 ORM（ADR-0002）。

**模块划分（一期）**

| 模块 | 职责 | 一期是否做 |
|---|---|---|
| `toolhub` | MCP Server：暴露语义工具、`search_tools` 元工具、参数校验 | ✅ |
| `policy` | 实体白名单、频率上限、预算上限、硬拒绝清单 | ✅ |
| `audit` | 全量操作留痕，可查询、可导出 | ✅ |
| `eventbus` | 事件接收、去抖合并、防环、规则引擎 | ✅ |
| `sessions` | 会话与消息持久化（供客户端多端复用） | ✅ |
| `adapter` | `DeviceAdapter` 接口 + `MockAdapter` / `HaAdapter` | ✅（HA 待定） |
| `automation` | 主动自动化编排、频率与预算约束 | ✅ |
| `rag` | 家庭知识库 | ⏳ 二期 |
| `voice` | ASR/TTS 流水线 | ⏳ 二期 |

**单机多首页面（为 SaaS 留结构）**

```
HomeRuntime 工厂：home_id → { adapter, policy, eventbus, toolhub, config }
一期只实例化一个 home，但所有模块按 home 注入，禁止全局单例。
```

### 3.4 L4 IoT 执行层｜HomeAssistant（本期未实现）

**状态**：本期不实现。`apps/homehub/src/adapter/factory.ts` 对 `ADAPTER=ha` 直接抛错，只有 `MockAdapter` 可用。以下为接入时的目标契约，不在本期验收范围。

**定位**：纯执行底座。HomeHub 是它唯一调用方。

**适配器接口（一期唯一契约）**

```ts
export interface DeviceAdapter {
  listEntities(homeId: string): Promise<Entity[]>;
  getState(entityId: string): Promise<EntityState>;
  callService(cmd: ServiceCommand): Promise<ServiceResult>;   // 带幂等键
  subscribeEvents(homeId: string, cb: (e: DeviceEvent) => void): Promise<Unsubscribe>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
```

**MockAdapter（一期顶上，HA 未就绪不阻塞）**

- 内置 12 个虚拟实体：3 个房间 × （主灯、氛围灯、窗帘、温湿度）；
- 状态可持久化，`callService` 真实改变状态并产生事件（用于验证防环与去抖）；
- 提供 `POST /_mock/inject-event` 用于注入传感器事件，模拟真实触发。

**HaAdapter（二期接入）**

- 读取：REST `/api/states`、`/api/services/{domain}/{service}`；
- 事件：WebSocket `subscribe_events`；
- 凭据：long-lived token 仅存 HomeHub 侧配置，永不下发；
- 注意：HA token 是全权凭据，无实体级 ACL，因此**实体白名单必须在 HomeHub 实现**。

**实体命名规范（现在就定）**

```
light.living_room_ceiling
sensor.bedroom_temperature
cover.study_curtain
```

- 分组只用 HA 的 `area` 与 `label`，不靠名字前缀猜测；
- 显示名（中文）与实体 ID 分离，显示名可随时改。

### 3.5 L5 物理设备层（本期未实现）

灯、开关、窗帘、空调、地暖、新风、传感器（人体存在/温湿度/门窗/水浸）、插座、家电。

接入协议为 Zigbee / Matter / WiFi / BLE。红外遥控（空调、电视等）属于 L4 的集成能力，不是独立一层。

**商用合规提示**：HomeAssistant Core 为 Apache-2.0，可商用；但 `zigbee2mqtt` 为 GPL-3.0，随硬件出货需履行源码提供义务；HACS 中部分第三方集成无明确许可，商用前需逐个核查。

---

## 4. 工具层设计（Tool Search）

### 4.1 为什么不能全量注入

200–400 个实体 × 每个 ~60–80 tokens（name + description + schema）≈ **15k–30k tokens/轮**。后果：成本线性上涨、prompt cache 失效、模型选错实体概率显著上升、延迟增加。

### 4.2 三层结构

```
L0  确定性直通   高频槽位指令（开/关/亮度/温度）→ 不进 LLM
L1  常驻语义工具 35 个（房间 × 设备类）→ 稳定命中 prompt cache
L2  检索式长尾   embedding + BM25 混合检索 → top-8 动态注入
```

**L0 确定性直通**

- 覆盖：`开灯 / 关灯 / 调到 N% / 空调 N 度 / 开窗帘 / 全部关闭 / 某房间某设备开关`
- 实现：规则匹配 + 槽位填充（房间词典、设备词典、数值、单位），命中即调用 `callService`；
- 未命中则升级到 L1/L2 走模型；
- 收益：吃掉 30–40% 流量，延迟 <100ms，成本 0，行为 100% 可复现。

**L1 常驻语义工具（当前 25 个，目标 35 个）**

按"房间 + 设备类"聚合，而非按实体：

| 类别 | 工具 | 数量 |
|---|---|---|
| 灯 | `set_room_light(room, level, color_temp?)` / `get_room_light(room)` | 2 |
| 窗帘 | `set_cover(room, position)` / `get_cover(room)` | 2 |
| 空调 | `set_climate(room, temp, mode?, fan?)` / `get_climate(room)` | 2 |
| 地暖/新风 | `set_floor_heat(room, on, temp?)` / `set_fan(room, on, level?)` | 2 |
| 环境 | `get_room_climate(room)` / `get_home_environment()` | 2 |
| 安防/门 | `get_security_status()` / `get_presence(room?)` | 2 |
| 场景 | `list_scenes()` / `run_scene(name)` | 2 |
| 设备查询 | `list_devices(room?, type?)` / `get_device_state(entity_id)` | 2 |
| 传感器 | `query_sensors(type?, room?, since?)` | 1 |
| 媒体 | `set_media(room, action)` | 1 |
| 规则 | `list_automations()` / `enable_automation(id, on)` | 2 |
| 其他设备 | `set_plug(room|name, on)` / `get_energy_usage(scope?)` | 2 |
| 上下文 | `get_home_summary()` | 1 |
| 元工具 | `search_tools(query, limit=8)` / `call_tool(name, args)` | 2 |

合计约 26–35 个，schema 总控 **≤2k tokens**。当前 `catalog.ts` 已实现 25 个 L1 + 18 个 L2。

**L2 检索式长尾**

- 注册表存全部设备专属能力（扫地机、新风模式、影音、晾衣架等）；
- 检索：当前为字符 bigram BM25（中文按单字 + bigram，英文整词），取 top-8；无 embedding 服务，二期接入时在 `score()` 内做加权融合，接口不变；
- 注入方式（二选一，不改 Hermes 源码）：
  - **首选**：ToolHub 的 `tools/list` 按会话上下文**只返回被选中的工具**（MCP 协议允许 `tools/list` 每次返回不同集合）；
  - 备选：`search_tools` 元工具由模型主动调用，返回候选 schema 后再 `call_tool`。
- 缓存：按 `session_id` 缓存命中集合（TTL 5 分钟），避免 prompt cache 反复失效。

### 4.3 工具描述撰写规范

- 描述写"**什么时候用**"，不写"这个工具是什么"；
- 每个工具有唯一主语（房间/设备类），避免模型在相似工具间犹豫；
- 参数用枚举而非自由文本（`room: "客厅" | "主卧" | ...` 从配置生成）；
- 工具名动宾结构：`set_room_light` 优于 `light_control`。

### 4.4 评测（工具搜索的验收）

- 建立 **100 条真实口语指令**评测集，标注期望工具 + 期望参数；
- 指标：`recall@8 ≥ 0.95`、工具选择准确率、参数正确率、端到端成功率；
- 每次改工具描述、改检索策略、换模型，CI 必须跑回归。

---

## 5. 接口契约

### 5.1 客户端 ↔ Hermes（消息信封）

```jsonc
// 客户端 → 网关
{ "v": 1, "type": "user.message",
  "id": "c_01H...", "session_id": "s_01H...",
  "ts": 1761091200,
  "payload": { "text": "把客厅灯调到30%暖光", "attachments": [] } }

// 网关 → 客户端（流式分片）
{ "v": 1, "type": "assistant.delta",
  "id": "a_01H...", "reply_to": "c_01H...",
  "seq": 12, "payload": { "text": "好的，" } }

// 工具调用中间态（客户端必须能渲染）
{ "v": 1, "type": "tool.start",
  "id": "t_01H...", "payload": { "tool": "set_room_light",
    "args": { "room": "客厅", "level": 30 }, "summary": "客厅灯 → 30%" } }
{ "v": 1, "type": "tool.result",
  "id": "t_01H...", "payload": { "ok": true, "elapsed_ms": 240 } }

// 控制类
{ "v": 1, "type": "run.cancel",  "payload": { "target": "a_01H..." } }
{ "v": 1, "type": "error",       "payload": { "code": "UPSTREAM_TIMEOUT",
    "message": "模型响应超时", "retryable": true } }
```

**约定**

- 每个 `assistant.delta` 带 `seq`，客户端据此去重与排序（重连补发必需）；
- `reply_to` 关联用户消息，支持并发多轮；
- 所有信封带 `v`（协议版本），破坏性变更必须升版本；
- 断线重连：客户端带 `last_seq` 重连，服务端用事件日志补发缺口（`log_seq > last_seq`）；
- **补齐边界**：L2 事件日志当前只存内存、上限 2000 条，进程重启后 `last_seq` 归零。此时客户端带旧游标重连会拿不到缺口，需回落 HomeHub 历史分页（`GET /v1/sessions/{id}/messages?after=`）重建，再以新的 `session.ready.last_seq` 重置游标。

### 5.2 客户端 ↔ HomeHub（仅面板与场景，不经 Hermes）

```http
GET  /v1/entities?room=&type=            → Entity[]
GET  /v1/entities/{id}                   → Entity
POST /v1/entities/{id}/command           → { ok, state }   # 面板手动控制
GET  /v1/scenes                          → Scene[]
POST /v1/scenes/{id}/run                 → { ok, results[] }
GET  /v1/sessions                        → Session[]
GET  /v1/sessions/{id}/messages?before=  → Message[]       # 分页
GET  /v1/audit?from=&to=&entity=         → AuditEntry[]
GET  /v1/health                          → { ok, adapter, llm, gateway }
```

> 注意：客户端访问 HomeHub 用的是**用户会话票据**；AI 访问 HomeHub 用的是 **MCP 服务票据**。两套凭据不同权限，不可混用。

### 5.3 数据结构

```jsonc
// Entity
{ "id": "light.living_room_ceiling", "home_id": "h_01H...",
  "name": "客厅主灯", "room": "客厅", "type": "light",
  "capabilities": ["on_off", "brightness", "color_temp"],
  "state": { "on": true, "brightness": 80, "color_temp": 3000 },
  "available": true, "updated_at": 1761091200 }

// ServiceCommand
{ "idempotency_key": "uuid", "home_id": "h_...", "entity_id": "light...",
  "service": "turn_on", "data": { "brightness_pct": 30 },
  "origin": "ai | user | rule", "trace_id": "tr_...", "timeout_ms": 5000 }

// DeviceEvent
{ "id": "e_...", "home_id": "h_...", "entity_id": "binary_sensor...",
  "kind": "state_changed", "old": "off", "new": "on",
  "origin": "device | ai | user | rule", "ts": 1761091200 }

// AuditEntry
{ "trace_id": "tr_...", "home_id": "h_...", "actor": "ai:hermes | user:u_...",
  "action": "entity.command", "target": "light...",
  "params": { "brightness_pct": 30 }, "decision": "allow | deny",
  "reason": "policy_whitelist | hard_deny | budget_exceeded",
  "result": "ok | error", "elapsed_ms": 240, "ts": 1761091200 }
```

---

## 6. 主动自动化

### 6.1 链路（按定稿）

```
设备/传感器状态变化 → HA 事件 → HomeHub EventBus
  → 去抖合并 → 频率/预算校验 → 防环判定 → 推 Hermes
  → Harness 组装上下文 → 云端 LLM 推理 → 工具调用
  → HomeHub 鉴权 → HA 执行 → 审计 + 通知客户端
```

### 6.2 四件套（全部为配置项，必须实现）

| 机制 | 规则 | 默认值 |
|---|---|---|
| **开关** | 全局开关 + 按规则/按房间单独开关 | 全局开，规则默认关 |
| **去抖 + 合并** | 同一实体 N 秒内多次事件合并为一次 | 10s |
| **频率上限** | 每实体/每房间/每小时触发数 + 全局每小时上限 | 房间 6/h，全局 60/h |
| **预算上限** | 每日 token / 费用封顶，超限降级（转规则或静默）并告警 | 日预算可配 |
| **防环** | `origin=ai` 引发的事件不再触发 AI（可选：允许同 trace 内 1 跳） | 硬阻断 |

### 6.3 去抖算法（推荐实现）

```ts
// 每次事件进入：
// 1) 若 origin ∈ {ai, rule} → 直接丢弃（防环）
// 2) 若 (entity_id, attr) 在窗口内有待发任务 → 更新终值，不新建
// 3) 窗口结束 → 提交一次推理请求（携带 first_event / last_event / final_value）
```

**为什么必须记录 `first_event`**：LLM 判断"有人进来了"需要知道持续时长，只看终值会丢失"进来了多久"这个关键信息。

### 6.4 规则引擎（与 LLM 并存）

即使采用 LLM 实时闭环，确定性规则仍需存在，因为：

- 断网时系统必须仍能执行基本自动化；
- 高频重复场景（人来开灯）不应该每次都花一次模型调用；
- 用户需要"可预期"的行为。

规则格式（一期最小集）：

```jsonc
{ "id": "auto_01H", "home_id": "h_...", "enabled": true,
  "when": { "entity": "binary_sensor.living_room_presence", "to": "on",
            "for_seconds": 3 },
  "then": [{ "action": "entity.command", "entity": "light.living_room_ceiling",
             "service": "turn_on", "data": { "brightness_pct": 30 } }],
  "cooldown_seconds": 300, "origin": "rule" }
```

二期：允许 LLM 把对话中的自然语言"翻译成规则"并落库（作者态），经用户确认后生效。

---

## 7. 安全设计

### 7.1 信任边界（核心）

| 边界 | 手段 | 说明 |
|---|---|---|
| L1 ↔ L2 | 用户会话票据 | 客户端不持有任何设备凭据 |
| L2 ↔ L3 | **MCP 服务票据 + 实体白名单** | AI 即使被提示词注入，也只能调用白名单内工具 |
| L3 ↔ L4 | HA long-lived token（仅 HomeHub 持有） | HA token 全权，故 ACL 必须在 L3 实现 |
| L2 容器 ↔ 宿主 | 沙箱 + 出网白名单 + 目录挂载限制 | 防止 shell 能力绕过分层 |

### 7.2 一期安全措施

| 措施 | 一期 | 说明 |
|---|---|---|
| 实体白名单 | ✅ | 非白名单实体，工具调用直接拒绝 |
| 服务白名单 | ✅ | 仅允许 `turn_on/turn_off/set_*` 等，禁止 `reload` 类管理服务 |
| 硬拒绝清单（保险丝） | ✅ | 3–5 项：门锁、燃气阀、总闸、地暖最高档。命中即拒，不进模型判断 |
| 提示词强化 | ✅ | 系统提示词声明禁止操作范围与需确认场景 |
| 审计 | ✅ | 全量工具调用与手动操作 |
| 危级分级 + 二次确认 | ❌ | 已确认一期不做，标注为已知风险 |
| 沙箱隔离 | ✅ | 容器 + 出网白名单 |
| 速率限制 | ✅ | 客户端 API 与 MCP 各自限流 |

> **已知风险（接受）**：一期无高危操作二次确认，依赖提示词判断。缓解手段为硬拒绝清单。若日后接入门锁/燃气类设备，必须升级为危级分级。

### 7.3 提示词注入防护

- 设备返回内容、网页内容、用户上传文本，一律视为**不可信数据**，不得拼接进系统提示词；
- 工具返回值仅作数据，明确包裹（`<tool_result>` 且声明为数据）；
- 禁止 L2 读取环境变量中的令牌；
- 家居工具不接受 URL 或任意脚本参数。

---

## 8. 里程碑

> 开发顺序：**按层推进，客户端优先**（已定）。每个里程碑必须有可演示产物与验收项。

### M0｜客户端骨架 + 契约冻结（约 1 周）

**为什么先做客户端**：先立住 UI 与协议，后续每层接入时都有消费者验证，避免契约设计完无人使用。

**但必须有一道护栏**：客户端不允许自己造后端。同期产出**契约文件 + Mock 服务**：

- `packages/contracts/`：TypeScript 类型 + JSON Schema（envelope、Entity、Scene、AuditEntry）；
- `apps/mock-server`：实现 §5.1 与 §5.2 全部接口，返回假数据、假流式（按 30ms 分片）、假工具调用（含 800ms 延迟模拟）。

**产出**：Electron 客户端可安装运行；三页骨架；与 mock-server 完整联调。

**验收**：
- [ ] 连续对话 20 轮不卡顿，流式渲染无丢字
- [ ] 工具调用卡片能显示 start → result 两态
- [ ] 断网 30s 后恢复，消息不丢（`last_seq` 补齐生效）
- [ ] 设备面板显示 12 个 Mock 实体，含 1 个离线态
- [ ] 场景页可执行，有结果反馈

### M1｜HomeHub 骨架 + 适配器 + 数据模型（约 1.5 周）

**产出**：Fastify 服务、SQLite + 迁移、`DeviceAdapter` + `MockAdapter`、`/v1/entities` `/v1/scenes` `/v1/health` 真实实现。

**验收**：
- [ ] 客户端把 mock-server 换成真实 HomeHub，**前端一行不改**
- [ ] 手动控制设备后状态变化能实时推送到面板
- [ ] 数据表全部含 `home_id`

### M2｜ToolHub + 审计 + 策略（约 1.5 周）

**产出**：MCP Server（35 个语义工具 + `search_tools`）、参数校验、白名单、审计、幂等键、超时重试、死信。

**验收**：
- [ ] 非白名单实体调用被拒且留审计
- [ ] 幂等键重复提交不重复执行
- [ ] 工具 schema 总 token ≤ 2k
- [ ] 审计可按 trace_id 串起一次完整请求

### M3｜事件总线 + 规则引擎 + 主动自动化（约 2 周）

**产出**：事件订阅、去抖合并、防环、频率/预算上限、规则执行、事件推送上游。

**验收**：
- [ ] `POST /_mock/inject-event` 连发 20 次，10s 内只产生 1 次推理请求
- [ ] AI 动作引发的状态变化不触发新的 AI 推理（防环生效）
- [ ] 超过频率上限时拒绝并留审计
- [ ] 关闭 LLM 后规则引擎仍能执行

### M4｜L2 内核（Hermes 接入 + 自研降级）

**前置**：完成 §3.2「内核能力核对」清单。

**产出**：
- Hermes 运行时解析、子进程启动、按行事件解析、超时与取消（`src/hermes/*`）；
- 路由层：L0 直通 / Hermes / 自研循环（`src/route.ts`）；
- `HERMES_HOME/config.yaml` 生成：模型、MCP 服务器、沙箱目录（`src/hermes/config.ts`）；
- 内置工具集：文档读取、文件批量、联网抓取（`src/tools/*`），经本地 MCP 端口（`127.0.0.1:4031`）对两条执行路径统一暴露；
- Skill 列表 API（复用 Hermes 原生 skill 机制）；
- 记忆（偏好）闭环：`preferences` 表 + `/v1/memory` 只读视图 + 两条执行路径注入；
- 多 MCP 服务器客户端，工具名前缀隔离；
- 运行时模型配置（三协议：`chat_completions` / `responses` / `anthropic`，§0.3.2）。

**未完成**：容器沙箱、出网白名单（L2 仍以本机进程运行）。

**验收（实现状态）**：

- [x] 未安装运行时：`/v1/health` 的 `hermes.status = degraded`，详情给出安装提示，其他功能不受影响
- [x] 复杂指令走 Hermes，SSE 可见 `tool.start` / `tool.result`（用注入子进程实测，见 `apps/gateway/tools/e2e-hermes.mjs`）
- [x] 简单指令与 L0 命中仍走本地路径，延迟 < 200ms
- [x] Hermes 一个 delta 都没产出时静默回落自研循环，对话不报错
- [x] 已产出部分内容后失败：不再回落，补"未跑完"说明并收尾（避免两段答案拼接）
- [x] 自然语言"打开客厅灯"端到端成功（L0 直通）
- [x] 多步指令"帮我整理这批资料，然后汇总成纪要"路由到内核并逐工具下发
- [x] 46 项单测覆盖事件翻译、分包收尾、沙箱越界、MCP 鉴权、路由判定
- [x] 偏好（记忆）可增可删，且真的进了两条路径的系统提示（改一条偏好后下一轮答复随之变化）
- [x] 设置页「智能体」分类：运行时状态、测试连接、工作目录、MCP 增删启停、技能清单、记忆增删
- [ ] 取消能杀掉 Hermes 子进程（无残留）—— 需真机 Python 运行时验证
- [ ] 与真实 `hermes.exe` 的 ndjson 输出逐字段对齐 —— 需真机验证

### M5｜接入真实 HA（本期不做，HA 就绪后启动）

**产出**：`HaAdapter`、实体同步、事件订阅、可用性检测。

**验收**：
- [ ] 真实设备控制成功率 ≥ 99%（100 次）
- [ ] 设备离线时面板正确显示且指令返回明确错误
- [ ] HA 重启后自动重连并补齐状态

### M6｜稳定性与交付（约 1.5 周）

**产出**：异常重连、降级策略、日志与告警、安装包、开机自启、远程升级通道。

**验收**：
- [ ] 断网/断 LLM/断 HA 三种故障下均有明确用户提示且不崩溃
- [ ] 安装包可交付，体积与启动时间达标
- [ ] 远程升级可灰度、可回滚

---

## 9. 部署形态

### 9.1 形态一：单机一体化（开发 / 自用）

一台主机运行全部服务：

```
同一台机器（Windows + WSL2 或 Linux）
├─ Electron 客户端
├─ Hermes（容器）
├─ HomeHub
└─ HomeAssistant（Docker）
```

- 优点：零网络配置，调试最快；
- 缺点：服务随客户端关闭而中断，不能多端访问。

> 开发期注意：Windows 上 Docker Desktop 直通 USB Zigbee 协调器极不稳定，**开发建议 WSL2 + Docker**，生产建议独立小主机或 HA OS。

### 9.2 形态二：一客户一盒子（商用交付形态）

```
客户局域网
├─ 边缘盒子（7×24 常驻）
│   ├─ Hermes（容器）
│   ├─ HomeHub
│   └─ HomeAssistant（Docker / HA OS，USB 协调器物理直连）
└─ 终端设备
    ├─ 桌面客户端（Electron）
    └─ 手机浏览器 / 后续小程序（二期）
```

- 服务常驻，客户端可关；多端访问同一后端；
- **一台盒子 = 一套物理家庭**（HA 一个实例只能对应一个家庭，Zigbee/Matter 设备也绑定本机协调器）；
- 因此"SaaS 多租户"落在**代码结构**（`home_id` 贯穿）与**统一运维**上，而非共享部署。

### 9.3 远程访问（待定，M6 前定）

单机部署意味着服务在客户局域网内，远程使用需三选一：

| 方案 | 优点 | 缺点 |
|---|---|---|
| 组网（Tailscale / ZeroTier） | 实现最快、无需公网 | 需在客户端装组网组件 |
| 隧道（Cloudflare Tunnel / frp） | 免公网 IP | 依赖第三方，需评估数据合规 |
| 自建中继 | 完全可控 | 需公网服务器与运维成本 |

无论哪种，**客户端票据与 MCP 服务票据必须分离**，远程暴露的只有客户端入口，绝不暴露 HA。

### 9.4 升级与运维

- 一客户一盒子 → **必须能远程推版本**，否则一次故障就要上门；
- 镜像打标签，支持灰度（按 `home_id` 分批）与回滚；
- 启动自检：`GET /v1/health` 汇总 adapter / llm / gateway 三路状态，客户端首屏展示；
- 日志落盘 + 轮转（按天，保留 14 天），异常上报可选。

---

### 9.5 打包与分发

不引入 electron-builder（离线环境装不了它的依赖，且它的价值主要是做安装程序外壳）。
这里用 **Electron 原生的 `resources/app` 目录形态**装配绿色包，产物结构与安装包一致，可直接双击运行。

**装配链（三步，各自可单独重跑）**

```
node --import ./apps/web/esbuild-register.mjs tools/build-backend.mjs   # ① 后端 → dist-backend/*.mjs
cd apps/desktop && npx tsc -p tsconfig.main.json                        # ② 主进程 → apps/desktop/dist
cd apps/web && node --import ./esbuild-register.mjs build.mjs           # ③ 界面 → apps/web/dist
node tools/package-app.mjs                                              # ④ 装配 → release/
```

**产物结构**

```
release/HomeClaw-<platform>-<arch>/
├─ HomeClaw.exe                 # electron.exe 改名；已删 resources/default_app.asar
└─ resources/
   ├─ app/                      # main.js / preload.js / log.js / package.json
   ├─ web/                      # 界面产物（app:// 协议从这里取文件）
   ├─ backend/                  # homehub.mjs / gateway.mjs（单文件，依赖已内联）
   ├─ node/node.exe             # 随包 Node，用户机器不需要装 Node
   └─ hermes-venv/              # 可选，存在才拷（平台绑定）
```

**为什么后端要打成单文件，而不是随包放 .ts 源码**

dev 靠 `--experimental-strip-types` 直接跑 TS。但那是**实验特性**，且依赖目标机器上
Node 版本、包类型发现顺序完全一致；任何一项不同，现象都是"进程起来了但端口一直不通、
日志里一行错误都没有"。单文件 .mjs 只剩 Node 标准库 + 已内联依赖，行为稳定。

两个被这条约束逼出来的细节：

- `server.ts` 的入口判定改成 `HOMECLAW_STANDALONE=1 || argv[1] 以 src/server.ts 结尾`。
  只认后者的话，打包产物会"能加载但永不 listen"；
- `node:sqlite` 仍是实验特性，打包态仍需 `--experimental-sqlite`。

**开发态 / 打包态的差别只在"跑什么文件、用哪个 node"**

| 项 | 开发态 | 打包态 |
|---|---|---|
| 后端入口 | `apps/{homehub,gateway}/src/server.ts` | `resources/backend/*.mjs` |
| node | `HOMECLAW_NODE` / `npm_node_execpath` / PATH | `resources/node/node.exe`，缺失才回落 PATH |
| 数据根 | 仓库根 | `%APPDATA%\HomeClaw`，不可写时自动切便携目录 |
| 界面 | `apps/web/dist` | `resources/web` |
| Hermes | `<repo>/hermes-venv` | `resources/hermes-venv`（主进程注入 `HERMES_VENV`） |

**四条硬约束（每条都对应一次真实故障）**

1. **不能用 `process.execPath` 跑 node 脚本**：Electron 里它指向 `electron.exe`，
   后端起成第二个 Electron 实例，现象是桌面弹"应用程序错误"而后端一个都没起来；
2. **userData 必须在拿单实例锁之前定好**：Chromium 要在 userData 下建 Cache/Network，
   目录不可写时它在 ready **之前**就退出，日志只有 `process_singleton` 的 "Lock file can not be created"，
   界面上完全是"双击没反应"。所以先探可写性，不可写就整体切到 `<安装目录>/HomeClawData`（便携模式）；
3. **sidecar 的 spawn 失败要写进主进程日志**：spawn 的 `error` 是异步事件，
   只重定向到子进程日志文件的话那里根本不会有文件，用户看不到任何线索；
4. **工具 MCP 端口不能写死 4031**：开发机常常同时开着命令行 Gateway 与桌面端，
   抢端口时后起的那个只丢一条 warn，表现是"Hermes 看不到内置工具"，且不一定哪次成功。
   现在默认 `GATEWAY_PORT + 1`。

**已验证**（Windows 实机）

- [x] 双击 `HomeClaw.exe` → 便携 userData 建立 → 用随包 node 拉起 `homehub.mjs` 与 `gateway.mjs`
- [x] `:HUB/v1/health` 与 `:GW/v1/health` 均 200，`tools` 报 9 个内置工具
- [x] 端到端一轮对话："打开客厅灯" → L0 直通 → 工具卡 + AI 回复，三条消息正确落库
- [x] `%APPDATA%` 不可写的机器上不再"双击没反应"，而是自动切便携目录并留日志
- [ ] 安装程序外壳（NSIS / DMG）与自动更新：需要 electron-builder 或等价工具，留到能联网的打包机

## 10. 附录

### 10.1 旧文档矛盾清单（本文已消解）

| # | 矛盾 | 本文处理 |
|---|---|---|
| 1 | L2"无设备权限" vs "原生 shell/文件操作" | 保留电脑操控但默认关闭 + 沙箱 + 出网白名单 |
| 2 | "唯一用户入口" vs "内嵌网页/H5/小程序" | 一期仅桌面；网页/消息只留接口 |
| 3 | 会话管理同时写在 Gateway 与 Harness | 统一归 L2 整体，不细分内部归属 |
| 4 | "架构永久不变" | 改为"层级不变、层内可演进" |
| 5 | "ACP + WebSocket" | 改为自定义信封，不假定 ACP |
| 6 | "无需 MCP" vs 工具扩展需求 | 明确 MCP 为唯一扩展通道 |
| 7 | 24 天产品级上线 | 改为 8 个里程碑，按验收推进 |
| 8 | 两份文档重合约 90% | 合并为本文，旧文归档 |

### 10.2 决策记录（ADR）

| 编号 | 决策 | 理由 |
|---|---|---|
| ADR-01 | 五层架构不变 | 用户要求；层内可实现约束解决安全问题 |
| ADR-02 | 客户端 Vue3 + Vite + TS + Electron | 全项目 TS 单语言；UI 经 `platform/` 可迁移 Tauri |
| ADR-03 | Hermes 仅经配置 + MCP 接入，不改源码 | 用户约束；避免绑定不稳定内部 API。L2 以 vendor + 子进程方式接入 |
| ADR-04 | HomeHub 用 TypeScript/Fastify | 与 L2 共享 MCP 与类型生态；难点在语义层而非语言 |
| ADR-05 | LLM provider 抽象，无硬编码模型名 | 模型半年一换，避免技术债 |
| ADR-06 | 工具搜索三层（L0 直通 / L1 常驻 / L2 检索） | 全量注入 15k–30k tokens/轮不可承受 |
| ADR-07 | 主动自动化 LLM 实时闭环 + 四件套约束 | 用户要求；四件套防止费用/延迟/死循环失控 |
| ADR-08 | 一期不做高危分级，用硬拒绝清单兜底 | 用户要求；保险丝成本极低但拦得住最坏情况 |
| ADR-09 | SaaS 代码结构 + 一客户一盒子部署 | HA 一个实例对应一套物理家庭，共享部署在硬件层不可行 |
| ADR-10 | 账号仅管理员/成员两级 | 单机部署下足够；注册/找回密码二期 |
| ADR-11 | HA 用适配器隔离，一期 Mock | HA 未就绪；契约优先，避免阻塞 |
| ADR-12 | 先做客户端 | 用户要求；配套 mock-server + contracts 防止契约无消费者验证 |
| ADR-0006 | L2 用 Hermes 开源内核，vendor + 预构建 uv venv，子进程调用 | 用户要求"直接引入开源"；不用 npm 桥：无可 import API、运行时在 node_modules 里打包会丢 |
| ADR-0007 | 路由：L0 直通 → Hermes（复杂任务）→ 自研循环（降级） | 简单控制走 Hermes 不划算（启动开销）；Hermes 不可用时不能断对话 |
| ADR-0008 | 记忆只做显式键值对（`preferences`），不做隐式向量记忆 | 用户看不见的记忆出错时无法纠正；可查可改可删是硬约束 |

### 10.3 待定项

| 项 | 状态 | 影响 |
|---|---|---|
| HomeAssistant 接入时间 | 待定 | 只影响 M5，不影响 M0–M4 |
| Hermes 内核形态（自研 / 第三方） | 已定：第三方 Hermes（vendor + uv venv）为主，自研薄循环降级 | 见 ADR-0006 / ADR-0007 |
| 远程访问方式（内网穿透/自建中继） | 待定 | 影响 M6 交付形态 |
| 语音方案（HA Assist / 自研） | 后置 | 二期 |

### 10.4 推荐仓库结构

```
homeclaw/
├─ apps/
│  ├─ desktop/          Electron 主进程 + 渲染进程入口
│  ├─ web/              Vue3 应用（desktop 复用同一份）
│  ├─ gateway/          L2 Hermes 接入层 + 自研循环降级路径
│  ├─ homehub/          L3 Fastify 中枢服务
│  └─ mock-server/      M0 用假服务
├─ packages/
│  ├─ contracts/        协议与 DTO 类型 + JSON Schema（唯一真源）
│  └─ eval/             100 条指令评测集与回归脚本
├─ deploy/
│  ├─ hermes/           L2 容器配置、出网白名单（本期空）
│  └─ ha/               L4 HomeAssistant 部署（本期空）
└─ docs/
   ├─ ARCHITECTURE.md   本文
   └─ adr/              决策记录
```

### 10.5 商用合规提示

- HomeAssistant Core：Apache-2.0，可商用；
- zigbee2mqtt：GPL-3.0，随硬件分发需提供源码；
- HACS 第三方集成：许可不统一，出货前逐个核查；
- 生成式 AI 服务在中国大陆需完成大模型服务/算法备案，并明确数据留存与出境策略；
- 产品命名不得使用 "Home Assistant" 商标。
