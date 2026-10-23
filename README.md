# HomeClaw

全屋智能 AI 桌面系统。前端使用 Electron + Vue 3，后端分为 HomeHub（设备与策略层）和 Gateway（对话与智能体接入层），并可选接入 Hermes 做多步任务规划。

## 功能概览

- 对话式设备控制，SSE 流式输出，支持工具卡片与附件
- 设备面板、场景、自动化规则、审计日志
- HomeHub 统一持有设备凭据，提供 ToolHub、Policy、Audit、EventBus
- Gateway 三级路由：L0 确定性直通 → Hermes → 自研薄循环降级
- Hermes 可选：未安装时客户端照常运行，复杂任务自动回落到内置循环
- Windows 桌面打包，产物自带 Node 运行时

## 架构

```text
Electron Desktop (apps/desktop)
├── Vue 3 UI (apps/web)
├── Gateway :4030 (apps/gateway)
│   ├── L0 直通 / 自研薄循环
│   ├── 内置工具 + 本地 MCP :4031
│   └── Hermes 子进程（可选）
└── HomeHub :4020 (apps/homehub)
    ├── SQLite / Sessions / Attachments
    ├── ToolHub / Policy / Audit / EventBus
    └── MockAdapter（HaAdapter 预留）
```

更完整的接口契约、数据模型和里程碑见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，Hermes 接入细节见 [docs/HERMES.md](docs/HERMES.md)。

## 环境要求

- Node.js >= 20
- pnpm 10.33（`corepack enable` 后可直接使用）
- Windows 打包需要 PowerShell；开发时建议使用 Windows 10/11

## 快速开始

```powershell
pnpm install
pnpm dev
```

Windows 用户也可以双击根目录的 `启动HomeClaw.cmd`，脚本会检查依赖并拉起客户端与两个后端。

常用命令：

```powershell
pnpm dev:web        # 只启动 Web 界面
pnpm dev:mock       # 只启动 mock 服务
pnpm dev:desktop    # 启动 Electron 客户端
pnpm typecheck      # 全仓库类型检查
pnpm test           # 运行测试
pnpm package        # 构建并装配 Windows 桌面产物
```

默认端口：HomeHub `4020`、Gateway `4030`、内置工具 MCP `4031`。端口可通过 `HUB_PORT`、`GATEWAY_PORT`、`TOOL_MCP_PORT` 覆盖。

## Hermes（可选）

Hermes 用于多步任务规划与执行，不是启动必需项。安装运行时：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-hermes.ps1
```

安装后重启客户端，在「设置 → 智能体」中测试连接。未安装或连接失败时，简单与单轮任务继续走 Gateway 内置循环。

## 数据与产物

- 开发数据：`data/`（已忽略，不入库）
- 桌面端数据：默认 `%APPDATA%\HomeClaw`，不可写时回落到安装目录下的 `HomeClawData`
- 构建产物：`release/`、`dist-backend/`、各应用的 `dist/`（均已忽略）
- 模型 API Key 由 Gateway 持有，不下发客户端；请勿把 `.env` 或真实密钥提交到仓库

## 项目结构

```text
apps/
├── desktop/      Electron 主进程与预加载脚本
├── gateway/      对话接入、路由、工具、MCP、Hermes 桥接
├── homehub/      设备/策略/审计/会话/自动化后端
├── mock-server/  开发期 mock 服务
└── web/          Vue 3 界面
packages/
├── contracts/    跨层 TypeScript 契约
└── eval/         评测脚本
docs/            架构、Hermes 接入规范与 ADR
scripts/         环境初始化脚本
skills/          项目内智能体技能
tools/           构建、验收、预览与调试工具
```

## 当前状态

L1–L3 已落地：桌面客户端、Web 界面、Gateway、HomeHub、MockAdapter、附件、模型配置、自动化与审计。L4（Home Assistant）与 L5（物理设备）尚未实现。

已知限制与后续工作记录在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「实现现状」章节。

## 许可证

仓库暂未选择开源许可证。在添加 LICENSE 之前，默认保留所有权利。
