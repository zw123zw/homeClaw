@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   HomeClaw Desktop 启动中...
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node。请先安装 Node.js 20+ 并重开这个窗口。
  goto :end
)

if not exist "apps\desktop\node_modules\electron\dist\electron.exe" (
  echo [错误] Electron 未安装。
  echo        请在本目录执行：pnpm install
  goto :end
)

if not exist "apps\web\dist\index.html" (
  echo [提示] 界面产物缺失，正在构建...
  call pnpm --filter @homeclaw/web build
  if errorlevel 1 (
    echo [错误] 构建失败，见上方输出。
    goto :end
  )
)

node tools\start-desktop.mjs
if errorlevel 1 goto :end

echo.
echo 客户端已退出。
goto :end

:end
echo.
echo 按任意键关闭此窗口...
pause >nul