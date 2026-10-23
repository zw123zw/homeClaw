import { defineStore } from "pinia";
import { ref } from "vue";
import { platform } from "@/platform";

/**
 * 主题 = TDesign 的 theme-mode（dark/light）+ 我们自己的配色。
 *
 * 三套暗色 + 三套亮色，共六套；正文/次要/状态色都按 WCAG AA 校验（tools/contrast.mjs）。
 * 每套主题都在 :root[data-theme] 上定义自己的 --td-* 映射（见 styles.css），
 * TDesign 组件读这些变量，换肤时整套组件一起变。
 */
export type ThemeKey = "void" | "abyss" | "ember" | "dawn" | "jade" | "sakura";

export type ThemeOption = {
  key: ThemeKey;
  label: string;
  hint: string;
  mode: "dark" | "light";
  /** Electron 原生窗口控件覆盖层的颜色，必须跟随主题 */
  windowBg: string;
  windowSymbol: string;
};

export const THEMES: ThemeOption[] = [
  { key: "void", label: "深空", hint: "墨黑与薄荷 · 暗色", mode: "dark", windowBg: "#0A0F1A", windowSymbol: "#8B99B0" },
  { key: "abyss", label: "深海", hint: "靛蓝与冰青 · 暗色", mode: "dark", windowBg: "#08101C", windowSymbol: "#9BB0C9" },
  { key: "ember", label: "熔岩", hint: "暖炭与琥珀 · 暗色", mode: "dark", windowBg: "#120D0B", windowSymbol: "#C3AC9D" },
  { key: "dawn", label: "晨光", hint: "冷白与松绿 · 亮色", mode: "light", windowBg: "#F7FAFD", windowSymbol: "#4A5B72" },
  { key: "jade", label: "青瓷", hint: "瓷青与黛蓝 · 亮色", mode: "light", windowBg: "#F0F7F4", windowSymbol: "#466055" },
  { key: "sakura", label: "暖砂", hint: "纸暖与赭石 · 亮色", mode: "light", windowBg: "#F7F4EE", windowSymbol: "#6B6151" },
];

const STORAGE_KEY = "homeclaw.theme";

function readStored(): ThemeKey {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return THEMES.some((t) => t.key === saved) ? (saved as ThemeKey) : "void";
  } catch {
    return "void";
  }
}

/** 同时写 data-theme（我们的变量）和 theme-mode（TDesign 组件的暗亮基准） */
function apply(key: ThemeKey) {
  const t = THEMES.find((item) => item.key === key) ?? THEMES[0]!;
  const root = document.documentElement;
  root.dataset.theme = t.key;
  root.setAttribute("theme-mode", t.mode);
  root.style.colorScheme = t.mode;
}

function syncWindowChrome(key: ThemeKey) {
  const t = THEMES.find((item) => item.key === key) ?? THEMES[0]!;
  void platform().setWindowTheme({ background: t.windowBg, symbol: t.windowSymbol });
}

/** 在 createApp 之前调用，避免首帧闪出默认主题 */
export function initTheme() {
  const key = readStored();
  apply(key);
  syncWindowChrome(key);
}

export const useThemeStore = defineStore("theme", () => {
  const current = ref<ThemeKey>(readStored());

  function setTheme(key: ThemeKey) {
    current.value = key;
    apply(key);
    try {
      localStorage.setItem(STORAGE_KEY, key);
    } catch {
      /* 隐私模式写不进去也不影响本次显示 */
    }
    syncWindowChrome(key);
  }

  return { current, setTheme };
});
