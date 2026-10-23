# 0006 L2 引入 Hermes 开源内核：vendor 源码 + 预构建 uv venv

用户要求"L2 直接用开源 Hermes，不要自研薄循环冒充"。此前 ADR-0005 记录本期以自研薄循环落地，
本次正式切换：L2 的执行主体是 NousResearch/hermes-agent（MIT），Gateway 只做接入。

**部署形态**：`vendor/hermes-agent` 以 git submodule 固定 tag；`hermes-venv` 由 `scripts/setup-hermes.ps1`
用 uv 预构建，**不进 git**，平台绑定，打包时走 `extraResources`。Gateway 以子进程 spawn 启动器，
通过 stdio 交互，输出按行解析成现有 `RunEvent`。

**为什么不用 npm 桥 `hermes-agent`**：实测 0.22.5 的 `files: []`、`types: null`，没有任何可 import 的 API；
其 postinstall 会 clone 上游、下载 uv、建 Python 3.14 venv，运行时目录在 `node_modules` 内，
electron-builder 打包会丢失，npm 重装会替换 venv。桌面应用需要确定、可打包、可离线启动的运行时。

**保留自研循环**：作为降级路径。Hermes 未就绪时对话不中断，且 L0 直通仍在自研侧（<100ms）。

约束不变：不改 Hermes 源码、不 import 内部模块、不假定 ACP（C3、ADR-03）。

**Status**: accepted
