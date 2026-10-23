<script setup lang="ts">
/**
 * 设置 · 智能体（Hermes 内核）。
 *
 * 这一页只回答三个问题，其余一律收进"高级"折叠：
 *  1. 深度规划能不能用（状态 + 一键测试）；
 *  2. 它能读写哪些目录（工作目录）；
 *  3. 它接了哪些外部工具（MCP）与技能（Skill）。
 *
 * 为什么不把 venv 路径、启动参数、协议摆在外面：
 * 这些只有"自己编译运行时"的人才会改，摆在外面会让普通用户以为必须填。
 * 填错其中一个，表现是"设置显示已就绪，但一对话就报错"，排查成本极高。
 */
import { computed, reactive, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api, type HermesSettings, type HermesStatus, type McpServer } from "@/api/client";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{ active: boolean }>();
const emit = defineEmits<{ toast: [text: string, err?: boolean] }>();

const settings = reactive<HermesSettings>({
  enabled: true,
  runtimeDir: "",
  launcher: "",
  args: ["run", "{prompt}"],
  protocol: "ndjson",
  timeoutMs: 180_000,
  workspaceRoot: "data/workspace",
  allowShell: false,
  mcpServers: [],
});

const status = ref<HermesStatus | null>(null);
const argsText = ref("");
const advanced = ref(false);
const saving = ref(false);
const testing = ref(false);
const testResult = ref<{ ok: boolean; text: string } | null>(null);

/** 新增 MCP 服务器时的临时表单 */
const draft = reactive({ name: "", url: "", token: "" });

const statusQuery = useQuery({
  queryKey: ["hermes-status"],
  queryFn: api.hermesStatus,
  // 只在打开这一页时轮询：设置面板关着的时候没必要每 10 秒打一次网关
  enabled: computed(() => props.active),
  refetchInterval: 8_000,
});

const toolsQuery = useQuery({
  queryKey: ["builtin-tools"],
  queryFn: api.builtinTools,
  enabled: computed(() => props.active),
  staleTime: 60_000,
});

const skillsQuery = useQuery({
  queryKey: ["skills"],
  queryFn: api.skills,
  enabled: computed(() => props.active),
  staleTime: 60_000,
});

const ready = computed(() => status.value?.status === "ready");
const statusText = computed(() => {
  if (!status.value) return "读取中…";
  if (!status.value.enabled) return "已关闭";
  return ready.value ? "就绪" : "未就绪";
});

/** 状态实时刷新：查询结果同步到本地 ref，避免模板里到处 .data.value */
watch(
  () => statusQuery.data.value,
  (s) => {
    if (s) status.value = s;
  },
  { immediate: true },
);

/** 首次打开时把服务端配置灌进表单（只灌一次，避免轮询把用户正在编辑的内容冲掉） */
const loaded = ref(false);
watch(
  () => props.active,
  async (on) => {
    if (!on || loaded.value) return;
    try {
      const res = await api.hermesSettings();
      Object.assign(settings, {
        enabled: res.enabled,
        runtimeDir: res.runtimeDir,
        launcher: res.launcher,
        args: res.args,
        protocol: res.protocol,
        timeoutMs: res.timeoutMs,
        workspaceRoot: res.workspaceRoot,
        allowShell: res.allowShell,
        mcpServers: res.mcpServers,
      });
      argsText.value = res.args.join(" ");
      status.value = res.status;
      loaded.value = true;
    } catch (err) {
      emit("toast", err instanceof Error ? err.message : "内核设置读取失败", true);
    }
  },
  { immediate: true },
);

async function save(patch: Partial<HermesSettings> = {}, quiet = false) {
  saving.value = true;
  try {
    const res = await api.updateHermesSettings(patch);
    status.value = res.status;
    Object.assign(settings, {
      enabled: res.enabled,
      runtimeDir: res.runtimeDir,
      launcher: res.launcher,
      args: res.args,
      protocol: res.protocol,
      timeoutMs: res.timeoutMs,
      workspaceRoot: res.workspaceRoot,
      allowShell: res.allowShell,
      mcpServers: res.mcpServers,
    });
    argsText.value = res.args.join(" ");
    if (!quiet) emit("toast", "已保存");
  } catch (err) {
    emit("toast", err instanceof Error ? err.message : "保存失败", true);
  } finally {
    saving.value = false;
  }
}

function toggleEnabled(value: boolean) {
  void save({ enabled: value });
}

function saveWorkspace() {
  void save({ workspaceRoot: settings.workspaceRoot.trim() || "data/workspace" });
}

function saveAdvanced() {
  // 参数模板用空格分隔；空白项直接丢掉，否则会上游多传一个空字符串参数
  const args = argsText.value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  void save({
    runtimeDir: settings.runtimeDir.trim(),
    launcher: settings.launcher.trim(),
    args: args.length ? args : ["run", "{prompt}"],
    protocol: settings.protocol,
    timeoutMs: Number(settings.timeoutMs) || 180_000,
    allowShell: settings.allowShell,
  });
}

async function test() {
  testing.value = true;
  testResult.value = null;
  try {
    const res = await api.testHermes();
    testResult.value = {
      ok: res.ok,
      text: res.ok ? `${res.message}（${res.elapsed_ms} ms）` : res.message,
    };
    void statusQuery.refetch();
  } catch (err) {
    testResult.value = { ok: false, text: err instanceof Error ? err.message : "测试失败" };
  } finally {
    testing.value = false;
  }
}

/* ---- MCP 服务器 ---- */

function addServer() {
  const name = draft.name.trim();
  const url = draft.url.trim();
  if (!name || !/^https?:\/\//i.test(url)) {
    emit("toast", "需要名称与 http(s) 地址", true);
    return;
  }
  if (settings.mcpServers.some((s) => s.name === name)) {
    emit("toast", "同名服务器已存在", true);
    return;
  }
  const next: McpServer[] = [
    ...settings.mcpServers,
    { name, url, ...(draft.token.trim() ? { token: draft.token.trim() } : {}), enabled: true },
  ];
  draft.name = "";
  draft.url = "";
  draft.token = "";
  void save({ mcpServers: next });
}

function toggleServer(server: McpServer, on: boolean) {
  const next = settings.mcpServers.map((s) => (s.name === server.name ? { ...s, enabled: on } : s));
  void save({ mcpServers: next }, true);
}

function removeServer(server: McpServer) {
  // 内置项不可删：它们由启动流程注入，删了下次启动又会出现，只会让人困惑
  if (server.builtin) return;
  void save({ mcpServers: settings.mcpServers.filter((s) => s.name !== server.name) });
}

const skills = computed(() => skillsQuery.data.value?.skills ?? []);
const builtinTools = computed(() => toolsQuery.data.value?.tools ?? []);

/* ---- 记忆（用户偏好）：显式键值对，可加可删 ---- */

const memoryQuery = useQuery({
  queryKey: ["preferences"],
  queryFn: api.preferences,
  enabled: computed(() => props.active),
  staleTime: 10_000,
});

const memDraft = reactive({ key: "", value: "" });

async function addMemory() {
  const key = memDraft.key.trim();
  const value = memDraft.value.trim();
  if (!key || !value) {
    emit("toast", "需要键和值", true);
    return;
  }
  try {
    await api.setPreference(key, value);
    memDraft.key = "";
    memDraft.value = "";
    void memoryQuery.refetch();
    emit("toast", "已记住");
  } catch (err) {
    emit("toast", err instanceof Error ? err.message : "保存失败", true);
  }
}

async function removeMemory(key: string) {
  try {
    await api.removePreference(key);
    void memoryQuery.refetch();
  } catch (err) {
    emit("toast", err instanceof Error ? err.message : "删除失败", true);
  }
}

const memory = computed(() => memoryQuery.data.value ?? []);
</script>

<template>
  <div class="agent-settings">
    <header class="group__head">
      <h3 class="group__title">智能体</h3>
      <p class="group__desc">
        复杂任务（整理资料、批量改名、多步操作）交给本地规划内核逐步执行；简单指令仍走规则直通，不启动它。
      </p>
    </header>

    <!-- 状态行：一眼看到"能不能用"，旁边就是测试按钮 -->
    <div class="agent-status" :class="{ ok: ready, off: !settings.enabled }">
      <span class="agent-status__dot" aria-hidden="true" />
      <span class="agent-status__main">
        <span class="agent-status__label">
          深度规划
          <span class="tag" :class="ready ? 'tag--ok' : 'tag--warn'">{{ statusText }}</span>
        </span>
        <span class="agent-status__detail">{{ status?.detail ?? "读取中…" }}</span>
      </span>
      <button type="button" class="chip" :disabled="testing || !settings.enabled" @click="test">
        <AppIcon :name="testing ? 'refresh' : 'wifi'" :size="13" />
        <span>{{ testing ? "测试中…" : "测试连接" }}</span>
      </button>
      <t-switch
        :value="settings.enabled"
        size="small"
        aria-label="启用深度规划"
        @change="(v: unknown) => toggleEnabled(v === true)"
      />
    </div>

    <p v-if="testResult" class="model-test" :class="{ err: !testResult.ok }">
      <AppIcon :name="testResult.ok ? 'check' : 'alert'" :size="13" />
      <span>{{ testResult.text }}</span>
    </p>

    <p v-if="!ready && settings.enabled" class="agent-hint">
      未安装运行时不会影响其他功能：对话会自动回落到内置推理循环。
      安装方式见 <span class="mono">scripts/setup-hermes.ps1</span>。
    </p>

    <!-- 工作目录：文件类工具的唯一活动范围 -->
    <div class="agent-block">
      <div class="agent-block__head">
        <span class="agent-block__title">工作目录</span>
        <span class="agent-block__hint">文件读取、改名、归档只能在这里进行</span>
      </div>
      <div class="agent-row">
        <t-input
          v-model="settings.workspaceRoot"
          size="small"
          placeholder="data/workspace"
          aria-label="工作目录"
          @blur="saveWorkspace"
        />
        <span class="mono dim agent-row__path">{{ status?.workspace ?? "" }}</span>
      </div>
      <p class="agent-block__foot">
        内置工具：<span class="mono">{{ builtinTools.map((t) => t.name).join(" · ") || "读取中…" }}</span>
      </p>
    </div>

    <!-- MCP：外部工具接入 -->
    <div class="agent-block">
      <div class="agent-block__head">
        <span class="agent-block__title">工具连接（MCP）</span>
        <span class="agent-block__hint">内置 HomeHub 与本地工具，可再加任意远端 MCP</span>
      </div>

      <div class="mcp-list">
        <div v-for="s in settings.mcpServers" :key="s.name" class="mcp-row">
          <span class="mcp-row__dot" :class="{ on: s.enabled }" aria-hidden="true" />
          <span class="mcp-row__main">
            <span class="mcp-row__name">
              {{ s.name }}
              <span v-if="s.builtin" class="tag">内置</span>
            </span>
            <span class="mcp-row__url mono">{{ s.url }}</span>
          </span>
          <t-switch
            :value="s.enabled"
            size="small"
            :aria-label="`启用 ${s.name}`"
            @change="(v: unknown) => toggleServer(s, v === true)"
          />
          <button
            v-if="!s.builtin"
            type="button"
            class="icon-btn danger"
            :aria-label="`删除 ${s.name}`"
            @click="removeServer(s)"
          >
            <AppIcon name="trash" :size="13" />
          </button>
        </div>
        <p v-if="!settings.mcpServers.length" class="mcp-empty">还没有连接任何工具服务</p>
      </div>

      <div class="mcp-add">
        <t-input v-model="draft.name" size="small" placeholder="名称，如 notion" aria-label="MCP 名称" style="width: 130px" />
        <t-input v-model="draft.url" size="small" placeholder="https://…/mcp" aria-label="MCP 地址" />
        <t-input
          v-model="draft.token"
          size="small"
          type="password"
          placeholder="Token（可选）"
          aria-label="MCP 令牌"
          style="width: 130px"
        />
        <button type="button" class="chip" @click="addServer">
          <AppIcon name="plus" :size="13" />
          <span>添加</span>
        </button>
      </div>
    </div>

    <!-- 技能：来自 HERMES_HOME/skills，只读展示 -->
    <div class="agent-block">
      <div class="agent-block__head">
        <span class="agent-block__title">技能</span>
        <span class="agent-block__hint">放一个含 SKILL.md 的目录即可被识别</span>
      </div>
      <ul v-if="skills.length" class="skill-list">
        <li v-for="k in skills" :key="k.name" class="skill-item">
          <span class="skill-item__name">{{ k.name }}</span>
          <span class="skill-item__desc">{{ k.description }}</span>
        </li>
      </ul>
      <p v-else class="mcp-empty">
        还没有技能。把技能目录放到 <span class="mono">{{ status?.home ?? "data/hermes" }}/skills</span> 下即可。
      </p>
    </div>

    <!-- 记忆：用户可见、可改、可删的偏好，AI 只读 -->
    <div class="agent-block">
      <div class="agent-block__head">
        <span class="agent-block__title">记忆</span>
        <span class="agent-block__hint">AI 每次对话都会读到这里的偏好，你随时可以改或删</span>
      </div>

      <div class="mem-list">
        <div v-for="m in memory" :key="m.key" class="mem-row">
          <span class="mem-row__k">{{ m.key }}</span>
          <span class="mem-row__v">{{ m.value }}</span>
          <button type="button" class="icon-btn danger" :aria-label="`删除 ${m.key}`" @click="removeMemory(m.key)">
            <AppIcon name="trash" :size="13" />
          </button>
        </div>
        <p v-if="!memory.length" class="mcp-empty">还没有记住任何偏好。比如"称呼：叫我小王"、"常用房间：书房"。</p>
      </div>

      <div class="mem-add">
        <t-input v-model="memDraft.key" size="small" placeholder="如 称呼" aria-label="偏好名称" style="width: 120px" />
        <t-input v-model="memDraft.value" size="small" placeholder="如 叫我小王" aria-label="偏好内容" @enter="addMemory" />
        <button type="button" class="chip" @click="addMemory">
          <AppIcon name="plus" :size="13" />
          <span>记住</span>
        </button>
      </div>
    </div>

    <!-- 高级：只有自己编译运行时的人才需要 -->
    <div class="agent-block">
      <button type="button" class="agent-block__head agent-block__toggle" @click="advanced = !advanced">
        <span class="agent-block__title">高级</span>
        <span class="agent-block__hint">运行时路径、启动参数、超时</span>
        <AppIcon class="agent-block__chev" :name="advanced ? 'chevron' : 'chevron'" :size="13" />
      </button>

      <div v-if="advanced" class="agent-adv">
        <label class="field">
          <span class="field__label">运行时目录（留空自动探测）</span>
          <t-input v-model="settings.runtimeDir" size="small" placeholder="留空即自动查找 hermes-venv" />
        </label>
        <label class="field">
          <span class="field__label">启动器（留空用 venv 里的 hermes）</span>
          <t-input v-model="settings.launcher" size="small" placeholder="留空 = 自动" />
        </label>
        <label class="field">
          <span class="field__label">启动参数（{prompt} 会被替换成输入；不写则走 stdin）</span>
          <t-input v-model="argsText" size="small" placeholder="run {prompt}" />
        </label>
        <div class="field-row">
          <label class="field">
            <span class="field__label">输出协议</span>
            <t-select
              v-model="settings.protocol"
              :options="[
                { value: 'ndjson', label: 'NDJSON 事件流' },
                { value: 'text', label: '纯文本' },
              ]"
              size="small"
              style="width: 100%"
            />
          </label>
          <label class="field">
            <span class="field__label">单次超时（毫秒）</span>
            <t-input v-model.number="settings.timeoutMs" type="number" :min="10000" size="small" />
          </label>
        </div>
        <div class="agent-adv__foot">
          <span class="agent-hint agent-hint--inline">
            沙箱：{{ settings.allowShell ? "允许执行脚本" : "只允许文件读写" }}
          </span>
          <button type="button" class="primary" :disabled="saving" @click="saveAdvanced">
            {{ saving ? "保存中…" : "保存高级设置" }}
          </button>
        </div>
      </div>
    </div>

    <p v-if="status?.last_error" class="model-test err">
      <AppIcon name="alert" :size="13" />
      <span>上次启动失败：{{ status.last_error }}</span>
    </p>
  </div>
</template>