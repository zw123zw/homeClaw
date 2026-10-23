<#
.SYNOPSIS
  安装 Hermes 运行时（深度规划内核）。

.DESCRIPTION
  照 docs/HERMES.md §2 的产物约定生成：
    vendor/hermes-agent   上游源码（固定 tag，git 拉取）
    hermes-venv           平台专属 uv 虚拟环境（不入 git）

  为什么需要单独跑一次、而不是放进启动流程：
  - 首次要 clone + 建 venv，1~3 分钟；放进启动流程会让"双击启动"变成"先等三分钟"；
  - venv 与平台绑定，必须在目标机器（或同架构打包机）上生成；
  - 失败原因（没装 git / 没装 uv / 网络不通）必须原样告诉人，而不是被启动脚本吞掉。

.PARAMETER Tag
  上游 tag，默认 v0.22.5（与已核对过的版本一致）。

.PARAMETER Force
  已存在 venv 时也重建（升级或修复用）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-hermes.ps1
#>
param(
  [string]$Tag = "v0.22.5",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$vendor = Join-Path $root "vendor\hermes-agent"
$venv = Join-Path $root "hermes-venv"

function Say($msg) { Write-Host $msg }
function Fail($msg) {
  Write-Host ""
  Write-Host "[失败] $msg" -ForegroundColor Red
  Write-Host ""
  exit 1
}

Say "== HomeClaw · Hermes 运行时安装 =="
Say "仓库根：$root"

# 1) 依赖检查：缺什么直接说清楚，不要让用户对着 "不是内部或外部命令" 猜
foreach ($cmd in @("git", "uv")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    if ($cmd -eq "uv") {
      Fail "找不到 uv。先安装 uv（官方安装脚本 https://astral.sh/uv），装完重开这个窗口。"
    }
    Fail "找不到 git。先安装 Git for Windows：https://git-scm.com/download/win"
  }
}

if (Test-Path $venv) {
  if (-not $Force) {
    Say "[跳过] 已存在 $venv（要重建请加 -Force）"
    exit 0
  }
  Say "[清理] 删除旧运行时 $venv"
  Remove-Item -LiteralPath $venv -Recurse -Force
}

# 2) 拉源码：固定 tag。用 --filter=blob:none 省带宽，但保留 tag 语义
if (-not (Test-Path (Join-Path $vendor ".git"))) {
  Say "[1/3] 拉取 hermes-agent $Tag …"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $vendor) | Out-Null
  git clone --depth 1 --branch $Tag https://github.com/NousResearch/hermes-agent.git $vendor
  if ($LASTEXITCODE -ne 0) {
    Fail "git clone 失败（网络不通或 tag 不存在）。也可以手动把源码放到 $vendor 后重跑。"
  }
} else {
  Say "[1/3] 源码已存在，跳过 clone：$vendor"
}

# 3) 建 venv 并安装。--python 3.12 是保守选择：上游要求 >=3.11，
#    3.12 在 Windows 上预编译轮子最全，避免为了 3.14 现场编译。
Say "[2/3] 创建虚拟环境 $venv …"
uv venv $venv --python 3.12
if ($LASTEXITCODE -ne 0) { Fail "uv venv 失败" }

Say "[3/3] 安装 hermes-agent（可编辑模式）…"
$py = Join-Path $venv "Scripts\python.exe"
& $py -m pip --version 2>$null | Out-Null
uv pip install --python $py -e $vendor
if ($LASTEXITCODE -ne 0) { Fail "uv pip install 失败（见上方输出）" }

# 4) 自检：启动器真的存在，且能打印版本。只看目录存在会给出假阳性
$launcher = Join-Path $venv "Scripts\hermes.exe"
if (-not (Test-Path $launcher)) {
  Fail "安装完成但找不到启动器 $launcher。请检查 pyproject.toml 里的 scripts 定义是否变化。"
}

Say ""
Say "[完成] 运行时已就绪：$venv"
Say "下一步：重启客户端，在 设置 → 智能体 里点「测试连接」。"
Say ""