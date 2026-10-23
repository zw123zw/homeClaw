const fs = require("fs");

// 1) App.vue：brand mark 用 SVG，会话高亮用 aria-current
let p = "apps/web/src/App.vue";
let t = fs.readFileSync(p, "utf8");

t = t.replace(
`      <div class="sidebar__head">
        <div class="brand">HomeClaw</div>
        <div class="dim" style="font-size: 11px; margin-top: 2px">全屋智能 AI 管家</div>
        <button class="primary" style="width: 100%; margin-top: 10px" @click="newSession">＋ 新会话</button>
      </div>`,
`      <div class="sidebar__head">
        <div class="brand">
          <span class="brand__mark"><AppIcon name="brand" :size="16" /></span>
          HomeClaw
        </div>
        <div class="brand__sub">全屋智能 AI 管家</div>
        <button class="primary" style="width: 100%" @click="newSession">
          <AppIcon name="plus" />新会话
        </button>
      </div>`
);

t = t.replace(
`        <div
          v-for="s in sessions.data.value ?? []"
          :key="s.id"
          class="session-item"
          :class="{ active: s.id === ui.currentSessionId }"
          @click="ui.setSession(s.id)"
        >
          <span>{{ s.title }}</span>
          <span class="dim mono">{{ s.message_count }}</span>
        </div>`,
`        <button
          v-for="s in sessions.data.value ?? []"
          :key="s.id"
          type="button"
          class="session-item"
          :aria-current="s.id === ui.currentSessionId ? 'true' : 'false'"
          @click="ui.setSession(s.id)"
        >
          <span class="session-item__title">{{ s.title }}</span>
          <span class="dim mono">{{ s.message_count }}</span>
        </button>`
);

t = t.replace(
`        <div
          v-for="(label, key) in tabLabels"
          :key="key"
          class="tab"
          :class="{ active: ui.activeTab === key }"
          @click="ui.activeTab = key"
        >
          {{ label }}
        </div>
        <div class="status">`,
`        <button
          v-for="(label, key) in tabLabels"
          :key="key"
          type="button"
          role="tab"
          class="tab"
          :aria-selected="ui.activeTab === key"
          @click="ui.activeTab = key"
        >
          <AppIcon :name="key" />{{ label }}
        </button>
        <div class="status" role="status" aria-live="polite" aria-atomic="true">`
);

t = t.replace('import ChatPage from "@/pages/ChatPage.vue";',
'import AppIcon from "@/components/AppIcon.vue";\nimport ChatPage from "@/pages/ChatPage.vue";');

t = t.replace(`          <span v-if="health.data.value">
            adapter {{ health.data.value.adapter.status }} · llm {{ health.data.value.llm.status }}
          </span>
          <span v-else>连接中…</span>`,
`          <span v-if="health.data.value">
            适配器 {{ health.data.value.adapter.status }} · 模型 {{ health.data.value.llm.status }}
          </span>
          <span v-else>连接中</span>`);

t = t.replace('<div class="tabs">', '<div class="tabs" role="tablist" aria-label="主导航">');

fs.writeFileSync(p, t, "utf8");
console.log("App.vue updated");
