/**
 * L1 硬规则（§3.1）：UI 层禁止 import electron，全部经此适配层。
 * 将来迁移 Tauri 只改本目录。
 */
export interface Platform {
  readonly kind: "web" | "electron";
  readonly version: string;
  saveText(filename: string, content: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  /** 打开日志目录：Electron 有自己的目录；网页端无法做到，降级为提示 */
  openLogs(): Promise<boolean>;
  /** 同步原生窗口控件颜色；网页端为空操作 */
  setWindowTheme(theme: { background: string; symbol: string }): Promise<void>;
  runtimeConfig(): Promise<RuntimeConfig>;
}

export interface RuntimeConfig {
  /** 网关地址：客户端只认「网关地址 + 消息信封」（C5） */
  gatewayBaseUrl: string;
  /** HomeHub 地址：仅面板与场景使用（§5.2） */
  hubBaseUrl: string;
  /**
   * 用户票据（§5.2 / §7.1）：只够看面板与场景，不能触发工具。
   * 由构建期注入（VITE_HUB_TOKEN）或 Electron 启动参数注入，
   * 绝不出现在 UI 代码里，也绝不与 MCP 票据混用。
   */
  hubToken?: string;
}

/**
 * web 开发期：同源相对路径，交给 Vite proxy 分流（见 vite.config.ts）。
 *
 * 为什么要分两个前缀：
 *  - 对话与事件流属 L2 Gateway（:4030），只认信封协议；
 *  - 面板/场景/会话属 L3 HomeHub（:4020），是资源式 REST。
 * 两者接口形状完全不同，共用一个前缀会让代理规则变成"按路径猜后端"，
 * 一旦某个接口名字两边都用得上（比如 /v1/health）就会静默串台。
 */
const WEB_DEFAULT: RuntimeConfig = {
  gatewayBaseUrl: "",
  hubBaseUrl: "/hub/v1",
  hubToken: import.meta.env.VITE_HUB_TOKEN,
};

type InjectedPlatform = {
  kind: "electron";
  saveText(filename: string, content: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  openLogs?(): Promise<boolean>;
  setWindowTheme?(theme: { background: string; symbol: string }): Promise<void>;
};

function injected(): {
  config?: Partial<RuntimeConfig>;
  platform?: InjectedPlatform;
} {
  const w = window as unknown as {
    __HOMECLAW__?: Partial<RuntimeConfig>;
    __HOMECLAW_PLATFORM__?: InjectedPlatform;
  };
  return { config: w.__HOMECLAW__, platform: w.__HOMECLAW_PLATFORM__ };
}

export function platform(): Platform {
  const { config, platform: inj } = injected();

  if (inj?.kind === "electron") {
    return {
      kind: "electron",
      version: import.meta.env.VITE_APP_VERSION ?? "0.1.0",
      saveText: (filename, content) => inj.saveText(filename, content),
      openLogs: () => inj.openLogs?.() ?? Promise.resolve(false),
      async setWindowTheme(theme) {
        await inj.setWindowTheme?.(theme);
      },
      async openExternal(url) {
        if (!/^https?:\/\//i.test(url)) throw new Error("仅允许 http/https 外链");
        await inj.openExternal(url);
      },
      async runtimeConfig() {
        // Electron 里没有 Vite proxy，必须给绝对地址；
        // 端口与 apps/*/src/config.ts 的默认值保持一致，改一处要同时改两处。
        return {
          gatewayBaseUrl: config?.gatewayBaseUrl ?? "http://127.0.0.1:4030",
          hubBaseUrl: config?.hubBaseUrl ?? "http://127.0.0.1:4020/v1",
          ...(config ?? {}),
        };
      },
    };
  }

  return {
    kind: "web",
    version: import.meta.env.VITE_APP_VERSION ?? "0.1.0",
    async saveText(filename, content) {
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    },
    async openExternal(url) {
      if (!/^https?:\/\//i.test(url)) throw new Error("仅允许 http/https 外链");
      window.open(url, "_blank", "noopener,noreferrer");
    },
    async openLogs() {
      // 浏览器里没有本机目录可开：返回 false，让调用方给出可读提示
      return false;
    },
    async setWindowTheme() {
      // 网页端没有原生窗口控件
    },
    async runtimeConfig() {
      /**
       * 先取服务端下发的运行时配置（票据不进构建产物，见 tools/serve-web.mjs）。
       * 取不到就退回默认值 —— 面板能看、对话能发，比白屏强。
       */
      let fromServer: Partial<RuntimeConfig> = {};
      try {
        const res = await fetch("/runtime-config.json", { headers: { accept: "application/json" } });
        if (res.ok) fromServer = (await res.json()) as Partial<RuntimeConfig>;
      } catch {
        // 静态托管没有该端点时静默降级：本地开发直接用 VITE_HUB_TOKEN
      }
      return { ...WEB_DEFAULT, ...fromServer, ...(config ?? {}) };
    },
  };
}
