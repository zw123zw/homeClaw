# HomeClaw

全屋智能 AI 系统。本文件只定义术语，不含实现细节。

## Language

### 分层与进程

**HomeHub**：
唯一持有设备凭据、唯一执行策略鉴权的业务进程。
_Avoid_: 中枢服务、backend、middleware

**Hermes**：
本仓库引入的开源 L2 规划内核（`vendor/hermes-agent`，Python，以预构建 uv venv 随包分发）。
负责复杂任务的分步规划与执行，不持有设备凭据。Gateway 以子进程调用它，接缝是 CLI 输出契约 + MCP。
_Avoid_: OpenClaw、agent 框架、网关服务

**Gateway**：
L2 的接入层与实现（`apps/gateway`）：路由、自研薄循环（降级路径）、内置工具、MCP 客户端、模型适配、SSE 下发。
Hermes 不可用时由它独立完成一轮对话。
_Avoid_: 网关服务、Hermes server

**Harness**：
一轮对话里组装上下文、执行工具、收尾的组件。本仓库的实现是自研薄循环（`agent.ts`），Hermes 内部另有同名概念。
_Avoid_: agent、runner

**Adapter**：
在 L3→L4 接缝上满足 `DeviceAdapter` 接口的具体实现（MockAdapter / HaAdapter）。
_Avoid_: 驱动、connector、plugin

### 设备与状态

**Entity**：
一个可被独立控制的设备实体，以 `<domain>.<slug>` 唯一标识，如 `light.living_room_ceiling`。
_Avoid_: device、设备对象、节点

**Room**：
Entity 的归属空间，来自固定词典，不是自由文本。
_Avoid_: area、区域、空间

**Command**：
一次对 Entity 的服务调用意图，带幂等键与 trace_id。
_Avoid_: 指令、action、请求

**Event**：
设备状态的变化事实，带 origin 归因，用于驱动自动化。
_Avoid_: 通知、消息、update

**Origin**：
事件或命令的来源归因：`device` | `user` | `ai` | `rule`。`ai` 来源的事件不得再触发 AI。
_Avoid_: source、cause

### 自动化

**Trigger**：
一次通过去抖与频率校验后、被允许进入推理或规则执行的事件。
_Avoid_: fire、activation

**Loop Guard**：
依据 Origin 阻断 AI 自触发链条的机制。
_Avoid_: 防环器、recursion guard

**Budget**：
按日累计的 token 与费用上限，超限后降级为规则或不执行。
_Avoid_: quota、限额

### 会话与消息

**Session**：
一个持续的对话上下文，消息在其内按 `seq` 单调递增。
_Avoid_: 对话、thread、conversation

**Seq**：
Session 内消息的单调递增序号，是断线补齐的唯一依据。
_Avoid_: offset、index、cursor

**Log Seq**：
服务端事件日志的单调序号，客户端重连时以其为游标补齐缺口。
_Avoid_: seq（不可与 Session 内 Seq 混用）

**Envelope**：
L1↔L2 传输的统一消息外壳，带协议版本 `v`。
_Avoid_: frame、packet、message wrapper

### 安全

**Policy**：
HomeHub 内决定一次 Command 是否放行的规则集合（白名单、频率、预算、硬拒绝）。
_Avoid_: guard、permission、auth

**Hard Deny**：
命中即拒绝、不进入模型判断的实体或服务清单，作为确定性保险丝。
_Avoid_: blacklist、blocklist

**Audit Entry**：
一次 Command 的裁决与结果留痕，可按 trace_id 串联成完整请求。
_Avoid_: log、record、history

**Trace**：
贯穿一次用户请求或自动化触发的关联标识，用于把多条 Audit Entry 串起来。
_Avoid_: request id、correlation id