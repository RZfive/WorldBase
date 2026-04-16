<script setup lang="ts">
import { onMounted, ref, reactive, computed } from 'vue'

interface ModelPricingEntry {
  model: string
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
}

interface CostSettings {
  modelPricing: ModelPricingEntry[]
  budgetLimit: number | null
}

const FEEDBACK_DURATION_MS = 1800
const loading = ref(true)
const saving = ref(false)
const feedback = ref('')

const pricingEntries = ref<ModelPricingEntry[]>([])
const budgetLimit = ref<string>('')
const newModel = ref('')
const newInput = ref('')
const newOutput = ref('')
const newCacheRead = ref('')

async function loadSettings () {
  loading.value = true
  try {
    const api = window.electronAPI as Record<string, (...args: unknown[]) => Promise<unknown>> | undefined
    if (api?.getCostSettings) {
      const settings = await api.getCostSettings() as CostSettings
      pricingEntries.value = settings.modelPricing || []
      budgetLimit.value = settings.budgetLimit != null ? String(settings.budgetLimit) : ''
    }
  } catch { /* ignore */ } finally {
    loading.value = false
  }
}

async function saveSettings () {
  if (saving.value) return
  saving.value = true
  feedback.value = ''
  try {
    const api = window.electronAPI as Record<string, (...args: unknown[]) => Promise<unknown>> | undefined
    if (api?.saveCostSettings) {
      const settings: CostSettings = {
        modelPricing: pricingEntries.value,
        budgetLimit: budgetLimit.value.trim() ? parseFloat(budgetLimit.value) : null
      }
      await api.saveCostSettings(settings)
      feedback.value = '成本设置已保存'
    }
  } catch (err) {
    feedback.value = `保存失败：${(err as Error).message}`
  } finally {
    saving.value = false
    window.setTimeout(() => { feedback.value = '' }, FEEDBACK_DURATION_MS)
  }
}

function addPricingEntry () {
  const model = newModel.value.trim()
  if (!model) return
  const input = parseFloat(newInput.value) || 0
  const output = parseFloat(newOutput.value) || 0
  const cacheRead = parseFloat(newCacheRead.value) || 0

  // Update existing or add new
  const existingIndex = pricingEntries.value.findIndex(e => e.model === model)
  if (existingIndex >= 0) {
    pricingEntries.value[existingIndex] = { model, inputPerMillion: input, outputPerMillion: output, cacheReadPerMillion: cacheRead }
  } else {
    pricingEntries.value.push({ model, inputPerMillion: input, outputPerMillion: output, cacheReadPerMillion: cacheRead })
  }

  newModel.value = ''
  newInput.value = ''
  newOutput.value = ''
  newCacheRead.value = ''
  void saveSettings()
}

function removePricingEntry (index: number) {
  pricingEntries.value.splice(index, 1)
  void saveSettings()
}

function updateEntry (index: number, field: keyof ModelPricingEntry, value: string) {
  const entry = pricingEntries.value[index]
  if (!entry) return
  if (field === 'model') {
    entry.model = value
  } else {
    ;(entry as Record<string, unknown>)[field] = parseFloat(value) || 0
  }
}

function onBudgetChange () {
  void saveSettings()
}

onMounted(async () => {
  await loadSettings()
})
</script>

<template>
  <div class="cost-root">
    <div class="cost-header">
      <h3 class="cost-title">成本核算设置</h3>
      <p class="cost-desc">配置每个模型的 token 单价，用于追踪 AI 调用成本。</p>
      <span v-if="feedback" class="cost-feedback">{{ feedback }}</span>
    </div>

    <div class="cost-separator" />

    <div class="cost-section">
      <h4 class="cost-section-title">会话预算上限</h4>
      <p class="cost-section-hint">设置单次会话的最大花费（美元），超出后 Agent 将自动停止。留空表示不限制。</p>
      <div class="budget-row">
        <span class="budget-label">$</span>
        <input
          v-model="budgetLimit"
          type="number"
          step="0.01"
          min="0"
          placeholder="不限"
          class="cost-input budget-input"
          :disabled="loading"
          @change="onBudgetChange"
        >
      </div>
    </div>

    <div class="cost-separator" />

    <div class="cost-section">
      <h4 class="cost-section-title">模型定价表</h4>
      <p class="cost-section-hint">单价为每百万 token 的美元价格。默认已内置常用模型价格，可在此覆盖或添加。</p>

      <div v-if="!loading && pricingEntries.length > 0" class="pricing-table">
        <div class="pricing-header">
          <span class="col-model">模型</span>
          <span class="col-price">输入</span>
          <span class="col-price">输出</span>
          <span class="col-price">缓存读取</span>
          <span class="col-action"></span>
        </div>
        <div v-for="(entry, index) in pricingEntries" :key="entry.model" class="pricing-row">
          <input
            :value="entry.model"
            class="cost-input col-model"
            @change="updateEntry(index, 'model', ($event.target as HTMLInputElement).value); saveSettings()"
          >
          <input
            :value="entry.inputPerMillion"
            type="number"
            step="0.01"
            min="0"
            class="cost-input col-price"
            @change="updateEntry(index, 'inputPerMillion', ($event.target as HTMLInputElement).value); saveSettings()"
          >
          <input
            :value="entry.outputPerMillion"
            type="number"
            step="0.01"
            min="0"
            class="cost-input col-price"
            @change="updateEntry(index, 'outputPerMillion', ($event.target as HTMLInputElement).value); saveSettings()"
          >
          <input
            :value="entry.cacheReadPerMillion"
            type="number"
            step="0.01"
            min="0"
            class="cost-input col-price"
            @change="updateEntry(index, 'cacheReadPerMillion', ($event.target as HTMLInputElement).value); saveSettings()"
          >
          <button class="remove-btn" @click="removePricingEntry(index)" title="删除">✕</button>
        </div>
      </div>

      <div v-if="!loading && pricingEntries.length === 0" class="pricing-empty">
        暂无自定义定价，将使用内置默认价格。
      </div>

      <div class="pricing-add">
        <input v-model="newModel" placeholder="模型名称" class="cost-input col-model">
        <input v-model="newInput" type="number" step="0.01" min="0" placeholder="输入" class="cost-input col-price">
        <input v-model="newOutput" type="number" step="0.01" min="0" placeholder="输出" class="cost-input col-price">
        <input v-model="newCacheRead" type="number" step="0.01" min="0" placeholder="缓存" class="cost-input col-price">
        <button class="add-btn" @click="addPricingEntry" :disabled="!newModel.trim()">添加</button>
      </div>
    </div>

    <div class="cost-separator" />

    <div class="cost-note">
      <span class="cost-note-title">说明</span>
      <p>成本数据在每次 AI 请求后自动统计。内置定价支持 GPT-4o、Claude Sonnet/Opus、DeepSeek 等常见模型。自定义定价会覆盖同名模型的内置价格。</p>
    </div>
  </div>
</template>

<style scoped>
.cost-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px 28px;
  overflow-y: auto;
  color: var(--app-text);
}

.cost-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cost-title {
  margin: 0;
  font-size: 1.1em;
  color: var(--app-text-strong);
}

.cost-desc {
  margin: 0;
  font-size: 0.85em;
  color: var(--app-text-muted);
}

.cost-feedback {
  font-size: 0.8em;
  color: var(--app-accent);
  margin-top: 2px;
}

.cost-separator {
  height: 1px;
  background: var(--app-border);
  margin: 16px 0;
}

.cost-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cost-section-title {
  margin: 0;
  font-size: 0.95em;
  font-weight: 600;
  color: var(--app-text);
}

.cost-section-hint {
  margin: 0;
  font-size: 0.78em;
  color: var(--app-text-faint);
  line-height: 1.5;
}

.budget-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.budget-label {
  font-size: 0.9em;
  color: var(--app-text-muted);
  font-weight: 500;
}

.budget-input {
  max-width: 120px;
}

.cost-input {
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 6px;
  color: var(--app-text);
  padding: 6px 8px;
  font-size: 0.82em;
}

.cost-input:focus {
  outline: none;
  border-color: var(--app-accent);
}

.pricing-table {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.pricing-header {
  display: flex;
  gap: 8px;
  padding: 4px 8px;
  font-size: 0.75em;
  color: var(--app-text-faint);
  font-weight: 500;
}

.pricing-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.pricing-add {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}

.pricing-empty {
  font-size: 0.82em;
  color: var(--app-text-faint);
  padding: 12px 0;
}

.col-model {
  flex: 2;
  min-width: 0;
}

.col-price {
  flex: 1;
  min-width: 0;
  max-width: 90px;
}

.col-action {
  width: 32px;
  flex-shrink: 0;
}

.remove-btn {
  width: 28px;
  height: 28px;
  background: transparent;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  color: var(--app-text-faint);
  cursor: pointer;
  font-size: 0.75em;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s;
}

.remove-btn:hover {
  border-color: #ef4444;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.add-btn {
  padding: 6px 14px;
  background: var(--app-accent);
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 0.82em;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.12s;
}

.add-btn:hover {
  opacity: 0.85;
}

.add-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.cost-note {
  font-size: 0.82em;
  color: var(--app-text-muted);
  line-height: 1.5;
}

.cost-note-title {
  font-weight: 600;
  color: var(--app-text-soft);
  margin-bottom: 4px;
  display: block;
}

.cost-note p {
  margin: 0;
}
</style>
