import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5310,
    strictPort: true,
    /**
     * 两条代理，对应两个后端（见 platform/index.ts 的注释）：
     *  /v1/**  → Gateway（:4030）  对话信封 + SSE 事件流
     *  /hub/** → HomeHub（:4020）  面板 / 场景 / 会话，重写时去掉 /hub 前缀
     *
     * SSE 必须关掉代理缓冲，否则"流式"会变成"攒满一屏再一次性吐"。
     */
    proxy: {
      "/v1": {
        target: process.env.VITE_GATEWAY ?? "http://127.0.0.1:4030",
        changeOrigin: true,
      },
      "/hub": {
        target: process.env.VITE_HUB ?? "http://127.0.0.1:4020",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/hub/, ""),
      },
    },
  },
  // 相对 base：Electron 用 file:// 加载 index.html，绝对路径 /assets/* 会 404 白屏
  base: "./",
  // 浏览器里没有 process：依赖产物中的 process.env.NODE_ENV 必须被静态替换，否则白屏
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { outDir: "dist", emptyOutDir: true },
});