import { contextBridge, ipcRenderer } from "electron";

/**
 * 这里重复声明 RuntimeConfig 而不是从 apps/web 里 import：
 * 主进程是 CommonJS + tsconfig 独立，跨项目 import 会把 web 的 DOM/import.meta
 * 一起拉进来编译（那些是渲染进程的语法，主进程编译不了）。
 * 形状由 apps/web/src/platform/index.ts 定义，改那边要同步改这里 —— 字段只有三个。
 */
type RuntimeConfig = {
  gatewayBaseUrl: string;
  hubBaseUrl: string;
  hubToken?: string;
};

/**
 * 只暴露白名单能力，渲染进程拿不到 ipcRenderer 本体。
 *
 * 票据从主进程环境变量读（由安装包/部署脚本注入），**不写死在渲染代码里**，
 * 也不与 MCP 票据混用：这里只下发用户票据（面板权限）。
 */
// 配置从主进程取，而不是读 process.env：窗口开了 sandbox，预加载脚本里的 process 是精简替身，
// 端口这类东西读不稳；走一次同步 IPC 最简单也最可靠（发生在首帧之前，不会闪）。
const config: RuntimeConfig = ipcRenderer.sendSync("homeclaw:runtime-config") as RuntimeConfig;

contextBridge.exposeInMainWorld("__HOMECLAW__", config);
contextBridge.exposeInMainWorld("__HOMECLAW_PLATFORM__", {
  kind: "electron",
  saveText: (filename: string, content: string) => ipcRenderer.invoke("homeclaw:saveText", filename, content),
  openExternal: (url: string) => ipcRenderer.invoke("homeclaw:openExternal", url),
  openLogs: () => ipcRenderer.invoke("homeclaw:openLogs"),
  setWindowTheme: (theme: { background: string; symbol: string }) =>
    ipcRenderer.invoke("homeclaw:window-theme", theme),
});

