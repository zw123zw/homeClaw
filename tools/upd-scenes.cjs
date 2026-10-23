const fs = require("fs");

// ScenesPage：图标 + 语义化
const p = "apps/web/src/pages/ScenesPage.vue";
let t = fs.readFileSync(p, "utf8");
t = t.replace('import { api } from "@/api/client";', 'import { api } from "@/api/client";\nimport AppIcon from "@/components/AppIcon.vue";');
t = t.replace(
  '<div v-for="s in scenes.data.value ?? []" :key="s.id" class="scene">\n        <div class="scene__name">{{ s.name }}</div>\n        <div class="dim" style="font-size: 12px">{{ s.actions.length }} 个动作</div>\n        <button class="primary" :disabled="running === s.id" @click="run(s)">',
  '<article v-for="s in scenes.data.value ?? []" :key="s.id" class="scene">\n        <div class="scene__name"><AppIcon name="scenes" />{{ s.name }}</div>\n        <div class="scene__meta">{{ s.actions.length }} 个动作</div>\n        <button class="primary" type="button" :disabled="running === s.id" @click="run(s)">'
);
t = t.replace(
  "{{ running === s.id ? \"执行中…\" : \"一键执行\" }}\n        </button>\n      </div>",
  "{{ running === s.id ? \"执行中…\" : \"一键执行\" }}\n        </button>\n      </article>"
);
fs.writeFileSync(p, t, "utf8");
console.log("ScenesPage updated");

// 删除旧样式残留：.msg.user .bubble 用 secondary，检查是否还有旧 token 名
const css = fs.readFileSync("apps/web/src/styles.css", "utf8");
const oldTokens = ["--bg:", "--text:", "--accent:", "--border:", "--card:"].filter((tk) => css.includes(tk));
console.log("legacy tokens left:", oldTokens.length ? oldTokens.join(", ") : "none");
