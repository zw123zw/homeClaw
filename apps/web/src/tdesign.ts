/**
 * TDesign 组件的按需注册。
 *
 * 为什么不用 app.use(TDesign)：全量注册会把所有组件打进 bundle（约 +3MB），
 * 而我们只用到 6 个。这里显式列出用到的组件，tree-shake 才能生效。
 *
 * 新增组件时记得在这里补一行，否则模板里的 <t-xxx> 会被当成未知元素，
 * 表现为"渲染了但没有任何样式/交互"。
 */
import type { App } from "vue";
import { Button, Dialog, Input, Select, Switch, Tag } from "tdesign-vue-next";

const COMPONENTS = [Button, Dialog, Input, Select, Switch, Tag];

export function installTDesign(app: App) {
  for (const c of COMPONENTS) app.use(c);
}
