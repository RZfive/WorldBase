<script setup>
import { ref, onMounted } from 'vue'

const apiKey = ref('')
const baseUrl = ref('')
const model = ref('')
const saving = ref(false)
const statusMsg = ref('')
const showKey = ref(false)

onMounted(async () => {
  try {
    let settings = {}
    if (window.electronAPI) {
      settings = await window.electronAPI.getAISettings()
    } else {
      const res = await fetch('/api/ai/settings')
      settings = await res.json()
    }
    apiKey.value = settings.apiKey || ''
    baseUrl.value = settings.baseUrl || ''
    model.value = settings.model || ''
  } catch (err) {
    statusMsg.value = `加载失败: ${err.message}`
  }
})

async function saveSettings () {
  saving.value = true
  statusMsg.value = ''
  try {
    const config = {
      apiKey: apiKey.value.trim(),
      baseUrl: baseUrl.value.trim(),
      model: model.value.trim()
    }
    if (window.electronAPI) {
      await window.electronAPI.saveAISettings(config)
    } else {
      await fetch('/api/ai/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      })
    }
    statusMsg.value = '✅ 设置已保存'
  } catch (err) {
    statusMsg.value = `❌ 保存失败: ${err.message}`
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="settings-panel">
    <div class="settings-header">
      <h2>⚙️ AI 设置</h2>
      <span class="settings-hint">配置 AI 服务的 API 地址和密钥，支持 OpenAI 及兼容 API</span>
    </div>

    <div class="settings-body">
      <div class="settings-section">
        <h3>AI 服务配置</h3>
        <p class="section-desc">支持 OpenAI、Azure OpenAI、本地模型（如 Ollama）以及其他兼容 OpenAI API 的服务。</p>

        <div class="form-group">
          <label for="baseUrl">API 地址 (Base URL)</label>
          <input
            id="baseUrl"
            v-model="baseUrl"
            type="text"
            placeholder="https://api.openai.com/v1"
          />
          <span class="form-hint">留空则使用默认值 https://api.openai.com/v1</span>
        </div>

        <div class="form-group">
          <label for="apiKey">API 密钥 (API Key)</label>
          <div class="key-input-wrapper">
            <input
              id="apiKey"
              v-model="apiKey"
              :type="showKey ? 'text' : 'password'"
              placeholder="sk-..."
            />
            <button class="toggle-key-btn" @click="showKey = !showKey" type="button">
              {{ showKey ? '🙈' : '👁️' }}
            </button>
          </div>
          <span class="form-hint">你的 API 密钥，仅保存在本地</span>
        </div>

        <div class="form-group">
          <label for="model">模型名称 (Model)</label>
          <input
            id="model"
            v-model="model"
            type="text"
            placeholder="gpt-4o"
          />
          <span class="form-hint">留空则使用默认值 gpt-4o</span>
        </div>
      </div>

      <div class="form-actions">
        <button class="save-btn" @click="saveSettings" :disabled="saving">
          {{ saving ? '保存中...' : '💾 保存设置' }}
        </button>
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

.section-desc {
  font-size: 0.85em;
  color: #71717a;
  margin-bottom: 20px;
}

.form-group {
  margin-bottom: 18px;
}

.form-group label {
  display: block;
  font-size: 0.85em;
  color: #a1a1aa;
  margin-bottom: 6px;
  font-weight: 500;
}

.form-group input {
  width: 100%;
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 8px;
  color: #e4e4e7;
  padding: 10px 14px;
  font-size: 0.9em;
  font-family: inherit;
}

.form-group input:focus {
  outline: none;
  border-color: #3b82f6;
}

.form-hint {
  display: block;
  font-size: 0.75em;
  color: #52525b;
  margin-top: 4px;
}

.key-input-wrapper {
  display: flex;
  gap: 8px;
}

.key-input-wrapper input {
  flex: 1;
}

.toggle-key-btn {
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 8px;
  color: #e4e4e7;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 1em;
}

.toggle-key-btn:hover {
  background: #3f3f46;
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
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

.status-msg {
  font-size: 0.85em;
  color: #a1a1aa;
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
