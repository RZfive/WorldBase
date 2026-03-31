<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'

interface AIProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
  activeModel: string
  enableThinking?: boolean
}

const providers = ref<AIProvider[]>([])
const activeProviderId = ref('')
const saving = ref(false)
const statusMsg = ref('')
const editingProvider = ref<AIProvider | null>(null)
const showKey = ref<Record<string, boolean>>({})
const newModelInput = ref('')

const sortedProviders = computed(() => {
  return [...providers.value].sort((a, b) => {
    if (a.id === activeProviderId.value) return -1
    if (b.id === activeProviderId.value) return 1
    return a.name.localeCompare(b.name)
  })
})

onMounted(async () => {
  await loadProviders()
})

async function loadProviders () {
  try {
    if (window.electronAPI) {
      const config = await window.electronAPI.getProviders()
      providers.value = config.providers
      activeProviderId.value = config.activeProviderId
    }
  } catch (err) {
    statusMsg.value = `加载失败: ${(err as Error).message}`
  }
}

function addProvider () {
  const id = 'provider_' + Date.now().toString(36)
  editingProvider.value = {
    id,
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    models: [],
    activeModel: '',
    enableThinking: false
  }
  newModelInput.value = ''
}

function editProvider (p: AIProvider) {
  editingProvider.value = { ...p, models: [...p.models] }
  newModelInput.value = ''
}

function cancelEdit () {
  editingProvider.value = null
  newModelInput.value = ''
}

function addModel () {
  if (!editingProvider.value) return
  const model = newModelInput.value.trim()
  if (!model) return
  if (editingProvider.value.models.includes(model)) {
    statusMsg.value = '该模型已存在'
    return
  }
  editingProvider.value.models.push(model)
  if (!editingProvider.value.activeModel) {
    editingProvider.value.activeModel = model
  }
  newModelInput.value = ''
  statusMsg.value = ''
}

function removeModel (index: number) {
  if (!editingProvider.value) return
  const removed = editingProvider.value.models.splice(index, 1)[0]
  if (editingProvider.value.activeModel === removed) {
    editingProvider.value.activeModel = editingProvider.value.models[0] || ''
  }
}

async function saveEdit () {
  if (!editingProvider.value) return
  const ep = editingProvider.value
  if (!ep.name.trim()) {
    statusMsg.value = '请填写供应商名称'
    return
  }

  if (ep.models.length === 0) {
    statusMsg.value = '请至少添加一个模型'
    return
  }

  if (!ep.models.includes(ep.activeModel)) {
    ep.activeModel = ep.models[0]
  }

  const idx = providers.value.findIndex(p => p.id === ep.id)
  if (idx >= 0) {
    providers.value[idx] = ep
  } else {
    providers.value.push(ep)
  }

  // If no active provider, set this one
  if (!activeProviderId.value) {
    activeProviderId.value = ep.id
  }

  editingProvider.value = null
  newModelInput.value = ''

  // Auto-save to main process
  await saveAll()
}

async function deleteProvider (id: string) {
  providers.value = providers.value.filter(p => p.id !== id)
  if (activeProviderId.value === id) {
    activeProviderId.value = providers.value[0]?.id || ''
  }
  await saveAll()
}

async function setActive (id: string) {
  activeProviderId.value = id
  await saveAll()
}

async function saveAll () {
  saving.value = true
  statusMsg.value = ''
  try {
    if (window.electronAPI) {
      await window.electronAPI.saveProviders({
        providers: providers.value,
        activeProviderId: activeProviderId.value
      })
    }
    statusMsg.value = '✅ 设置已保存'
  } catch (err) {
    statusMsg.value = `❌ 保存失败: ${(err as Error).message}`
  } finally {
    saving.value = false
  }
}

function toggleKey (id: string) {
  showKey.value[id] = !showKey.value[id]
}

function maskKey (key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••••••'
  return key.substring(0, 4) + '••••' + key.substring(key.length - 4)
}
</script>

<template>
  <div class="settings-panel">
    <div class="settings-header">
      <h2>⚙️ AI 设置</h2>
      <span class="settings-hint">管理多个 AI 供应商，支持 OpenAI 及兼容 API</span>
    </div>

    <div class="settings-body">
      <!-- Provider edit form -->
      <div v-if="editingProvider" class="settings-section edit-form">
        <h3>{{ providers.find(p => p.id === editingProvider!.id) ? '编辑' : '添加' }}供应商</h3>

        <div class="form-group">
          <label>名称</label>
          <input v-model="editingProvider.name" type="text" placeholder="例如: OpenAI, DeepSeek" />
        </div>

        <div class="form-group">
          <label>API 地址 (Base URL)</label>
          <input v-model="editingProvider.baseUrl" type="text" placeholder="https://api.openai.com/v1" />
        </div>

        <div class="form-group">
          <label>API 密钥</label>
          <input v-model="editingProvider.apiKey" type="password" placeholder="sk-..." />
          <span class="form-hint">仅保存在本地</span>
        </div>

        <div class="form-group">
          <label>模型列表</label>
          <div class="model-tags">
            <span v-for="(m, i) in editingProvider.models" :key="i" class="model-tag">
              {{ m }}
              <button class="model-tag-remove" @click="removeModel(i)" title="移除">×</button>
            </span>
          </div>
          <div class="model-add-row">
            <input
              v-model="newModelInput"
              type="text"
              placeholder="输入模型名称，如 gpt-4o"
              class="model-add-input"
              @keydown.enter.prevent="addModel"
            />
            <button class="model-add-btn" @click="addModel">添加</button>
          </div>
          <span class="form-hint">逐个添加模型，列表中第一个为默认模型</span>
        </div>

        <div class="form-group" v-if="editingProvider.models.length > 0">
          <label>默认模型</label>
          <select v-model="editingProvider.activeModel" class="select-input">
            <option v-for="m in editingProvider.models" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>

        <div class="form-group">
          <label class="toggle-label" @click.prevent="editingProvider.enableThinking = !editingProvider.enableThinking">
            <span :class="['custom-toggle', { on: editingProvider.enableThinking }]">
              <span class="custom-toggle-thumb"></span>
            </span>
            <span>启用思考模式 (Thinking)</span>
          </label>
          <span class="form-hint">开启后，支持的模型将展示思考过程 (如 DeepSeek-R1, o1 等)</span>
        </div>

        <div class="form-actions-edit">
          <button class="save-btn" @click="saveEdit">确认保存</button>
          <button class="cancel-btn" @click="cancelEdit">取消</button>
        </div>
      </div>

      <!-- Providers list -->
      <div v-else>
        <div class="providers-header">
          <h3>AI 供应商</h3>
          <button class="add-btn" @click="addProvider">+ 添加供应商</button>
        </div>

        <div v-if="providers.length === 0" class="empty-providers">
          <p>还没有配置供应商。点击"添加供应商"开始配置。</p>
        </div>

        <div
          v-for="p in sortedProviders"
          :key="p.id"
          :class="['provider-card', { active: p.id === activeProviderId }]"
        >
          <div class="provider-header">
            <div class="provider-name">
              <span class="active-badge" v-if="p.id === activeProviderId">当前</span>
              {{ p.name || '(未命名)' }}
            </div>
            <div class="provider-actions">
              <button v-if="p.id !== activeProviderId" class="action-btn" @click="setActive(p.id)" title="设为活跃">✓</button>
              <button class="action-btn" @click="editProvider(p)" title="编辑">✏️</button>
              <button class="action-btn danger" @click="deleteProvider(p.id)" title="删除">🗑</button>
            </div>
          </div>
          <div class="provider-details">
            <div class="detail-row">
              <span class="detail-label">地址:</span>
              <span class="detail-value">{{ p.baseUrl }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">密钥:</span>
              <span class="detail-value key-value" @click="toggleKey(p.id)">
                {{ showKey[p.id] ? p.apiKey : maskKey(p.apiKey) }}
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-label">模型:</span>
              <span class="detail-value">{{ p.models.join(', ') }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">默认:</span>
              <span class="detail-value">{{ p.activeModel }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">思考:</span>
              <span class="detail-value">{{ p.enableThinking ? '✅ 已启用' : '❌ 未启用' }}</span>
            </div>
          </div>
        </div>

        <span v-if="statusMsg" class="status-msg">{{ statusMsg }}</span>
      </div>

      <div class="settings-section presets">
        <h3>常用服务参考</h3>
        <table class="presets-table">
          <thead>
            <tr>
              <th>服务</th>
              <th>API 地址</th>
              <th>模型示例</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>OpenAI</td>
              <td><code>https://api.openai.com/v1</code></td>
              <td>gpt-4o, gpt-4o-mini</td>
            </tr>
            <tr>
              <td>DeepSeek</td>
              <td><code>https://api.deepseek.com/v1</code></td>
              <td>deepseek-chat, deepseek-coder</td>
            </tr>
            <tr>
              <td>Ollama (本地)</td>
              <td><code>http://localhost:11434/v1</code></td>
              <td>llama3, qwen2</td>
            </tr>
            <tr>
              <td>Azure OpenAI</td>
              <td><code>https://{资源名}.openai.azure.com/openai/deployments/{部署名}/v1</code></td>
              <td>gpt-4o</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.settings-header {
  padding: 16px 24px;
  border-bottom: 1px solid #27272a;
}

.settings-header h2 {
  margin: 0 0 4px 0;
  font-size: 1.1em;
}

.settings-hint {
  font-size: 0.8em;
  color: #71717a;
}

.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

/* Providers list header */
.providers-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.providers-header h3 {
  margin: 0;
  font-size: 1em;
  color: #e4e4e7;
}

.add-btn {
  padding: 6px 14px;
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 0.82em;
  cursor: pointer;
}

.add-btn:hover {
  background: #2563eb;
}

.empty-providers {
  text-align: center;
  color: #52525b;
  padding: 40px 0;
  font-size: 0.9em;
}

/* Provider card */
.provider-card {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 10px;
  padding: 16px 20px;
  margin-bottom: 12px;
}

.provider-card.active {
  border-color: #3b82f6;
}

.provider-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.provider-name {
  font-weight: 600;
  font-size: 0.95em;
  display: flex;
  align-items: center;
  gap: 8px;
}

.active-badge {
  background: #3b82f6;
  color: white;
  font-size: 0.7em;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}

.provider-actions {
  display: flex;
  gap: 4px;
}

.action-btn {
  background: none;
  border: 1px solid #3f3f46;
  border-radius: 6px;
  color: #a1a1aa;
  padding: 4px 8px;
  font-size: 0.8em;
  cursor: pointer;
}

.action-btn:hover {
  background: #27272a;
  color: #e4e4e7;
}

.action-btn.danger:hover {
  color: #ef4444;
  border-color: #ef4444;
}

.provider-details {
  font-size: 0.82em;
}

.detail-row {
  display: flex;
  padding: 3px 0;
  gap: 8px;
}

.detail-label {
  color: #71717a;
  min-width: 50px;
}

.detail-value {
  color: #a1a1aa;
  word-break: break-all;
}

.key-value {
  cursor: pointer;
  font-family: monospace;
}

/* Edit form */
.edit-form {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 12px;
  padding: 20px 24px;
  margin-bottom: 20px;
}

.edit-form h3 {
  margin: 0 0 16px 0;
  font-size: 1em;
  color: #e4e4e7;
}

.settings-section {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 12px;
  padding: 20px 24px;
  margin-bottom: 20px;
}

.settings-section h3 {
  font-size: 1em;
  margin: 0 0 8px 0;
  color: #e4e4e7;
}

.form-group {
  margin-bottom: 14px;
}

.form-group label {
  display: block;
  font-size: 0.85em;
  color: #a1a1aa;
  margin-bottom: 6px;
  font-weight: 500;
}

.form-group input[type="text"],
.form-group input[type="password"],
.select-input {
  width: 100%;
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 8px;
  color: #e4e4e7;
  padding: 10px 14px;
  font-size: 0.9em;
  font-family: inherit;
}

.form-group input[type="text"]:focus,
.form-group input[type="password"]:focus,
.select-input:focus {
  outline: none;
  border-color: #3b82f6;
}

.form-hint {
  display: block;
  font-size: 0.75em;
  color: #52525b;
  margin-top: 4px;
}

/* Model tags */
.model-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  min-height: 8px;
}

.model-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 0.82em;
  color: #e4e4e7;
}

.model-tag-remove {
  background: none;
  border: none;
  color: #71717a;
  font-size: 1.1em;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
}

.model-tag-remove:hover {
  color: #ef4444;
}

.model-add-row {
  display: flex;
  gap: 8px;
}

.model-add-input {
  flex: 1;
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 8px;
  color: #e4e4e7;
  padding: 8px 12px;
  font-size: 0.85em;
  font-family: inherit;
}

.model-add-input:focus {
  outline: none;
  border-color: #3b82f6;
}

.model-add-btn {
  padding: 8px 16px;
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 0.82em;
  cursor: pointer;
  white-space: nowrap;
}

.model-add-btn:hover {
  background: #2563eb;
}

/* Custom toggle switch */
.custom-toggle {
  display: inline-block;
  width: 36px;
  height: 20px;
  background: #3f3f46;
  border-radius: 10px;
  position: relative;
  transition: background 0.2s;
  cursor: pointer;
  flex-shrink: 0;
}

.custom-toggle.on {
  background: #3b82f6;
}

.custom-toggle-thumb {
  display: block;
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 50%;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.2s;
}

.custom-toggle.on .custom-toggle-thumb {
  transform: translateX(16px);
}

.form-actions-edit {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 16px 0;
}

.save-btn {
  padding: 10px 24px;
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 0.9em;
  cursor: pointer;
  font-weight: 500;
}

.save-btn:hover:not(:disabled) {
  background: #2563eb;
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cancel-btn {
  padding: 10px 24px;
  background: #27272a;
  color: #a1a1aa;
  border: 1px solid #3f3f46;
  border-radius: 8px;
  font-size: 0.9em;
  cursor: pointer;
}

.cancel-btn:hover {
  background: #3f3f46;
  color: #e4e4e7;
}

.status-msg {
  font-size: 0.85em;
  color: #a1a1aa;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: 0.9em;
  color: #e4e4e7;
}

.presets-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85em;
  margin-top: 12px;
}

.presets-table th {
  text-align: left;
  padding: 8px 12px;
  color: #71717a;
  border-bottom: 1px solid #27272a;
  font-weight: 500;
}

.presets-table td {
  padding: 8px 12px;
  border-bottom: 1px solid #1f1f23;
  color: #a1a1aa;
}

.presets-table code {
  background: #27272a;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.9em;
  color: #60a5fa;
}
</style>
