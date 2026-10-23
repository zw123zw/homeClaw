<script setup lang="ts">
/**
 * 设置 · 模型（对齐 cc-switch 的配置形态）。
 *
 * 字段只有四个：名称、Base URL、API Key、模型 ID。
 * 不放温度 / maxTokens / 视觉开关：
 *  - 这些是"模型能力细节"，用户填不出来，填错反而更糟；
 *  - 图片是否可用由网关自动探测并降级（见 apps/gateway/src/llm.ts）。
 *
 * 没有任何预置条目：列表为空就是空，先加一个才能用。
 * 表单控件全部用 TDesign（t-input / t-select / t-button），
 * 校验逻辑留在本地，只在真正点保存时给出提示。
 */
import { computed, reactive, ref, watch } from "vue";
import { api, type ModelInput, type ModelProfile, type WireApi, type ReasoningEffort } from "@/api/client";
import { useModelStore } from "@/stores/models";
import AppIcon from "./AppIcon.vue";

const emit = defineEmits<{ toast: [text: string, err?: boolean] }>();
const models = useModelStore();



type Draft = {
  id: string | null;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  wireApi: WireApi;
  reasoningEffort: ReasoningEffort | "";
  contextWindow: string;
};

const blank = (): Draft => ({
  id: null, name: "", baseUrl: "", model: "", apiKey: "",
  wireApi: "chat_completions", reasoningEffort: "", contextWindow: "",
});

/** 上游协议：决定网关用哪种线格式发请求 */
const WIRE_OPTIONS: { value: WireApi; label: string }[] = [
  { value: "chat_completions", label: "Chat Completions（OpenAI 兼容）" },
  { value: "responses", label: "Responses（OpenAI 新版 / Codex）" },
  { value: "anthropic", label: "Anthropic Messages（Claude 原生）" },
];

/** 只用来预填地址、模型 ID 与协议，不创建任何条目；key 必须用户自己填 */
const PRESETS: { key: string; label: string; baseUrl: string; model: string; wireApi: WireApi }[] = [
  { key: "custom", label: "自定义", baseUrl: "", model: "", wireApi: "chat_completions" },
  { key: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", wireApi: "chat_completions" },
  { key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", wireApi: "chat_completions" },
  { key: "openai-responses", label: "OpenAI（Responses）", baseUrl: "https://api.openai.com/v1", model: "gpt-5-codex", wireApi: "responses" },
  { key: "anthropic", label: "Claude（Anthropic）", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5", wireApi: "anthropic" },
  { key: "moonshot", label: "Moonshot", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", wireApi: "chat_completions" },
  { key: "dashscope", label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", wireApi: "chat_completions" },
  { key: "mimo", label: "MiMo", baseUrl: "https://api.mimo.example/v1", model: "mimo-v2.6-pro", wireApi: "responses" },
  { key: "ollama", label: "Ollama（本机）", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.1", wireApi: "chat_completions" },
];

const EFFORT_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
];

const draft = reactive<Draft>(blank());
const editing = ref(false);
const saving = ref(false);
const testing = ref<string | null>(null);
const testResult = ref<{ id: string; ok: boolean; text: string } | null>(null);
const preset = ref("custom");

const list = computed(() => models.list);
const activeId = computed(() => models.activeId);
const presetOptions = computed(() => PRESETS.map((p) => ({ value: p.key, label: p.label })));

watch(
  () => models.loaded,
  (loaded) => {
    if (!loaded) void models.refresh();
  },
  { immediate: true },
);

function onPresetChange(value: unknown) {
  const key = typeof value === "string" ? value : "custom";
  preset.value = key;
  const p = PRESETS.find((x) => x.key === key);
  if (!p || key === "custom") return;
  draft.baseUrl = p.baseUrl;
  draft.model = p.model;
  draft.wireApi = p.wireApi;
  if (!draft.name) draft.name = p.label;
}

function startCreate() {
  Object.assign(draft, blank());
  preset.value = "custom";
  testResult.value = null;
  editing.value = true;
}

function startEdit(m: ModelProfile) {
  Object.assign(draft, {
    id: m.id,
    name: m.name,
    baseUrl: m.baseUrl,
    model: m.model,
    apiKey: "",
    wireApi: m.wireApi ?? "chat_completions",
    reasoningEffort: m.reasoningEffort ?? "",
    contextWindow: m.contextWindow ? String(m.contextWindow) : "",
  });
  preset.value = "custom";
  testResult.value = null;
  editing.value = true;
}

function cancel() {
  editing.value = false;
  testResult.value = null;
}

async function save() {
  if (!draft.name.trim()) return emit("toast", "请填写名称", true);
  if (!draft.baseUrl.trim()) return emit("toast", "请填写 Base URL", true);
  if (!/^https?:\/\//i.test(draft.baseUrl.trim())) return emit("toast", "Base URL 必须是 http/https", true);
  if (!draft.model.trim()) return emit("toast", "请填写模型 ID", true);
  if (!draft.id && !draft.apiKey.trim()) return emit("toast", "新建模型需要 API Key", true);

  saving.value = true;
  try {
    const payload: ModelInput = {
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      wireApi: draft.wireApi,
      ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
      ...(draft.contextWindow.trim() && Number(draft.contextWindow) > 0
        ? { contextWindow: Math.round(Number(draft.contextWindow)) }
        : {}),
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    };
    if (draft.id) await api.updateModel(draft.id, payload);
    else await api.createModel(payload);
    await models.refresh();
    editing.value = false;
    emit("toast", draft.id ? "模型已更新" : "模型已添加");
  } catch (err) {
    emit("toast", err instanceof Error ? err.message : "保存失败", true);
  } finally {
    saving.value = false;
  }
}

async function remove(m: ModelProfile) {
  try {
    await api.deleteModel(m.id);
    await models.refresh();
    emit("toast", `已删除 ${m.name}`);
  } catch (err) {
    emit("toast", err instanceof Error ? err.message : "删除失败", true);
  }
}

async function activate(id: string) {
  try {
    await models.activate(id);
    emit("toast", "已切换当前模型");
  } catch (err) {
    emit("toast", err instanceof Error ? err.message : "切换失败", true);
  }
}

async function test(m: ModelProfile) {
  testing.value = m.id;
  testResult.value = null;
  try {
    const res = await api.testModel(m.id);
    testResult.value = { id: m.id, ok: res.ok, text: res.ok ? `连接正常（${res.latency_ms}ms）` : res.message || "连接失败" };
  } catch (err) {
    testResult.value = { id: m.id, ok: false, text: err instanceof Error ? err.message : "测试失败" };
  } finally {
    testing.value = null;
  }
}
</script>

<template>
  <div class="model-config">
    <header class="group__head">
      <h3 class="group__title">模型</h3>
      <p class="group__desc">
        填一个 OpenAI 兼容接口即可。密钥只存在本机网关进程里，接口不回传明文；
        没有可用模型时对话自动使用离线规则引擎。
      </p>
    </header>

    <div v-if="list.length" class="model-list">
      <div v-for="m in list" :key="m.id" class="model-row" :class="{ active: m.id === activeId }">
        <span class="model-row__dot" :class="{ on: m.id === activeId }" aria-hidden="true" />
        <span class="model-row__main">
          <span class="model-row__label">
            {{ m.name }}
            <span v-if="!m.has_key" class="tag tag--warn">缺密钥</span>
          </span>
          <span class="model-row__sub mono">{{ m.model }} · {{ m.baseUrl }}</span>
        </span>

        <span class="model-row__acts">
          <button v-if="m.id !== activeId" type="button" class="chip" @click="activate(m.id)">设为当前</button>
          <span v-else class="model-row__cur">当前</span>

          <button type="button" class="icon-btn" :aria-label="`测试 ${m.name}`" :disabled="testing === m.id" @click="test(m)">
            <AppIcon :name="testing === m.id ? 'refresh' : 'wifi'" :size="14" />
          </button>
          <button type="button" class="icon-btn" :aria-label="`编辑 ${m.name}`" @click="startEdit(m)">
            <AppIcon name="settings" :size="14" />
          </button>
          <button type="button" class="icon-btn danger" :aria-label="`删除 ${m.name}`" @click="remove(m)">
            <AppIcon name="trash" :size="14" />
          </button>
        </span>
      </div>
    </div>

    <div v-else class="model-empty">
      <span class="model-empty__icon"><AppIcon name="cpu" :size="22" /></span>
      <p class="model-empty__title">还没有配置模型</p>
      <p class="model-empty__hint">没有模型时对话会使用离线规则引擎，只能执行设备控制类指令。</p>
    </div>

    <p v-if="testResult" class="model-test" :class="{ err: !testResult.ok }">
      <AppIcon :name="testResult.ok ? 'check' : 'alert'" :size="13" />
      <span>{{ testResult.text }}</span>
    </p>

    <button v-if="!editing" type="button" class="add-model" @click="startCreate">
      <AppIcon name="plus" :size="15" />
      <span>添加模型</span>
    </button>

    <form v-else class="model-form" @submit.prevent="save">
      <div class="model-form__title">{{ draft.id ? "编辑模型" : "添加模型" }}</div>

      <label class="field">
        <span class="field__label">名称</span>
        <t-input v-model="draft.name" placeholder="例如 DeepSeek" :maxlength="80" size="small" />
      </label>

      <label class="field">
        <span class="field__label">Base URL</span>
        <t-input v-model="draft.baseUrl" placeholder="https://api.deepseek.com/v1" size="small" />
      </label>

      <label class="field">
        <span class="field__label">API Key{{ draft.id ? "（留空表示不修改）" : "" }}</span>
        <t-input v-model="draft.apiKey" type="password" :autocomplete="'off'" placeholder="sk-..." size="small" />
      </label>

      <label class="field">
        <span class="field__label">模型 ID</span>
        <t-input v-model="draft.model" placeholder="deepseek-chat" size="small" />
      </label>

      <div class="field">
        <span class="field__label">API 格式</span>
        <t-select
          v-model="draft.wireApi"
          :options="WIRE_OPTIONS"
          size="small"
          style="width: 100%"
        />
      </div>

      <div class="field-row">
        <label class="field">
          <span class="field__label">推理强度（可选）</span>
          <t-select
            v-model="draft.reasoningEffort"
            :options="[{ value: '', label: '不设置' }, ...EFFORT_OPTIONS]"
            size="small"
            style="width: 100%"
          />
        </label>
        <label class="field">
          <span class="field__label">上下文窗口（可选，token）</span>
          <t-input v-model="draft.contextWindow" type="number" :min="0" size="small" placeholder="如 1000000" />
        </label>
      </div>

      <div v-if="!draft.id" class="field">
        <span class="field__label">从预设填充（可选）</span>
        <t-select
          :value="preset"
          :options="presetOptions"
          size="small"
          style="width: 100%"
          @change="onPresetChange"
        />
      </div>

      <div class="model-form__foot">
        <button type="button" @click="cancel">取消</button>
        <button type="submit" class="primary" :disabled="saving">{{ saving ? "保存中…" : "保存" }}</button>
      </div>
    </form>
  </div>
</template>
