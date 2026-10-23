import { createApp } from "vue";
import { createPinia } from "pinia";
import { VueQueryPlugin } from "@tanstack/vue-query";
import App from "./App.vue";
import { initTheme } from "./stores/theme";
import { installTDesign } from "./tdesign";
/**
 * TDesign 样式先于我们自己的 styles.css 引入：
 * 我们的主题层靠覆盖 --td-* 变量生效，顺序反了会被框架默认值压回去。
 *
 * 组件不做全量注册（app.use(TDesign) 会把全部组件打进包），
 * 各 SFC 里按需 import 具体组件，构建时才能 tree-shake。
 */
import "tdesign-vue-next/dist/tdesign.css";
import "./styles.css";

initTheme();

const app = createApp(App);
app.use(createPinia());
installTDesign(app);
app.use(VueQueryPlugin, {
  queryClientConfig: {
    defaultOptions: {
      queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false },
    },
  },
});
app.mount("#app");
