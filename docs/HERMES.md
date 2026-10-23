# Hermes 接入规范（L2 内核）

| 项 | 内容 |
|---|---|
| 版本 | v1.1 |
| 日期 | 2026-10-23 |
| 状态 | 生效；L2 由 Hermes 承担任务规划与执行（内置工具 / Skill / MCP / 记忆已实现） |
| 关联 | `docs/ARCHITECTURE.md` §3.2、ADR-0006、ADR-0007 |

---

## 0. 一句话

L2 不再自己写推理循环：**把 NousResearch/hermes-agent 以「源码 vendor + 预构建 uv venv」的方式随包分发**，
由 Gateway（`apps/gateway`）以**子进程**方式调用它的 CLI，把它的输出翻译成现有 `RunEvent`，
再走原有 SSE 通道下发给客户端。自研薄循环保留为**降级路径**，Hermes 不可用时自动回落。

不改 Hermes 源码、不 import 它的内部模块、不假定 ACP（沿用 C3 约束与 ADR-03）。

---

## 1. 为什么不用 npm 桥

调研过 `hermes-agent`（npm，0.22.5，非官方 bridge）：

- 它不是 JS 库，`files: []`、`types: null`，**没有任何可 import 的 API**；
- 它的 postinstall 会 `git clone` 上游固定 tag、下载 `uv`、建 Python 3.14 venv，首次 1–2 分钟；
- 它的运行时目录在 `node_modules` 里，**electron-builder 打包会丢**，且 npm 重装会替换 venv。

结论：npm 桥适合「命令行用户」，不适合「随客户端分发的桌面应用」。
桌面应用要的是**确定的、可打包的、可离线启动**的运行时，所以改用 vendor + 预构建 venv。

---

## 2. 目录与产物

```
homeclaw/
├─ vendor/hermes-agent/        # git submodule，上游源码（固定 tag）
├─ hermes-venv/                # 【产物】uv 虚拟环境，平台绑定，不进 git
├─ scripts/setup-hermes.ps1    # 生成/修复 venv（开发机与打包机各跑一次）
└─ apps/gateway/src/hermes/    # 接入层：探测 / 启动 / 解析 / MCP 注入
```

- `vendor/hermes-agent` 固定 tag，升级 = 改 submodule 指针 + 重建 venv；
- `hermes-venv` **不跨平台复用**：Windows / macOS / Linux 各自生成、各自打包；
- 打包时 `hermes-venv` 走 `extraResources`，解包后位于 `resources/hermes-venv`。

---

## 3. 运行时解析顺序

`resolveRuntime()` 依次探测，命中即用：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 0 | 设置里的 `launcher` | 自定义启动器（任意可执行文件或 `.js/.mjs` shim），文件不存在即 `not_ready` |
| 1 | `HERMES_VENV` 环境变量 | 显式指定，打包后由 Electron 主进程注入 |
| 2 | 设置里的 `runtimeDir` | 用户在设置中心手填 |
| 3 | `<repo>/hermes-venv` | 开发机默认（`scripts/setup-hermes.ps1` 生成） |
| 4 | `<repo>/vendor/hermes-agent/.venv` | 上游本地安装习惯 |

启动器：Windows 为 `<venv>/Scripts/hermes.exe`，其余为 `<venv>/bin/hermes`。
探测结果只有两种：`ready` / `not_ready`，**没有"假装就绪"**。

两道额外开关：

- 设置里 `enabled=false` → 直接 `not_ready`（"我已装好但暂时不想用"是合法状态，不该报错）；
- 探不到时 `detail` 必须写清"缺什么、怎么装"，这句话会原样出现在设置页和 `/v1/health`。

---

## 4. 调用契约

Gateway 以子进程调用启动器，输入输出契约由设置里的 `protocol` 决定：

| protocol | 约定 |
|---|---|
| `ndjson`（默认） | stdout 每行一个 JSON 事件，见 §4.1 |
| `text` | stdout 是纯文本，整体按句子切片成 `delta` |

参数模板 `args` 支持占位符 `{prompt}`；**不含占位符时 prompt 走 stdin**。
这样上游 CLI 参数怎么变，只改设置、不改代码。

启动器是 `.js/.mjs/.cjs` 时按脚本处理（用当前 node 执行），其余一律当原生可执行文件；
后者是给测试与自定义部署用的逃生口，生产只会是 venv 里的 `hermes.exe`。

### 4.1 事件映射

| 上游行 | Gateway `RunEvent` |
|---|---|
| `{"type":"delta","text":"..."}` | `delta` |
| `{"type":"tool.start","id":"..","tool":"..","args":{}}` | `tool.start` |
| `{"type":"tool.result","id":"..","ok":true,"elapsed_ms":12}` | `tool.result` |
| `{"type":"error","code":"..","message":".."}` | `error` |
| 进程退出且无 `done` | 补 `done`（有输出）或 `error`（非 0 退出） |

映射后统一走 `toEnvelope()` → `SessionStream` → SSE，**客户端零改动**。
---

## 5. 路由策略（ADR-0007）

一次 `user.message` 进来，Gateway 按顺序判定：

```
1. L0 确定性直通命中  → 直接调工具，不进模型（<100ms，0 成本）
2. Hermes 就绪 且 任务判定为"复杂" → Hermes 路径
3. 其他  → 自研薄循环（agent.ts）
```

"复杂"的判定（`route.ts`，纯规则，可被设置覆盖）：

- 命中多步/规划词：`帮我`、`整理`、`汇总`、`批量`、`然后`、`之后`、`分几步`、`计划`
- 长度 > 60 字且含 ≥2 个动作动词
- 带附件（PDF/Excel/Word 等需要解析的文件）
- 用户显式选择"深度思考/规划"开关

简单单句控制（"开灯"、"空调 26 度"）永远走 L0/自研循环——Hermes 启动开销不值得。

---

## 6. 内置工具集（Gateway 侧，两条路径共用）

不依赖 Hermes 也能用的确定性工具，注册在 Gateway，经**本地 MCP 端口**同时暴露给两条执行路径。
共用一张表是刻意的：两套实现必然漂移，而"同一句话在两条路径下结果不同"是最难解释的 bug。

| 工具 | 能力 | 沙箱 |
|---|---|---|
| `file_list` | 列目录（跳过隐藏项与 node_modules） | 限 `workspaceRoot` |
| `file_read` | 读文本；二进制拒绝 | 限 `workspaceRoot` |
| `file_write` | 写文本（默认不覆盖） | 限 `workspaceRoot` |
| `file_rename` | 正则批量改名（**默认 dry-run**） | 限 `workspaceRoot` |
| `file_move` | 归档到子目录 | 限 `workspaceRoot` |
| `doc_read` | PDF / Word / Excel / PPT / 文本提取正文 | 限 `workspaceRoot` |
| `web_fetch` | 抓网页转纯文本 | 拒绝本机/内网地址 |
| `file_summarize` | 批量摘要（需模型） | 限 `workspaceRoot` |
| `file_translate` | 批量翻译（需模型） | 限 `workspaceRoot` |

三条硬约束：

1. **路径越界一律拒绝**：解析成绝对路径后校验前缀，再对已存在部分做 `realpath`（防符号链接越狱）；
2. **批量改名默认 dry-run**：正则写错一次能毁掉一批文件名，必须先看预演结果；
3. **`web_fetch` 拒绝 `127.0.0.1` / 内网网段**：否则模型一句「fetch http://127.0.0.1:4020/v1/...」就能绕过票据打内部接口。

**分发形态**：Gateway 起一个只监听回环的 MCP 服务 `127.0.0.1:4031/mcp`（`TOOL_MCP_PORT` 可覆盖），
票据每进程随机生成、不落盘，条目名固定为 `homeclaw-tools`。

| 调用方 | 怎么用 |
|---|---|
| Hermes | 写进 `HERMES_HOME/config.yaml` 的 `mcp.servers`，子进程经 MCP 调用 |
| 自研循环 | 进程内直调（`LocalToolMcp`），少一跳 |
| 其他 MCP 工具 | `MultiMcp`：本地名命中走本地，其余转发 HomeHub ToolHub |

为什么不让 Hermes 直接 import 这些函数：那要改上游源码（C3 禁止），
而且进程内共享状态会把沙箱边界和取消语义一起搞乱。

---

## 7. Skill

一期**直接复用 Hermes 原生 skill 机制**（它自己会从经验里生成和改进 skill），
Gateway 只做两件事：

- `GET /v1/skills`：列出 `HERMES_HOME/skills` 下的 skill 目录（名称 + 描述）；
- 在系统提示里附上"可用 skill 清单"，让模型自己决定调用。

不在 Gateway 重造 skill 引擎——那是重复劳动，且必然与上游行为漂移。

---

## 8. MCP 多服务器

设置里维护 `mcpServers[]`：

```jsonc
{ "name": "homehub", "url": "http://127.0.0.1:4020/mcp", "enabled": true, "builtin": true }
```

- 默认内置两条：`homehub`（ToolHub）与 `homeclaw-tools`（本地内置工具），**不可删、只能禁用**；
- 用户可加 Notion / 邮箱 / Jira 等远端 MCP；
- Hermes 路径：把服务器列表写进 `HERMES_HOME/config.yaml` 的 `mcp.servers`；
- 自研路径：`McpClient` 逐服务器建连，工具名前缀 `服务器名__工具名` 避免冲突。

**票据只在服务端**：`GET /v1/hermes/settings` 返回的是 `has_token: true/false`（打码），
客户端拿到的列表必然没有 token。所以 `PUT` 保存时按 `name` 把旧 token 补回来 ——
否则"只是改了个开关"也会把票据清空，表现是下一轮工具全部 401。

---

## 9. 记忆

| 类型 | 载体 | 归属 |
|---|---|---|
| 会话历史 | HomeHub `sessions` / `messages` | L3 |
| 用户偏好 | HomeHub `preferences` | L3，可查可改可删 |
| 任务中间态 | Hermes 自己的 session | L2，随 run 结束清理 |

注入方式：

- 自研循环：偏好拼进系统提示（`runAgent` 的 `preferences` 参数）；
- Hermes：`withInstructions()` 把「用户偏好 + 可用技能清单」拼进 prompt 前缀。

客户端入口：设置 → 智能体 → 记忆（`GET /v1/memory` 读、`PUT/DELETE /v1/preferences/:key` 改）。
HomeHub 不可用时 `preferences()` 返回空对象而不是抛错——偏好是加分项，不该让整轮对话失败。

**不引入不可见的向量记忆**。用户看不到的记忆，出错时无法纠正。

---

## 10. 失败与降级

| 场景 | 行为 |
|---|---|
| venv 未就绪 | 直接走自研循环，前端提示"深度规划未启用" |
| spawn 直接失败（EPERM/权限策略） | 捕获后**静默**回落自研循环（可降级路径不该留错误痕迹） |
| 启动/运行超时（默认 180s，可配） | kill 子进程树，回落自研循环 |
| 一个 delta 都没产出就失败 | 静默回落：界面只看到自研循环的答复，不出现"报错 + 答案"并存 |
| 已产出部分 delta 后失败 | **不再回落**（两段答案拼接会自相矛盾），补一句"未跑完，可以让我接着做"并收尾 |
| 用户取消 | kill 子进程树，补 `done` 帧，与自研路径一致 |
| 输出不是合法 JSON 行 | 该行按纯文本当 delta，不中断 |
| 工具调用 id 跨会话重名 | 已由 HomeHub 迁移 v4 修正（唯一索引改为按会话） |

"静默回落"的实现是 `run({suppressError:true})`：runner 只回结果、不发 `error` 事件。
降级成功时界面上不应留下任何错误痕迹——否则用户会以为"出错了但又好像成了"。

---

## 11. 接口清单（接入层相关）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/v1/hermes/status` | 运行时状态、venv、启动器、工作目录、MCP 列表、技能、最近错误 |
| GET | `/v1/hermes/settings` | 同上 + 可编辑设置（token 打码） |
| PUT | `/v1/hermes/settings` | 改开关 / 工作目录 / 启动器 / MCP 列表（缺 token 按 name 补回） |
| POST | `/v1/hermes/test` | 真跑一次极短提示，验证启动器能起来 |
| GET | `/v1/skills` | 技能清单 |
| GET | `/v1/tools` | 内置工具清单 |
| GET | `/v1/memory` | 记忆（偏好）只读视图 |

`/v1/health` 里额外的两个字段，给设置页的状态行用：

```jsonc
"hermes": { "status": "ok | degraded | disabled", "detail": "...", "source": "env|settings|repo|vendor|launcher|none" },
"tools":  { "status": "ok", "detail": "9 个内置工具" }
```

---

## 12. 验收

已通过（`apps/gateway/test`，46 项）：

- [x] Hermes 未安装时 `/v1/health` 的 `hermes.status = degraded`，详情给出安装提示
- [x] 复杂指令路由到 Hermes，SSE 依次收到 `tool.start` / `tool.result` / `assistant.delta`
- [x] 简单指令与 L0 命中仍走本地路径，延迟 < 200ms
- [x] Hermes 失败且无产出时静默回落，对话不报错
- [x] 末行没有换行符也不丢；一个 chunk 多行逐条解析；退出无 `done` 自动补
- [x] 内置工具沙箱拦截 `../` 逃逸与绝对路径越界
- [x] 本地 MCP 端口无票据返回 401
- [x] 偏好注入两条路径，且可在设置页增删
- [x] 端到端脚本 `apps/gateway/tools/e2e-hermes.mjs`：注入假子进程，工具卡与落库条数正确

待真机验证（需安装 Python 运行时）：

- [ ] 真 `hermes.exe` 的 ndjson 输出与 §4.1 映射一致
- [ ] 取消能杀掉子进程树（任务管理器无残留）

本机环境（已知）：无 Python / uv，无 `vendor/hermes-agent`，GitHub 不通；
因此"真机跑通"这一步留到有 Python 的机器上补，其余全部按注入方式验证过。
