<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ModelPricing } from '../../../main/ai-engine/cost-tracker'
import { resolveDefaultModelPricing } from '../../../main/ai-engine/cost-tracker'

interface ModelPricingEntry {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
}

interface AIProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
  modelContextWindows?: Record<string, number>
  modelPricing?: Record<string, ModelPricingEntry>
  activeModel: string
  enableThinking?: boolean
}

interface AIProvidersConfig {
  providers: AIProvider[]
  activeProviderId: string
  enabledProviderIds: string[]
}

interface CostSettings {
  modelPricing: Array<{ model: string } & ModelPricingEntry>
  budgetLimit: number | null
}

type PricingField = keyof ModelPricingEntry

const DEFAULT_CONTEXT_WINDOW = 32000
const FEEDBACK_DISPLAY_DURATION_MS = 2200

const providers = ref<AIProvider[]>([])
const defaultProviderId = ref('')
const enabledProviderIds = ref<string[]>([])
const budgetLimit = ref('')
const saving = ref(false)
const statusMsg = ref('')
const showKey = ref<Record<string, boolean>>({})
const newModelInput = ref('')
const searchQuery = ref('')
const selectedProviderId = ref('')
const editing = ref(false)
const editDraft = ref<AIProvider | null>(null)

const filteredProviders = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return providers.value

  return providers.value.filter(provider => {
    return provider.name.toLowerCase().includes(query)
      || provider.baseUrl.toLowerCase().includes(query)
      || provider.models.some(model => model.toLowerCase().includes(query))
  })
})

const selectedProvider = computed(() => {
  return providers.value.find(provider => provider.id === selectedProviderId.value) ?? null
})

const editingProviderLabel = computed(() => {
  if (!editDraft.value) return '添加供应商'
  return providers.value.some(provider => provider.id === editDraft.value!.id) ? '编辑供应商' : '添加供应商'
})

onMounted(async () => {
  await loadSettings()
})

function clonePricing (pricing?: Partial<ModelPricing> | Partial<ModelPricingEntry>): ModelPricingEntry {
  return {
    inputPerMillion: Number.isFinite(Number(pricing?.inputPerMillion)) ? Number(pricing?.inputPerMillion) : 0,
    outputPerMillion: Number.isFinite(Number(pricing?.outputPerMillion)) ? Number(pricing?.outputPerMillion) : 0,
    cacheReadPerMillion: Number.isFinite(Number(pricing?.cacheReadPerMillion)) ? Number(pricing?.cacheReadPerMillion) : 0
  }
}

function getDefaultPricing (model: string): ModelPricingEntry {
  return clonePricing(resolveDefaultModelPricing(model))
}

function buildPricingMap (settings: CostSettings): Record<string, ModelPricingEntry> {
  return settings.modelPricing.reduce<Record<string, ModelPricingEntry>>((acc, entry) => {
    if (!entry.model) return acc
    acc[entry.model] = clonePricing(entry)
    return acc
  }, {})
}

function hydrateProvider (provider: AIProvider, pricingMap: Record<string, ModelPricingEntry>): AIProvider {
  const modelPricing: Record<string, ModelPricingEntry> = {}
  for (const model of provider.models) {
    modelPricing[model] = clonePricing(pricingMap[model] || provider.modelPricing?.[model] || getDefaultPricing(model))
  }

  return {
    ...provider,
    models: [...provider.models],
    modelContextWindows: { ...(provider.modelContextWindows || {}) },
    modelPricing
  }
}

async function loadSettings () {
  if (!window.electronAPI?.getProviders || !window.electronAPI?.getCostSettings) return

  try {
    const [providersConfig, costSettings] = await Promise.all([
      window.electronAPI.getProviders(),
      window.electronAPI.getCostSettings()
    ])

    const pricingMap = buildPricingMap(costSettings)
    providers.value = providersConfig.providers.map(provider => hydrateProvider(provider, pricingMap))
    defaultProviderId.value = providersConfig.activeProviderId
    enabledProviderIds.value = [...providersConfig.enabledProviderIds]
    budgetLimit.value = costSettings.budgetLimit != null ? String(costSettings.budgetLimit) : ''

    if (providers.value.length > 0) {
      if (!providers.value.some(provider => provider.id === selectedProviderId.value)) {
        selectedProviderId.value = providers.value[0].id
      }
    } else {
      selectedProviderId.value = ''
    }
  } catch (err) {
    statusMsg.value = `加载失败: ${(err as Error).message}`
  }
}

function isEnabled (id: string): boolean {
  return enabledProviderIds.value.includes(id)
}

function isDefault (id: string): boolean {
  return defaultProviderId.value === id
}

function getOrderedEnabledIds (nextIds: string[]): string[] {
  return Array.from(new Set(nextIds.filter(id => providers.value.some(provider => provider.id === id))))
}

function selectProvider (id: string) {
  if (editing.value) return
  selectedProviderId.value = id
}

function startAdd () {
  const id = 'provider_' + Date.now().toString(36)
  editDraft.value = {
    id,
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    models: [],
    modelContextWindows: {},
    modelPricing: {},
    activeModel: '',
    enableThinking: false
  }
  selectedProviderId.value = id
  editing.value = true
  newModelInput.value = ''
}

function startEdit () {
  const provider = selectedProvider.value
  if (!provider) return

  const modelPricing: Record<string, ModelPricingEntry> = {}
  for (const model of provider.models) {
    modelPricing[model] = clonePricing(provider.modelPricing?.[model] || getDefaultPricing(model))
  }

  editDraft.value = {
    ...provider,
    models: [...provider.models],
    modelContextWindows: { ...(provider.modelContextWindows || {}) },
    modelPricing
  }
  editing.value = true
  newModelInput.value = ''
}

function cancelEdit () {
  const draftId = editDraft.value?.id
  if (draftId && !providers.value.find(provider => provider.id === draftId)) {
    selectedProviderId.value = providers.value[0]?.id || ''
  }
  editDraft.value = null
  editing.value = false
  newModelInput.value = ''
}

function addModel () {
  if (!editDraft.value) return

  const model = newModelInput.value.trim()
  if (!model) return
  if (editDraft.value.models.includes(model)) {
    statusMsg.value = '该模型已存在'
    return
  }

  editDraft.value.models.push(model)
  if (!editDraft.value.modelContextWindows) editDraft.value.modelContextWindows = {}
  if (!editDraft.value.modelPricing) editDraft.value.modelPricing = {}
  editDraft.value.modelContextWindows[model] = DEFAULT_CONTEXT_WINDOW
  editDraft.value.modelPricing[model] = getDefaultPricing(model)
  if (!editDraft.value.activeModel) editDraft.value.activeModel = model
  newModelInput.value = ''
  statusMsg.value = ''
}

function removeModel (index: number) {
  if (!editDraft.value) return

  const removed = editDraft.value.models.splice(index, 1)[0]
  if (editDraft.value.modelContextWindows) delete editDraft.value.modelContextWindows[removed]
  if (editDraft.value.modelPricing) delete editDraft.value.modelPricing[removed]
  if (editDraft.value.activeModel === removed) {
    editDraft.value.activeModel = editDraft.value.models[0] || ''
  }
}

function getCtx (provider: AIProvider, model: string): number {
  const value = provider.modelContextWindows?.[model]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_CONTEXT_WINDOW
}

function handleCtxInput (model: string, event: Event) {
  if (!editDraft.value) return
  const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10)
  if (!editDraft.value.modelContextWindows) editDraft.value.modelContextWindows = {}
  editDraft.value.modelContextWindows[model] = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WINDOW
}

function getPricing (provider: AIProvider, model: string): ModelPricingEntry {
  return clonePricing(provider.modelPricing?.[model] || getDefaultPricing(model))
}

function parsePricingNumber (value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function handlePricingInput (model: string, field: PricingField, event: Event) {
  if (!editDraft.value) return
  if (!editDraft.value.modelPricing) editDraft.value.modelPricing = {}

  editDraft.value.modelPricing[model] = {
    ...getPricing(editDraft.value, model),
    [field]: parsePricingNumber((event.target as HTMLInputElement).value)
  }
}

function syncPricingAcrossProviders (model: string, pricing: ModelPricingEntry) {
  for (const provider of providers.value) {
    if (!provider.models.includes(model)) continue
    if (!provider.modelPricing) provider.modelPricing = {}
    provider.modelPricing[model] = clonePricing(pricing)
  }
}

function parseBudgetLimit (): number | null {
  const parsed = Number.parseFloat(budgetLimit.value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function isDefaultPricing (model: string, pricing: ModelPricingEntry): boolean {
  const defaultPricing = getDefaultPricing(model)
  return pricing.inputPerMillion === defaultPricing.inputPerMillion
    && pricing.outputPerMillion === defaultPricing.outputPerMillion
    && pricing.cacheReadPerMillion === defaultPricing.cacheReadPerMillion
}

function buildPersistedCostSettings (): CostSettings {
  const pricingByModel = new Map<string, ModelPricingEntry>()

  for (const provider of providers.value) {
    for (const model of provider.models) {
      pricingByModel.set(model, getPricing(provider, model))
    }
  }

  return {
    modelPricing: Array.from(pricingByModel.entries())
      .map(([model, pricing]) => ({ model, ...clonePricing(pricing) }))
      .filter(entry => !isDefaultPricing(entry.model, entry))
      .sort((left, right) => left.model.localeCompare(right.model)),
    budgetLimit: parseBudgetLimit()
  }
}

async function saveAll (successMessage = '模型服务已保存') {
  if (!window.electronAPI?.saveProviders || !window.electronAPI?.saveCostSettings) return

  saving.value = true
  statusMsg.value = ''

  try {
    const providerPayload = providers.value.map(({ modelPricing, ...provider }) => ({
      ...provider,
      models: [...provider.models],
      modelContextWindows: { ...(provider.modelContextWindows || {}) }
    }))

    await Promise.all([
      window.electronAPI.saveProviders(JSON.parse(JSON.stringify({
        providers: providerPayload,
        activeProviderId: defaultProviderId.value,
        enabledProviderIds: enabledProviderIds.value
      } satisfies AIProvidersConfig))),
      window.electronAPI.saveCostSettings(buildPersistedCostSettings())
    ])

    statusMsg.value = successMessage
  } catch (err) {
    statusMsg.value = `保存失败: ${(err as Error).message}`
  } finally {
    saving.value = false
    window.setTimeout(() => {
      statusMsg.value = ''
    }, FEEDBACK_DISPLAY_DURATION_MS)
  }
}

async function saveBudgetOnly () {
  await saveAll('预算已保存')
}

async function saveEdit () {
  if (!editDraft.value) return

  const nextProvider = editDraft.value
  if (!nextProvider.name.trim()) {
    statusMsg.value = '请填写供应商名称'
    return
  }
  if (nextProvider.models.length === 0) {
    statusMsg.value = '请至少添加一个模型'
    return
  }
  if (!nextProvider.models.includes(nextProvider.activeModel)) {
    nextProvider.activeModel = nextProvider.models[0]
  }
  if (!nextProvider.modelContextWindows) nextProvider.modelContextWindows = {}
  if (!nextProvider.modelPricing) nextProvider.modelPricing = {}

  for (const model of nextProvider.models) {
    nextProvider.modelContextWindows[model] = getCtx(nextProvider, model)
    nextProvider.modelPricing[model] = getPricing(nextProvider, model)
  }

  const normalizedProvider: AIProvider = {
    ...nextProvider,
    models: [...nextProvider.models],
    modelContextWindows: { ...(nextProvider.modelContextWindows || {}) },
    modelPricing: Object.fromEntries(nextProvider.models.map(model => [model, getPricing(nextProvider, model)]))
  }

  const index = providers.value.findIndex(provider => provider.id === normalizedProvider.id)
  if (index >= 0) providers.value[index] = normalizedProvider
  else providers.value.push(normalizedProvider)

  for (const model of normalizedProvider.models) {
    syncPricingAcrossProviders(model, getPricing(normalizedProvider, model))
  }

  if (!enabledProviderIds.value.includes(normalizedProvider.id)) {
    enabledProviderIds.value = getOrderedEnabledIds([...enabledProviderIds.value, normalizedProvider.id])
  }
  if (!defaultProviderId.value) defaultProviderId.value = normalizedProvider.id

  selectedProviderId.value = normalizedProvider.id
  editDraft.value = null
  editing.value = false
  newModelInput.value = ''
  await saveAll()
}

async function deleteProvider (id: string) {
  providers.value = providers.value.filter(provider => provider.id !== id)
  enabledProviderIds.value = enabledProviderIds.value.filter(providerId => providerId !== id)

  if (defaultProviderId.value === id) {
    defaultProviderId.value = enabledProviderIds.value[0] || providers.value[0]?.id || ''
  }
  if (defaultProviderId.value && !enabledProviderIds.value.includes(defaultProviderId.value)) {
    enabledProviderIds.value = getOrderedEnabledIds([defaultProviderId.value, ...enabledProviderIds.value])
  }
  if (selectedProviderId.value === id) selectedProviderId.value = providers.value[0]?.id || ''

  editing.value = false
  editDraft.value = null
  await saveAll('模型平台已删除')
}

async function toggleEnabled (id: string) {
  if (isEnabled(id)) {
    if (enabledProviderIds.value.length <= 1) {
      statusMsg.value = '至少保留一个已启用供应商'
      return
    }
    enabledProviderIds.value = enabledProviderIds.value.filter(providerId => providerId !== id)
    if (defaultProviderId.value === id) {
      defaultProviderId.value = enabledProviderIds.value[0] || ''
    }
  } else {
    enabledProviderIds.value = getOrderedEnabledIds([...enabledProviderIds.value, id])
    if (!defaultProviderId.value) {
      defaultProviderId.value = id
    }
  }

  statusMsg.value = ''
  await saveAll('启用状态已更新')
}

async function setDefault (id: string) {
  defaultProviderId.value = id
  if (!enabledProviderIds.value.includes(id)) {
    enabledProviderIds.value = getOrderedEnabledIds([id, ...enabledProviderIds.value])
  }
  await saveAll('默认模型平台已更新')
}

function toggleKey (id: string) {
  showKey.value[id] = !showKey.value[id]
}

function maskKey (key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••••••'
  return key.substring(0, 4) + '••••' + key.substring(key.length - 4)
}

function formatPricing (value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0/M'
  const digits = value >= 1 ? 2 : 4
  return `$${value.toFixed(digits).replace(/\.?0+$/, '')}/M`
}
</script>

<template>
  <div class="pp-root">
    <div class="pp-list">
      <div class="pp-list-top">
        <input v-model="searchQuery" type="text" class="pp-search" placeholder="搜索模型平台或模型..." />
      </div>

      <div class="pp-providers">
        <button
          v-for="provider in filteredProviders"
          :key="provider.id"
          :class="['pp-item', { active: selectedProviderId === provider.id }]"
          @click="selectProvider(provider.id)"
        >
          <span class="pp-item-name">{{ provider.name || '(未命名)' }}</span>
          <span class="pp-item-badges">
            <span v-if="isEnabled(provider.id)" class="pp-on-badge">ON</span>
            <span v-if="isDefault(provider.id)" class="pp-default-badge">默认</span>
          </span>
        </button>
      </div>

      <button class="pp-add-btn" @click="startAdd">+ 添加</button>
    </div>

    <div class="pp-detail">
      <div class="pp-detail-scroll">
        <section class="pp-global-card">
          <div class="pp-global-header">
            <div>
              <h3 class="pp-detail-title">模型服务</h3>
              <p class="pp-global-hint">成本核算已整合到这里，模型价格单位为美元 / 每百万 token。</p>
            </div>
            <span v-if="saving" class="pp-saving">保存中…</span>
          </div>

          <div class="pp-budget-row">
            <span class="pp-row-label">会话预算上限</span>
            <div class="pp-budget-input-wrap">
              <span class="pp-budget-prefix">$</span>
              <input
                v-model="budgetLimit"
                type="number"
                step="0.01"
                min="0"
                placeholder="不限"
                class="pp-budget-input"
                @change="saveBudgetOnly"
              >
            </div>
          </div>

          <p class="pp-global-note">未单独覆盖的模型会自动使用内置默认价格。相同模型名会共享同一套成本定价。</p>
        </section>

        <div v-if="!selectedProvider && !editing" class="pp-empty">
          <p>先在左侧选择一个模型平台，或新建一个供应商。</p>
        </div>

        <template v-else-if="editing && editDraft">
          <h3 class="pp-section-title-main">{{ editingProviderLabel }}</h3>

          <div class="pp-field">
            <label>名称</label>
            <input v-model="editDraft.name" type="text" placeholder="例如: OpenAI, DeepSeek" />
          </div>

          <div class="pp-separator" />

          <div class="pp-field">
            <label>API 地址</label>
            <input v-model="editDraft.baseUrl" type="text" placeholder="https://api.openai.com/v1" />
          </div>

          <div class="pp-separator" />

          <div class="pp-field">
            <label>API 密钥</label>
            <input v-model="editDraft.apiKey" type="password" placeholder="sk-..." />
            <span class="pp-hint">仅保存在本地，不会上传。</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-field">
            <label>模型与价格</label>
            <div v-if="editDraft.models.length > 0" class="pp-model-list">
              <div v-for="(model, index) in editDraft.models" :key="model" class="pp-model-card">
                <div class="pp-model-card-head">
                  <span class="pp-model-name">{{ model }}</span>
                  <button class="pp-model-rm" @click="removeModel(index)">×</button>
                </div>

                <div class="pp-model-fields">
                  <label class="pp-inline-field">
                    <span>上下文窗口</span>
                    <input
                      :value="getCtx(editDraft, model)"
                      type="number"
                      min="1000"
                      step="1000"
                      class="pp-inline-input"
                      @input="handleCtxInput(model, $event)"
                    >
                  </label>
                  <label class="pp-inline-field">
                    <span>输入价</span>
                    <input
                      :value="getPricing(editDraft, model).inputPerMillion"
                      type="number"
                      min="0"
                      step="0.01"
                      class="pp-inline-input"
                      @input="handlePricingInput(model, 'inputPerMillion', $event)"
                    >
                  </label>
                  <label class="pp-inline-field">
                    <span>输出价</span>
                    <input
                      :value="getPricing(editDraft, model).outputPerMillion"
                      type="number"
                      min="0"
                      step="0.01"
                      class="pp-inline-input"
                      @input="handlePricingInput(model, 'outputPerMillion', $event)"
                    >
                  </label>
                  <label class="pp-inline-field">
                    <span>缓存读取</span>
                    <input
                      :value="getPricing(editDraft, model).cacheReadPerMillion"
                      type="number"
                      min="0"
                      step="0.01"
                      class="pp-inline-input"
                      @input="handlePricingInput(model, 'cacheReadPerMillion', $event)"
                    >
                  </label>
                </div>
              </div>
            </div>

            <div class="pp-model-add">
              <input v-model="newModelInput" type="text" placeholder="模型名称，如 gpt-4o" @keydown.enter.prevent="addModel" />
              <button @click="addModel">添加</button>
            </div>
          </div>

          <div class="pp-separator" />

          <div class="pp-field" v-if="editDraft.models.length > 0">
            <label>默认模型</label>
            <select v-model="editDraft.activeModel" class="pp-select">
              <option v-for="model in editDraft.models" :key="model" :value="model">{{ model }}</option>
            </select>
          </div>

          <div class="pp-separator" />

          <div class="pp-field pp-toggle-row" @click.prevent="editDraft.enableThinking = !editDraft.enableThinking">
            <label>启用思考模式</label>
            <span :class="['pp-toggle', { on: editDraft.enableThinking }]"><span class="pp-toggle-thumb" /></span>
          </div>
          <span class="pp-hint">开启后，支持的模型将展示思考过程。</span>

          <div class="pp-actions">
            <button class="pp-btn-primary" @click="saveEdit">保存</button>
            <button class="pp-btn-ghost" @click="cancelEdit">取消</button>
          </div>

          <span v-if="statusMsg" class="pp-status">{{ statusMsg }}</span>
        </template>

        <template v-else-if="selectedProvider">
          <div class="pp-detail-head">
            <h3 class="pp-section-title-main">{{ selectedProvider.name }}</h3>
            <div class="pp-detail-head-actions">
              <button
                v-if="!isDefault(selectedProvider.id)"
                class="pp-btn-ghost pp-btn-small"
                @click="setDefault(selectedProvider.id)"
              >
                设为默认
              </button>
              <span v-else class="pp-default-badge">默认</span>
              <span
                :class="['pp-toggle', { on: isEnabled(selectedProvider.id) }]"
                @click="toggleEnabled(selectedProvider.id)"
                title="切换启用状态"
              ><span class="pp-toggle-thumb" /></span>
            </div>
          </div>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">API 密钥</span>
            <span class="pp-row-value mono" @click="toggleKey(selectedProvider.id)">
              {{ showKey[selectedProvider.id] ? selectedProvider.apiKey : maskKey(selectedProvider.apiKey) }}
            </span>
          </div>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">API 地址</span>
            <span class="pp-row-value">{{ selectedProvider.baseUrl }}</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-section-label">模型 <small>{{ selectedProvider.models.length }}</small></div>
          <div v-for="model in selectedProvider.models" :key="model" class="pp-model-view-row">
            <div class="pp-model-view-main">
              <span class="pp-model-view-name">{{ model }}</span>
              <div class="pp-model-view-meta">
                <span>{{ getCtx(selectedProvider, model).toLocaleString() }} tokens</span>
                <span>输入 {{ formatPricing(getPricing(selectedProvider, model).inputPerMillion) }}</span>
                <span>输出 {{ formatPricing(getPricing(selectedProvider, model).outputPerMillion) }}</span>
                <span>缓存 {{ formatPricing(getPricing(selectedProvider, model).cacheReadPerMillion) }}</span>
              </div>
            </div>
            <span v-if="model === selectedProvider.activeModel" class="pp-default-badge">默认</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">思考模式</span>
            <span class="pp-row-value">{{ selectedProvider.enableThinking ? '已启用' : '未启用' }}</span>
          </div>

          <div class="pp-actions">
            <button class="pp-btn-primary" @click="startEdit">编辑</button>
            <button class="pp-btn-danger" @click="deleteProvider(selectedProvider.id)">删除</button>
          </div>

          <span v-if="statusMsg" class="pp-status">{{ statusMsg }}</span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pp-root {
  display: flex;
  height: 100%;
  color: var(--app-text);
}

.pp-list {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--app-border);
}

.pp-list-top {
  padding: 14px 12px 8px;
}

.pp-search,
.pp-field input[type='text'],
.pp-field input[type='password'],
.pp-select,
.pp-model-add input,
.pp-budget-input,
.pp-inline-input {
  width: 100%;
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 8px;
  color: var(--app-text);
  padding: 8px 12px;
  font-size: 0.86em;
  outline: none;
}

.pp-search:focus,
.pp-field input:focus,
.pp-select:focus,
.pp-model-add input:focus,
.pp-budget-input:focus,
.pp-inline-input:focus {
  border-color: var(--app-accent);
}

.pp-providers {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.pp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 16px;
  border: none;
  background: transparent;
  color: var(--app-text-soft);
  font-size: 0.88em;
  cursor: pointer;
  text-align: left;
}

.pp-item:hover {
  background: var(--app-panel-subtle);
}

.pp-item.active {
  background: var(--app-panel-muted);
  color: var(--app-text-strong);
  font-weight: 600;
}

.pp-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pp-item-badges,
.pp-detail-head-actions,
.pp-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.pp-on-badge {
  flex-shrink: 0;
  font-size: 0.68em;
  font-weight: 700;
  color: #fff;
  background: #22c55e;
  padding: 1px 7px;
  border-radius: 6px;
  letter-spacing: 0.04em;
}

.pp-default-badge {
  font-size: 0.68em;
  color: var(--app-accent);
  background: var(--app-accent-soft);
  padding: 1px 7px;
  border-radius: 6px;
  white-space: nowrap;
}

.pp-add-btn,
.pp-btn-primary,
.pp-btn-ghost,
.pp-btn-danger,
.pp-model-add button {
  border-radius: 8px;
  font-size: 0.84em;
  cursor: pointer;
}

.pp-add-btn {
  margin: 8px 12px 12px;
  padding: 8px 0;
  border: 1px dashed var(--app-border);
  background: transparent;
  color: var(--app-text-muted);
}

.pp-add-btn:hover {
  color: var(--app-accent);
  border-color: var(--app-accent);
}

.pp-detail {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.pp-detail-scroll {
  height: 100%;
  overflow-y: auto;
  padding: 20px 28px;
}

.pp-global-card {
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel);
  padding: 16px;
  margin-bottom: 18px;
}

.pp-global-header,
.pp-detail-head,
.pp-model-card-head,
.pp-budget-row,
.pp-row,
.pp-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.pp-detail-title,
.pp-section-title-main {
  margin: 0;
  font-size: 1.08em;
  color: var(--app-text-strong);
}

.pp-section-title-main {
  margin-bottom: 4px;
}

.pp-global-hint,
.pp-global-note,
.pp-hint,
.pp-row-label,
.pp-model-view-meta,
.pp-field label,
.pp-section-label {
  color: var(--app-text-muted);
}

.pp-global-hint,
.pp-global-note,
.pp-hint,
.pp-model-view-meta {
  font-size: 0.8em;
  line-height: 1.6;
}

.pp-global-note {
  margin: 10px 0 0;
}

.pp-budget-input-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pp-budget-prefix {
  color: var(--app-text-faint);
  font-size: 0.9em;
}

.pp-budget-input {
  max-width: 140px;
}

.pp-saving,
.pp-status {
  font-size: 0.8em;
  color: var(--app-accent);
}

.pp-empty {
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--app-text-faint);
  font-size: 0.9em;
}

.pp-separator {
  height: 1px;
  background: var(--app-border);
  margin: 16px 0;
}

.pp-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pp-field label {
  font-size: 0.85em;
}

.pp-model-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 10px;
}

.pp-model-card {
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel-subtle);
  padding: 12px;
}

.pp-model-name,
.pp-model-view-name,
.pp-row-value {
  color: var(--app-text);
}

.pp-model-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin-top: 10px;
}

.pp-inline-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.78em;
  color: var(--app-text-faint);
}

.pp-model-rm {
  border: none;
  background: none;
  color: var(--app-text-faint);
  font-size: 1.1em;
  cursor: pointer;
}

.pp-model-rm:hover {
  color: #ff453a;
}

.pp-model-add {
  display: flex;
  gap: 8px;
}

.pp-model-add button,
.pp-btn-primary {
  padding: 8px 16px;
  border: none;
  background: var(--app-accent);
  color: #fff;
}

.pp-btn-ghost,
.pp-btn-danger {
  padding: 8px 16px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  color: var(--app-text);
}

.pp-btn-danger {
  color: #ff453a;
  border-color: rgba(255, 69, 58, 0.28);
}

.pp-btn-small {
  padding: 6px 12px;
  font-size: 0.8em;
}

.pp-row {
  align-items: baseline;
}

.pp-row-label {
  font-size: 0.86em;
  flex-shrink: 0;
}

.pp-row-value {
  font-size: 0.88em;
  text-align: right;
  word-break: break-all;
}

.pp-row-value.mono {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  cursor: pointer;
}

.pp-section-label {
  font-size: 0.84em;
  margin-bottom: 8px;
}

.pp-section-label small {
  margin-left: 6px;
  color: var(--app-text-faint);
}

.pp-model-view-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--app-border);
}

.pp-model-view-row:last-of-type {
  border-bottom: none;
}

.pp-model-view-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.pp-model-view-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.pp-toggle {
  display: inline-block;
  width: 38px;
  height: 22px;
  background: var(--app-border-strong);
  border-radius: 11px;
  position: relative;
  cursor: pointer;
  flex-shrink: 0;
}

.pp-toggle.on {
  background: var(--app-accent);
}

.pp-toggle-thumb {
  display: block;
  width: 18px;
  height: 18px;
  background: #fff;
  border-radius: 50%;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.2s;
}

.pp-toggle.on .pp-toggle-thumb {
  transform: translateX(16px);
}

@media (max-width: 980px) {
  .pp-root {
    flex-direction: column;
  }

  .pp-list {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--app-border);
  }

  .pp-providers {
    max-height: 180px;
  }
}
</style>