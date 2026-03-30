<script setup lang="ts">
import { ref } from 'vue'

interface ChatMessage {
  role: string
  content: string
}

const messages = ref<ChatMessage[]>([])
const inputText = ref<string>('')
const isLoading = ref<boolean>(false)

async function sendMessage () {
  const text = inputText.value.trim()
  if (!text || isLoading.value) return

  // Add user message
  messages.value.push({ role: 'user', content: text })
  inputText.value = ''
  isLoading.value = true

  try {
    let response: { role?: string; content?: string }

    // Use Electron IPC if available, otherwise fall back to HTTP API
    if (window.electronAPI) {
      response = await window.electronAPI.chat(
        messages.value.map(m => ({ role: m.role, content: m.content }))
      )
    } else {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages.value.map(m => ({ role: m.role, content: m.content }))
        })
      })
      response = await res.json()
    }

    messages.value.push({
      role: 'assistant',
      content: response.content || '(无响应)'
    })
  } catch (err) {
    messages.value.push({
      role: 'assistant',
      content: `错误: ${(err as Error).message}`
    })
  } finally {
    isLoading.value = false
  }
}

function handleKeydown (e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}
</script>

<template>
  <div class="chat-panel">
    <div class="chat-header">
      <h2>💬 AI 对话</h2>
      <span class="chat-hint">与 AI 对话来创建、修改项目或分析数据</span>
    </div>

    <div class="chat-messages">
      <div v-if="messages.length === 0" class="empty-state">
        <p>👋 你好！我是 The World AI 助手。</p>
        <p>你可以让我：</p>
        <ul>
          <li>创建一个新的 Web 应用项目</li>
          <li>修改现有项目的后端代码</li>
          <li>分析项目中的数据</li>
          <li>调用项目的 API 进行测试</li>
        </ul>
      </div>

      <div
        v-for="(msg, i) in messages"
        :key="i"
        :class="['message', msg.role]"
      >
        <div class="message-role">
          {{ msg.role === 'user' ? '🧑 你' : '🤖 AI' }}
        </div>
        <div class="message-content">
          {{ msg.content }}
        </div>
      </div>

      <div v-if="isLoading" class="message assistant">
        <div class="message-role">🤖 AI</div>
        <div class="message-content loading">思考中...</div>
      </div>
    </div>

    <div class="chat-input">
      <textarea
        v-model="inputText"
        placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
        @keydown="handleKeydown"
        :disabled="isLoading"
        rows="3"
      />
      <button @click="sendMessage" :disabled="isLoading || !inputText.trim()">
        发送
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.chat-header {
  padding: 16px 24px;
  border-bottom: 1px solid #27272a;
}

.chat-header h2 {
  margin: 0 0 4px 0;
  font-size: 1.1em;
}

.chat-hint {
  font-size: 0.8em;
  color: #71717a;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
}

.empty-state {
  color: #71717a;
  padding: 40px 0;
  text-align: center;
}

.empty-state ul {
  list-style: none;
  padding: 0;
}

.empty-state li {
  padding: 4px 0;
}

.empty-state li::before {
  content: "• ";
  color: #3b82f6;
}

.message {
  margin-bottom: 16px;
  padding: 12px 16px;
  border-radius: 12px;
}

.message.user {
  background: #1e3a5f;
  margin-left: 40px;
}

.message.assistant {
  background: #27272a;
  margin-right: 40px;
}

.message-role {
  font-size: 0.75em;
  color: #a1a1aa;
  margin-bottom: 4px;
}

.message-content {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}

.message-content.loading {
  color: #71717a;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.chat-input {
  padding: 16px 24px;
  border-top: 1px solid #27272a;
  display: flex;
  gap: 12px;
}

.chat-input textarea {
  flex: 1;
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 8px;
  color: #e4e4e7;
  padding: 10px 14px;
  font-size: 0.9em;
  resize: none;
  font-family: inherit;
}

.chat-input textarea:focus {
  outline: none;
  border-color: #3b82f6;
}

.chat-input button {
  padding: 10px 20px;
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 0.9em;
  cursor: pointer;
  align-self: flex-end;
}

.chat-input button:hover:not(:disabled) {
  background: #2563eb;
}

.chat-input button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
