<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { api, type AutomationRule, type RulePatch, type RuleWhen } from "@/api/client";
import AppIcon from "./AppIcon.vue";


/**
 * 设置中心 · 自动化分区。
 *
 * 设计原则：把规则引擎真正认的字段摆出来，而不是让用户去写 JSON。
 * 每个字段都直接对应后端 RuleWhen / RuleThen 的一个键，改完立即 PATCH 落库；
 * 一次只发改动过的字段，避免"改冷却时间把条件一起覆盖掉"。
 */

const emit = defineEmits<{ toast: [text: string, err?: boolean] }>();
const qc = useQueryClient();

const rules = useQuery({ queryKey: ["automations"], queryFn: api.automations });

const openId = ref<string | null>(null);
const saving = ref<string | null>(null);

type Draft = {
  enabled: boolean;
  kind: NonNullable<RuleWhen["kind"]>;
  entity: string;
  to: "" | "true" | "false" | "number";
  toNumber: string;
  attribute: string;
  forSeconds: string;
  gt: string;
  lt: string;
  timeFrom: string;
  timeTo: string;
  cooldown: string;
  thenKind: "entity.command" | "scene.run" | "none";
  thenEntity: string;
  thenService: string;
  thenScene: string;
  thenBrightness: string;
};

/** 只保留"当前展开那条"的草稿：比给每条规则都存一份省事，也不会出现空引用 */
const draft = reactive<Draft>({
  enabled: true,
  kind: "state_changed",
  entity: "",
  to: "",
  toNumber: "",
  attribute: "",
  forSeconds: "",
  gt: "",
  lt: "",
  timeFrom: "",
  timeTo: "",
  cooldown: "0",
  thenKind: "none",
  thenEntity: "",
  thenService: "",
  thenScene: "",
  thenBrightness: "",
});

function loadDraft(r: AutomationRule) {
  const w = r.when ?? {};
  const t = Array.isArray(r.then) ? r.then[0] : undefined;

  draft.enabled = r.enabled;
  draft.kind = w.kind ?? "state_changed";
  draft.entity = w.entity ?? "";
  draft.attribute = w.attribute ?? "";
  draft.forSeconds = w.for_seconds === undefined ? "" : String(w.for_seconds);
  draft.gt = w.gt === undefined ? "" : String(w.gt);
  draft.lt = w.lt === undefined ? "" : String(w.lt);
  draft.timeFrom = w.time_between ? String(w.time_between[0]) : "";
  draft.timeTo = w.time_between ? String(w.time_between[1]) : "";
  draft.cooldown = String(r.cooldown_seconds ?? 0);

  // to 可能是布尔，也可能是数字（温度/亮度阈值），分两种输入形态处理
  if (w.to === true) { draft.to = "true"; draft.toNumber = ""; }
  else if (w.to === false) { draft.to = "false"; draft.toNumber = ""; }
  else if (typeof w.to === "number") { draft.to = "number"; draft.toNumber = String(w.to); }
  else { draft.to = ""; draft.toNumber = ""; }

  draft.thenKind = !t ? "none" : t.action === "scene.run" ? "scene.run" : "entity.command";
  draft.thenEntity = t && t.action === "entity.command" ? t.entity : "";
  draft.thenService = t && t.action === "entity.command" ? t.service : "";
  draft.thenScene = t && t.action === "scene.run" ? t.name : "";
  draft.thenBrightness =
    t && t.action === "entity.command" && t.data && t.data.brightness_pct !== undefined
      ? String(t.data.brightness_pct)
      : "";
}

watch(
  () => openId.value,
  (id) => {
    const r = (rules.data.value ?? []).find((x) => x.id === id);
    if (r) loadDraft(r);
  },
);

function toggleOpen(r: AutomationRule) {
  openId.value = openId.value === r.id ? null : r.id;
}

function buildThen(): AutomationRule["then"] {
  if (draft.thenKind === "none") return [];
  if (draft.thenKind === "scene.run") {
    return draft.thenScene.trim() ? [{ action: "scene.run", name: draft.thenScene.trim() }] : [];
  }
  const entity = draft.thenEntity.trim();
  const service = draft.thenService.trim();
  if (!entity || !service) return [];
  const data: Record<string, unknown> = {};
  if (draft.thenBrightness !== "") data.brightness_pct = Number(draft.thenBrightness);
  return [{ action: "entity.command", entity, service, ...(Object.keys(data).length ? { data } : {}) }];
}

function buildWhen(): RuleWhen {
  const when: RuleWhen = { kind: draft.kind };
  if (draft.entity.trim()) when.entity = draft.entity.trim();
  if (draft.to === "true") when.to = true;
  else if (draft.to === "false") when.to = false;
  else if (draft.to === "number" && draft.toNumber !== "") when.to = Number(draft.toNumber);
  if (draft.attribute.trim()) when.attribute = draft.attribute.trim();
  if (draft.forSeconds !== "") when.for_seconds = Math.max(0, Math.round(Number(draft.forSeconds)));
  if (draft.gt !== "") when.gt = Number(draft.gt);
  if (draft.lt !== "") when.lt = Number(draft.lt);
  if (draft.timeFrom !== "" && draft.timeTo !== "") {
    when.time_between = [Number(draft.timeFrom), Number(draft.timeTo)];
  }
  return when;
}

async function save(r: AutomationRule) {
  const patch: RulePatch = {};
  if (draft.enabled !== r.enabled) patch.enabled = draft.enabled;

  const cd = Number(draft.cooldown);
  if (Number.isFinite(cd) && cd !== r.cooldown_seconds) patch.cooldown_seconds = Math.max(0, Math.round(cd));

  const when = buildWhen();
  if (JSON.stringify(when) !== JSON.stringify(r.when)) patch.when = when;

  const then = buildThen();
  if (JSON.stringify(then) !== JSON.stringify(r.then)) patch.then = then;

  if (Object.keys(patch).length === 0) {
    emit("toast", "没有改动");
    return;
  }

  saving.value = r.id;
  try {
    await api.updateAutomation(r.id, patch);
    emit("toast", `已保存 ${Object.keys(patch).length} 个字段`);
    await qc.invalidateQueries({ queryKey: ["automations"] });
  } catch (err) {
    emit("toast", err instanceof Error ? err.message : "保存失败", true);
  } finally {
    saving.value = null;
  }
}

function reset(r: AutomationRule) {
  loadDraft(r);
  emit("toast", "已还原为服务端当前配置");
}

const KIND_LABEL: Record<string, string> = {
  state_changed: "状态变化",
  availability_changed: "在线状态变化",
  triggered: "外部触发",
};

const list = computed(() => rules.data.value ?? []);
const openRule = computed(() => list.value.find((r) => r.id === openId.value) ?? null);

/* 下拉选项常量：与后端枚举一一对应，放这里避免模板里散落字面量 */
const KIND_OPTIONS = [
  { value: "state_changed", label: "状态变化" },
  { value: "availability_changed", label: "在线状态变化" },
  { value: "triggered", label: "外部触发" },
];

const TO_OPTIONS = [
  { value: "", label: "不限制" },
  { value: "true", label: "开 / 在线" },
  { value: "false", label: "关 / 离线" },
  { value: "number", label: "数值" },
];

const THEN_OPTIONS = [
  { value: "entity.command", label: "控制设备" },
  { value: "scene.run", label: "执行场景" },
  { value: "none", label: "只记录，不动设备" },
];</script>

<template>
  <div class="auto-config">
    <div v-if="rules.isError.value" class="empty">规则加载失败</div>
    <div v-else-if="!rules.data.value" class="empty">加载中…</div>

    <div v-else class="rule-acc">
      <article v-for="r in list" :key="r.id" class="acc" :class="{ open: openId === r.id }">
        <button
          type="button"
          class="acc__head"
          :aria-expanded="openId === r.id"
          @click="toggleOpen(r)"
        >
          <span class="acc__dot" :class="{ on: r.enabled }" aria-hidden="true" />
          <span class="acc__name">{{ r.id }}</span>
          <span class="acc__meta">{{ KIND_LABEL[String(r.when.kind ?? "state_changed")] }} · 冷却 {{ r.cooldown_seconds }}s</span>
          <AppIcon name="chevron" :size="14" class="acc__chev" />
        </button>

        <div v-if="openId === r.id && openRule" class="acc__body">
          <div class="field-row">
            <label class="field">
              <span class="field__label">启用</span>
              <div class="field__switch">
                <t-switch v-model="draft.enabled" size="small" />
                <span class="dim">{{ draft.enabled ? "已启用" : "已停用" }}</span>
              </div>
            </label>
            <label class="field">
              <span class="field__label">冷却（秒）</span>
              <t-input v-model="draft.cooldown" type="number" :min="0" :max="86400" size="small" />
            </label>
          </div>

          <div class="acc__section">
            <div class="acc__section-title">触发条件</div>
            <div class="field-row">
              <label class="field">
                <span class="field__label">事件类型</span>
                <t-select
                  v-model="draft.kind"
                  :options="KIND_OPTIONS"
                  size="small"
                  style="width: 100%"
                />
              </label>
              <label class="field">
                <span class="field__label">目标实体</span>
                <t-input v-model="draft.entity" placeholder="light.living_room_ceiling 或 lock.*" size="small" />
              </label>
            </div>

            <div class="field-row">
              <label class="field">
                <span class="field__label">变为</span>
                <t-select v-model="draft.to" :options="TO_OPTIONS" size="small" style="width: 100%" />
              </label>
              <label v-if="draft.to === 'number'" class="field">
                <span class="field__label">目标值</span>
                <t-input v-model="draft.toNumber" type="number" size="small" placeholder="如 26" />
              </label>
              <label class="field">
                <span class="field__label">属性</span>
                <t-input v-model="draft.attribute" placeholder="state / brightness" size="small" />
              </label>
              <label class="field">
                <span class="field__label">持续（秒）</span>
                <t-input v-model="draft.forSeconds" type="number" :min="0" size="small" placeholder="不限" />
              </label>
            </div>

            <div class="field-row">
              <label class="field">
                <span class="field__label">大于</span>
                <t-input v-model="draft.gt" type="number" size="small" placeholder="不限" />
              </label>
              <label class="field">
                <span class="field__label">小于</span>
                <t-input v-model="draft.lt" type="number" size="small" placeholder="不限" />
              </label>
              <label class="field">
                <span class="field__label">生效时段（小时）</span>
                <span class="field__pair">
                  <t-input v-model="draft.timeFrom" type="number" :min="0" :max="23" size="small" placeholder="22" />
                  <span class="field__tilde">→</span>
                  <t-input v-model="draft.timeTo" type="number" :min="0" :max="23" size="small" placeholder="6" />
                </span>
              </label>
            </div>
          </div>

          <div class="acc__section">
            <div class="acc__section-title">执行动作</div>
            <div class="field-row">
              <label class="field">
                <span class="field__label">动作类型</span>
                <t-select v-model="draft.thenKind" :options="THEN_OPTIONS" size="small" style="width: 100%" />
              </label>
              <template v-if="draft.thenKind === 'entity.command'">
                <label class="field">
                  <span class="field__label">设备</span>
                  <t-input v-model="draft.thenEntity" placeholder="light.living_room_ceiling" size="small" />
                </label>
                <label class="field">
                  <span class="field__label">服务</span>
                  <t-input v-model="draft.thenService" placeholder="turn_on" size="small" />
                </label>
                <label class="field">
                  <span class="field__label">亮度 %</span>
                  <t-input v-model="draft.thenBrightness" type="number" :min="1" :max="100" size="small" placeholder="可选" />
                </label>
              </template>
              <label v-else-if="draft.thenKind === 'scene.run'" class="field field--wide">
                <span class="field__label">场景名</span>
                <t-input v-model="draft.thenScene" placeholder="回家模式" size="small" />
              </label>
            </div>
          </div>

          <div class="acc__foot">
            <button type="button" class="ghost" :disabled="saving === r.id" @click="reset(r)">还原</button>
            <button type="button" class="primary" :disabled="saving === r.id" @click="save(r)">
              {{ saving === r.id ? "保存中…" : "保存" }}
            </button>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>
