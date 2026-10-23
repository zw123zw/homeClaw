# 启动与预览

## 一、看界面（最快，30 秒）

沙箱环境无法启动 Vite / Electron（禁止创建子进程），所以提供了一个**免构建预览页**：

```powershell
# 1. 启动 mock 服务（必须，界面要连它）
node --experimental-strip-types apps/mock-server/src/server.ts

# 2. 浏览器打开（在本机上还要允许 file 页面访问 localhost）
E:\note\homeClaw\tools\preview\standalone.html
```

包含对话页 / 设备面板 / 场景页三页，连的是真实 mock 服务，流式是真的 SSE。

> 若浏览器拦截 file:// 访问 127.0.0.1，用这个代替：
> `npx serve tools/preview` 然后访问 `http://localhost:3000`

## 二、正式开发（你自己的机器）

沙箱限制解除后：

```powershell
pnpm install

# 后端
pnpm dev:mock        # mock 服务 :4010

# 前端（三个页面，真实 Vue3 + Vite）
pnpm dev:web         # vite :5310，已配代理到 4010

# 桌面端（需要 Electron 二进制）
pnpm --filter @homeclaw/desktop dev
```

## 三、验收脚本

```powershell
node tools/acceptance-m0.mjs      # M0 后端：28 项（需 mock 服务运行）
node tools/reducer.test.mjs       # 流式 reducer：8 项（纯函数，无需服务）
cd tools; node ui-check.mjs       # 界面逻辑：27 项（需 mock 服务运行）
```

`ui-check.mjs` 用 jsdom 真实执行预览页脚本并连真实服务，覆盖首屏、流式合并、
工具卡片两态、切页、设备控制回流、场景执行。

## 四、已知限制

| 项 | 状态 |
|---|---|
| Electron 界面 | 代码完成，**未实际运行**（沙箱禁子进程 + Electron 二进制未下载） |
| Vite dev server | 配置完成，**未实际运行**（esbuild 需 spawn） |
| 视觉外观 | 未经真人视觉确认，仅验证了结构与样式类完整性 |
| HomeHub (M1+) | 未开始 |
