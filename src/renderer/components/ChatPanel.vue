<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'

interface ChatMessage {
  role: string
  content: string
}

interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  providerId?: string
}

interface ProviderOption {
  id: string
  name: string
  models: string[]
  activeModel: string
}

// State
const messages = ref<ChatMessage[]>([])
const inputText = ref('')
const isLoading = ref(false)
const conversations = ref<ConversationSummary[]>([])
const currentConversationId = ref<string | null>(null)
const providers = ref<ProviderOption[]>([])
const activeProviderId = ref('')
const selectedModel = ref('')
const streamCleanup = ref<(() => void) | null>(null)
const messagesContainer = ref<HTMLElement | null>(null)
const toolStatus = ref('')

function generateId (): string {
  return Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8)
}

// Scroll to bottom of messages
function scrollToBottom () {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// Load conversations list
async function loadConversations () {
  if (!window.electronAPI) return
  try {
    conversations.value = await window.electronAPI.listConversations()
  } catch { /* ignore */ }
}

// Load providers
async function loadProviders () {
  if (!window.electronAPI) return
  try {
    const config = await window.electronAPI.getProviders()
    providers.value = config.providers.map(p => ({
      id: p.id,
      name: p.name,
      models: p.models,
      activeModel: p.activeModel
    }))
    activeProviderId.value = config.activeProviderId
    const active = providers.value.find(p => p.id === activeProviderId.value)
    if (active) {
      selectedModel.value = active.activeModel
    }
  } catch { /* ignore */ }
}

// Start a new conversation
function newConversation () {
  currentConversationId.value = null
  messages.value = []
  toolStatus.value = ''
}

// Load a conversation
async function loadConversation (id: string) {
  if (!window.electronAPI) return
  const conv = await window.electronAPI.getConversation(id)
  if (conv) {
    currentConversationId.value = conv.id
    messages.value = conv.messages
    scrollToBottom()
  }
}

// Save current conversation
async function saveCurrentConversation () {
  if (!window.electronAPI) return
  if (messages.value.length === 0) return

  const id = currentConversationId.value || generateId()
  currentConversationId.value = id

  const firstUserMsg = messages.value.find(m => m.role === 'user')
  const title = firstUserMsg
    ? (firstUserMsg.content.length > 40
        ? firstUserMsg.content.substring(0, 40) + '...'
        : firstUserMsg.content)
    : '新对话'

  await window.electronAPI.saveConversation({
    id,
    title,
    messages: messages.value,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    providerId: activeProviderId.value || undefined
  })

  await loadConversations()
}

// Delete a conversation
async function deleteConversation (id: string, e: Event) {
  e.stopPropagation()
  if (!window.electronAPI) return
  await window.electronAPI.deleteConversation(id)
  if (currentConversationId.value === id) {
    newConversation()
  }
  await loadConversations()
}

// Send message with streaming
async function sendMessage () {
  const text = inputText.value.trim()
  if (!text || isLoading.value) return

  messages.value.push({ role: 'user', content: text })
  inputText.value = ''
  isLoading.value = true
  toolStatus.value = ''
  scrollToBottom()

  // Add placeholder assistant message
  messages.value.push({ role: 'assistant', content: '' })
  const assistantIdx = messages.value.length - 1

  try {
    if (window.electronAPI) {
      // Set up the stream listener
      const cleanup = window.electronAPI.onStreamEvent((event) => {
        if (event.type === 'token' && event.content) {
          messages.value[assistantIdx].content += event.content
          scrollToBottom()
        } else if (event.type === 'tool_start' && event.name) {
          toolStatus.value = `正在执行: ${event.name}...`
        } else if (event.type === 'tool_end') {
          toolStatus.value = ''
        } else if (event.type === 'done') {
          isLoading.value = false
          toolStatus.value = ''
          if (cleanup) cleanup()
          // If empty content, use done message
          if (!messages.value[assistantIdx].content && event.message?.content) {
            messages.value[assistantIdx].content = event.message.content
          }
          if (!messages.value[assistantIdx].content) {
            messages.value[assistantIdx].content = '(无响应)'
          }
          saveCurrentConversation()
        } else if (event.type === 'error') {
          isLoading.value = false
          toolStatus.value = ''
          if (cleanup) cleanup()
          messages.value[assistantIdx].content = `错误: ${event.error}`
        }
      })
      streamCleanup.value = cleanup

      // Send only user/assistant messages (not system)
      const chatMessages = messages.value.slice(0, -1).map(m => ({ role: m.role, content: m.content }))
      await window.electronAPI.chatStream(chatMessages)

      // If stream finishes without a 'done' event
      if (isLoading.value) {
        isLoading.value = false
        if (!messages.value[assistantIdx].content) {
          messages.value[assistantIdx].content = '(无响应)'
        }
        saveCurrentConversation()
      }
    } else {
      // HTTP fallback (non-streaming)
      const chatMessages = messages.value.slice(0, -1).map(m => ({ role: m.role, content: m.content }))
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatMessages })
      })
      const response = await res.json() as { content?: string }
      messages.value[assistantIdx].content = response.content || '(无响应)'
      isLoading.value = false
      saveCurrentConversation()
    }
  } catch (err) {
    messages.value[assistantIdx].content = `错误: ${(err as Error).message}`
    isLoading.value = false
  }

  scrollToBottom()
}

function handleKeydown (e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}

// When provider changes, update the selected model
watch(activeProviderId, (newId) => {
  const p = providers.value.find(pr => pr.id === newId)
  if (p) {
    selectedModel.value = p.activeModel || p.models[0] || ''
  }
})

onMounted(async () => {
  await loadConversations()
  await loadProviders()
})

onUnmounted(() => {
  if (streamCleanup.value) {
    streamCleanup.value()
  }
})
</script>

<template>
  <div class="chat-layout">
    <!-- Conversation sidebar -->
    <div class="conv-sidebar">
      <button class="new-conv-btn" @click="newConversation">+ 新对话</button>
      <div class="conv-list">
        <div
          v-for="conv in conversations"
          :key="conv.id"
          :class="['conv-item', { active: conv.id === currentConversationId }]"
          @click="loadConversation(conv.id)"
        >
          <span class="conv-title">{{ conv.title }}</span>
          <button class="conv-delete" @click="deleteConversation(conv.id, $event)" title="删除">×</button>
        </div>
        <div v-if="conversations.length === 0" class="conv-empty">暂无对话记录</div>
      </div>
    </div>

    <!-- Chat area -->
    <div class="chat-panel">
      <div class="chat-header">
        <h2>💬 AI 对话</h2>
        <div class="provider-selector" v-if="providers.length > 0">
          <select v-model="activeProviderId" class="select-input">
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <select v-model="selectedModel" class="select-input" v-if="providers.find(p => p.id === activeProviderId)?.models?.length">
            <option v-for="m in (providers.find(p => p.id === activeProviderId)?.models || [])" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
      </div>

      <div class="chat-messages" ref="messagesContainer">
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
            {{ msg.content }}<span v-if="isLoading && i === messages.length - 1 && msg.role === 'assistant'" class="cursor-blink">▍</span>
          </div>
        </div>

        <div v-if="toolStatus" class="tool-status">
          🔧 {{ toolStatus }}
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
          {{ isLoading ? '...' : '发送' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-layout {
  display: flex;
  height: 100%;
}

/* Conversation sidebar */
.conv-sidebar {
  width: 220px;
  background: #111113;
  border-right: 1px solid #27272a;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.new-conv-btn {
  margin: 12px;
  padding: 8px 0;
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 0.85em;
  cursor: pointer;
}

.new-conv-btn:hover {
  background: #2563eb;
}

.conv-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
}

.conv-item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  color: #a1a1aa;
  font-size: 0.82em;
  margin-bottom: 2px;
}

.conv-item:hover {
  background: #1e1e22;
  color: #e4e4e7;
}

.conv-item.active {
  background: #27272a;
  color: #ffffff;
}

.conv-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-delete {
  background: none;
  border: none;
  color: #52525b;
  font-size: 1.1em;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  flex-shrink: 0;
}

.conv-delete:hover {
  color: #ef4444;
}

.conv-empty {
  text-align: center;
  color: #52525b;
  font-size: 0.8em;
  padding: 20px 0;
}

/* Chat panel */
.chat-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.chat-header {
  padding: 12px 24px;
  border-bottom: 1px solid #27272a;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.chat-header h2 {
  margin: 0;
  font-size: 1.1em;
  white-space: nowrap;
}

.provider-selector {
  display: flex;
  gap: 8px;
}

.select-input {
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 6px;
  color: #e4e4e7;
  padding: 4px 8px;
  font-size: 0.8em;
  cursor: pointer;
}

.select-input:focus {
  outline: none;
  border-color: #3b82f6;
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

.cursor-blink {
  animation: blink 0.8s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.tool-status {
  padding: 8px 16px;
  margin: 8px 0;
  background: #1a1a2e;
  border: 1px solid #27272a;
  border-radius: 8px;
  color: #60a5fa;
  font-size: 0.82em;
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
