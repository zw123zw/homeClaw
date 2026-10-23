const fs = require("fs");

// ChatPage：换成语义化 + 图标 + aria
let p = "apps/web/src/pages/ChatPage.vue";
let t = fs.readFileSync(p, "utf8");

t = t.replace(
`    <div ref="scroller" class="messages" @scroll="onScroll">
      <div v-if="!state.items.length" class="empty">
        试试说：「把客厅灯调到 30% 暖光」<br />
        <span style="font-size: 12px">Mock 服务会返回模拟的工具调用与流式回复</span>
      </div>`,
`    <div
      ref="scroller"
      class="messages"
      tabindex="-1"
      aria-live="polite"
      aria-relevant="additions text"
      @scroll="onScroll"
    >
      <div v-if="!state.items.length" class="empty">
        试试说：「把客厅灯调到 30% 暖光」<br />
        <span style="font-size: 12px">Mock 服务会返回模拟的工具调用与流式回复</span>
      </div>`
);

t = t.replace(
`      <textarea
        v-model="input"
        rows="1"
        placeholder="输入指令，Enter 发送 / Shift+Enter 换行"
        @keydown="onKeydown"
      />
      <button v-if="canStop" class="danger" @click="stop">停止</button>
      <button class="primary" :disabled="!input.trim()" @click="onSubmit">发送</button>
    </div>

    <div v-if="reconnecting" class="dim" style="padding: 0 24px 8px; font-size: 12px">
      连接中断，正在重连并按 last_seq 补齐…
    </div>
    <div v-else-if="connected" class="dim" style="padding: 0 24px 8px; font-size: 12px">
      SSE 已连接 · cursor {{ state.lastLogSeq }}
    </div>`,
`      <label class="sr-only" for="chat-input">输入指令</label>
      <textarea
        id="chat-input"
        v-model="input"
        rows="1"
        placeholder="输入指令，Enter 发送 / Shift+Enter 换行"
        @keydown="onKeydown"
      />
      <button v-if="canStop" class="danger" type="button" @click="stop">
        <AppIcon name="stop" />停止
      </button>
      <button class="primary" type="button" :disabled="!input.trim()" @click="onSubmit">
        <AppIcon name="send" />发送
      </button>
    </div>

    <div v-if="reconnecting" class="conn-note">
      <AppIcon name="alert" :size="14" />
      <span>连接中断，正在重连并按 last_seq 补齐…</span>
    </div>
    <div v-else-if="connected" class="conn-note">
      <AppIcon name="wifi" :size="14" />
      <span>实时连接正常 · 游标 {{ state.lastLogSeq }}</span>
    </div>`
);

t = t.replace('import MessageItem from "@/components/MessageItem.vue";',
'import AppIcon from "@/components/AppIcon.vue";\nimport MessageItem from "@/components/MessageItem.vue";');

fs.writeFileSync(p, t, "utf8");
console.log("ChatPage updated");

// MessageItem：错误提示加图标
p = "apps/web/src/components/MessageItem.vue";
t = fs.readFileSync(p, "utf8");
t = t.replace(
`    <div v-if="item.kind === 'assistant' && item.error" class="msg-error">⚠ {{ item.error }}</div>`,
`    <div v-if="item.kind === 'assistant' && item.error" class="msg-error">
      <AppIcon name="alert" :size="14" />
      <span>{{ item.error }}</span>
    </div>`
);
t = t.replace('import ToolCard from "./ToolCard.vue";',
'import AppIcon from "./AppIcon.vue";\nimport ToolCard from "./ToolCard.vue";');
fs.writeFileSync(p, t, "utf8");
console.log("MessageItem updated");
