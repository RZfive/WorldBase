<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface AIProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
  modelContextWindows?: Record<string, number>
  activeModel: string
  enableThinking?: boolean
}

interface AIProvidersConfig {
  providers: AIProvider[]
  activeProviderId: string
  enabledProviderIds: string[]
}

const DEFAULT_CONTEXT_WINDOW = 32000

const providers = ref<AIProvider[]>([])
const defaultProviderId = ref('')
const enabledProviderIds = ref<string[]>([])
const saving = ref(false)
const statusMsg = ref('')
const showKey = ref<Record<string, boolean>>({})
const newModelInput = ref('')
const searchQuery = ref('')
const selectedProviderId = ref('')
const editing = ref(false)
const editDraft = ref<AIProvider | null>(null)

const filteredProviders = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return providers.value
  return providers.value.filter(p => p.name.toLowerCase().includes(q) || p.baseUrl.toLowerCase().includes(q))
})

const selectedProvider = computed(() => {
  return providers.value.find(p => p.id === selectedProviderId.value) ?? null
})

onMounted(async () => {
  await loadProviders()
})

async function loadProviders () {
  try {
    if (window.electronAPI) {
      const config = await window.electronAPI.getProviders()
      providers.value = config.providers
      defaultProviderId.value = config.activeProviderId
      enabledProviderIds.value = [...config.enabledProviderIds]
      if (providers.value.length > 0 && !selectedProviderId.value) {
        selectedProviderId.value = providers.value[0].id
      }
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
    activeModel: '',
    enableThinking: false
  }
  selectedProviderId.value = id
  editing.value = true
  newModelInput.value = ''
}

function startEdit () {
  const p = selectedProvider.value
  if (!p) return
  editDraft.value = {
    ...p,
    models: [...p.models],
    modelContextWindows: { ...(p.modelContextWindows || {}) }
  }
  editing.value = true
  newModelInput.value = ''
}

function cancelEdit () {
  if (editDraft.value && !providers.value.find(p => p.id === editDraft.value!.id)) {
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
  if (editDraft.value.models.includes(model)) { statusMsg.value = '该模型已存在'; return }
  editDraft.value.models.push(model)
  if (!editDraft.value.modelContextWindows) editDraft.value.modelContextWindows = {}
  editDraft.value.modelContextWindows[model] = DEFAULT_CONTEXT_WINDOW
  if (!editDraft.value.activeModel) editDraft.value.activeModel = model
  newModelInput.value = ''
  statusMsg.value = ''
}

function removeModel (index: number) {
  if (!editDraft.value) return
  const removed = editDraft.value.models.splice(index, 1)[0]
  if (editDraft.value.modelContextWindows) delete editDraft.value.modelContextWindows[removed]
  if (editDraft.value.activeModel === removed) editDraft.value.activeModel = editDraft.value.models[0] || ''
}

function getCtx (provider: AIProvider, model: string): number {
  const v = provider.modelContextWindows?.[model]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_CONTEXT_WINDOW
}

function handleCtxInput (model: string, event: Event) {
  if (!editDraft.value) return
  const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10)
  if (!editDraft.value.modelContextWindows) editDraft.value.modelContextWindows = {}
  editDraft.value.modelContextWindows[model] = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WINDOW
}

async function saveEdit () {
  if (!editDraft.value) return
  const ep = editDraft.value
  if (!ep.name.trim()) { statusMsg.value = '请填写供应商名称'; return }
  if (ep.models.length === 0) { statusMsg.value = '请至少添加一个模型'; return }
  if (!ep.models.includes(ep.activeModel)) ep.activeModel = ep.models[0]
  if (!ep.modelContextWindows) ep.modelContextWindows = {}
  for (const model of ep.models) ep.modelContextWindows[model] = getCtx(ep, model)

  const idx = providers.value.findIndex(p => p.id === ep.id)
  if (idx >= 0) providers.value[idx] = ep
  else providers.value.push(ep)
  if (!enabledProviderIds.value.includes(ep.id)) {
    enabledProviderIds.value = getOrderedEnabledIds([...enabledProviderIds.value, ep.id])
  }
  if (!defaultProviderId.value) defaultProviderId.value = ep.id

  selectedProviderId.value = ep.id
  editDraft.value = null
  editing.value = false
  newModelInput.value = ''
  await saveAll()
}

async function deleteProvider (id: string) {
  providers.value = providers.value.filter(p => p.id !== id)
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
  await saveAll()
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
  await saveAll()
}

async function setDefault (id: string) {
  defaultProviderId.value = id
  if (!enabledProviderIds.value.includes(id)) {
    enabledProviderIds.value = getOrderedEnabledIds([id, ...enabledProviderIds.value])
  }
  await saveAll()
}

async function saveAll () {
  saving.value = true
  statusMsg.value = ''
  try {
    if (window.electronAPI) {
      await window.electronAPI.saveProviders(JSON.parse(JSON.stringify({
        providers: providers.value,
        activeProviderId: defaultProviderId.value,
        enabledProviderIds: enabledProviderIds.value
      } satisfies AIProvidersConfig)))
    }
    statusMsg.value = '已保存'
  } catch (err) {
    statusMsg.value = `保存失败: ${(err as Error).message}`
  } finally {
    saving.value = false
    setTimeout(() => { statusMsg.value = '' }, 2000)
  }
}

function toggleKey (id: string) { showKey.value[id] = !showKey.value[id] }
function maskKey (key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••••••'
  return key.substring(0, 4) + '••••' + key.substring(key.length - 4)
}
</script>

<template>
  <div class="pp-root">
    <!-- Left: provider list -->
    <div class="pp-list">
      <div class="pp-list-top">
        <input v-model="searchQuery" type="text" class="pp-search" placeholder="搜索模型平台..." />
      </div>
      <div class="pp-providers">
        <button
          v-for="p in filteredProviders"
          :key="p.id"
          :class="['pp-item', { active: selectedProviderId === p.id }]"
          @click="selectProvider(p.id)"
        >
          <span class="pp-item-name">{{ p.name || '(未命名)' }}</span>
          <span class="pp-item-badges">
            <span v-if="isEnabled(p.id)" class="pp-on-badge">ON</span>
            <span v-if="isDefault(p.id)" class="pp-default-badge">默认</span>
          </span>
        </button>
      </div>
      <button class="pp-add-btn" @click="startAdd">+ 添加</button>
    </div>

    <!-- Right: provider detail / edit -->
    <div class="pp-detail">
      <!-- Nothing selected -->
      <div v-if="!selectedProvider && !editing" class="pp-empty">
        <p>选择左侧的供应商查看配置</p>
      </div>

      <!-- Edit mode -->
      <template v-else-if="editing && editDraft">
        <div class="pp-detail-scroll">
          <h3 class="pp-detail-title">{{ providers.find(p => p.id === editDraft!.id) ? '编辑供应商' : '添加供应商' }}</h3>

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
            <span class="pp-hint">仅保存在本地，不会上传</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-field">
            <label>模型</label>
            <div class="pp-model-list">
              <div v-for="(m, i) in editDraft.models" :key="i" class="pp-model-row">
                <span class="pp-model-name">{{ m }}</span>
                <input
                  :value="getCtx(editDraft, m)"
                  type="number"
                  min="1000"
                  step="1000"
                  class="pp-ctx-input"
                  placeholder="窗口"
                  @input="handleCtxInput(m, $event)"
                />
                <button class="pp-model-rm" @click="removeModel(i)">×</button>
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
              <option v-for="m in editDraft.models" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>

          <div class="pp-separator" />

          <div class="pp-field pp-toggle-row" @click.prevent="editDraft.enableThinking = !editDraft.enableThinking">
            <label>启用思考模式</label>
            <span :class="['pp-toggle', { on: editDraft.enableThinking }]"><span class="pp-toggle-thumb" /></span>
          </div>
          <span class="pp-hint">开启后，支持的模型将展示思考过程</span>

          <div class="pp-actions">
            <button class="pp-btn-primary" @click="saveEdit">保存</button>
            <button class="pp-btn-ghost" @click="cancelEdit">取消</button>
          </div>

          <span v-if="statusMsg" class="pp-status">{{ statusMsg }}</span>
        </div>
      </template>

      <!-- View mode -->
      <template v-else-if="selectedProvider">
        <div class="pp-detail-scroll">
          <div class="pp-detail-head">
            <h3 class="pp-detail-title">{{ selectedProvider.name }}</h3>
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
          <div v-for="m in selectedProvider.models" :key="m" class="pp-model-view-row">
            <span class="pp-model-view-name">{{ m }}</span>
            <span class="pp-model-view-ctx">{{ getCtx(selectedProvider, m).toLocaleString() }} tokens</span>
            <span v-if="m === selectedProvider.activeModel" class="pp-default-badge">默认</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">思考模式</span>
            <span class="pp-row-value">{{ selectedProvider.enableThinking ? '已启用' : '未启用' }}</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-actions">
            <button class="pp-btn-primary" @click="startEdit">编辑</button>
            <button class="pp-btn-danger" @click="deleteProvider(selectedProvider.id)">删除</button>
          </div>

          <span v-if="statusMsg" class="pp-status">{{ statusMsg }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pp-root {
  display: flex;
  height: 100%;
  color: var(--app-text);
}

/* ── Left provider list ── */
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

.pp-search {
  width: 100%;
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 8px;
  color: var(--app-text);
  padding: 8px 12px;
  font-size: 0.85em;
  outline: none;
}
.pp-search:focus { border-color: var(--app-accent); }
.pp-search::placeholder { color: var(--app-text-faint); }

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
  transition: background 0.1s;
}
.pp-item:hover { background: var(--app-panel-subtle); }
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

.pp-item-badges {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
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

.pp-add-btn {
  margin: 8px 12px 12px;
  padding: 8px 0;
  border: 1px dashed var(--app-border);
  border-radius: 8px;
  background: transparent;
  color: var(--app-text-muted);
  font-size: 0.85em;
  cursor: pointer;
  transition: color 0.1s, border-color 0.1s;
}
.pp-add-btn:hover { color: var(--app-accent); border-color: var(--app-accent); }

/* ── Right detail ── */
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

.pp-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--app-text-faint);
  font-size: 0.9em;
}

.pp-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pp-detail-title {
  margin: 0 0 4px;
  font-size: 1.1em;
  color: var(--app-text-strong);
}

.pp-detail-head-actions { display: flex; gap: 8px; align-items: center; }

.pp-btn-small {
  padding: 6px 12px;
  font-size: 0.8em;
}

/* ── Separator ── */
.pp-separator {
  height: 1px;
  background: var(--app-border);
  margin: 16px 0;
}

/* ── Rows (view mode) ── */
.pp-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.pp-row-label {
  font-size: 0.88em;
  color: var(--app-text-muted);
  flex-shrink: 0;
}

.pp-row-value {
  font-size: 0.88em;
  color: var(--app-text);
  text-align: right;
  word-break: break-all;
}
.pp-row-value.mono { font-family: monospace; cursor: pointer; }

.pp-section-label {
  font-size: 0.85em;
  color: var(--app-text-muted);
  margin-bottom: 8px;
}
.pp-section-label small {
  margin-left: 6px;
  color: var(--app-text-faint);
}

.pp-model-view-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--app-border);
  font-size: 0.88em;
}
.pp-model-view-row:last-child { border-bottom: none; }
.pp-model-view-name { color: var(--app-text); flex: 1; }
.pp-model-view-ctx { color: var(--app-text-faint); font-size: 0.82em; }
.pp-default-badge {
  font-size: 0.68em;
  color: var(--app-accent);
  background: var(--app-accent-soft);
  padding: 1px 7px;
  border-radius: 6px;
}

/* ── Fields (edit mode) ── */
.pp-field { }
.pp-field label {
  display: block;
  font-size: 0.85em;
  color: var(--app-text-muted);
  margin-bottom: 6px;
}
.pp-field input[type="text"],
.pp-field input[type="password"] {
  width: 100%;
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 8px;
  color: var(--app-text);
  padding: 9px 12px;
  font-size: 0.9em;
  outline: none;
}
.pp-field input:focus { border-color: var(--app-accent); }

.pp-hint {
  display: block;
  font-size: 0.75em;
  color: var(--app-text-faint);
  margin-top: 4px;
}

.pp-select {
  width: 100%;
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 8px;
  color: var(--app-text);
  padding: 9px 12px;
  font-size: 0.9em;
  outline: none;
}
.pp-select:focus { border-color: var(--app-accent); }

/* Models in edit */
.pp-model-list { margin-bottom: 8px; }
.pp-model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--app-border);
  font-size: 0.85em;
}
.pp-model-name { flex: 1; color: var(--app-text); overflow: hidden; text-overflow: ellipsis; }
.pp-ctx-input {
  width: 100px;
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 6px;
  color: var(--app-text);
  padding: 4px 8px;
  font-size: 0.85em;
  outline: none;
}
.pp-ctx-input:focus { border-color: var(--app-accent); }
.pp-model-rm {
  background: none;
  border: none;
  color: var(--app-text-faint);
  font-size: 1.1em;
  cursor: pointer;
  padding: 0 4px;
}
.pp-model-rm:hover { color: var(--app-danger); }

.pp-model-add {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.pp-model-add input {
  flex: 1;
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 8px;
  color: var(--app-text);
  padding: 7px 12px;
  font-size: 0.85em;
  outline: none;
}
.pp-model-add input:focus { border-color: var(--app-accent); }
.pp-model-add button {
  padding: 7px 16px;
  background: var(--app-accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 0.82em;
  cursor: pointer;
}
.pp-model-add button:hover { background: var(--app-accent-strong); }

/* Toggle */
.pp-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
}
.pp-toggle-row label { margin: 0; cursor: pointer; }

.pp-toggle {
  display: inline-block;
  width: 38px;
  height: 22px;
  background: var(--app-border-strong);
  border-radius: 11px;
  position: relative;
  transition: background 0.2s;
  cursor: pointer;
  flex-shrink: 0;
}
.pp-toggle.on { background: var(--app-accent); }
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
.pp-toggle.on .pp-toggle-thumb { transform: translateX(16px); }

/* Actions */
.pp-actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}

.pp-btn-primary {
  padding: 8px 22px;
  background: var(--app-accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 0.88em;
  cursor: pointer;
}
.pp-btn-primary:hover { background: var(--app-accent-strong); }

.pp-btn-ghost {
  padding: 8px 22px;
  background: transparent;
  color: var(--app-text-muted);
  border: 1px solid var(--app-border);
  border-radius: 8px;
  font-size: 0.88em;
  cursor: pointer;
}
.pp-btn-ghost:hover { color: var(--app-text); background: var(--app-panel-subtle); }

.pp-btn-danger {
  padding: 8px 22px;
  background: transparent;
  color: var(--app-danger, #ef4444);
  border: 1px solid var(--app-danger, #ef4444);
  border-radius: 8px;
  font-size: 0.88em;
  cursor: pointer;
}
.pp-btn-danger:hover { background: rgba(239, 68, 68, 0.1); }

.pp-status {
  display: block;
  font-size: 0.82em;
  color: var(--app-text-muted);
  margin-top: 10px;
}
</style>
