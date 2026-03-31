<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from 'vue'
import { marked } from 'marked'

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true
})

/**
 * DOM-based HTML sanitizer — uses the browser's DOMParser to properly parse
 * HTML and remove dangerous elements/attributes. This is more robust than
 * regex-based sanitization and prevents XSS in v-html rendering.
 */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'i', 'em', 'strong', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img', 'hr', 'div', 'span', 'details', 'summary',
  'abbr', 'cite', 'dfn', 'q', 'small', 'time', 'wbr'
])

const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'class', 'id', 'width', 'height',
  'colspan', 'rowspan', 'scope', 'align', 'valign',
  'open', 'datetime', 'start', 'reversed', 'type'
])

function sanitizeHtml (html: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''

  sanitizeNode(root)
  return root.innerHTML
}

function sanitizeNode (node: Element): void {
  const children = Array.from(node.childNodes)
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element
      const tag = el.tagName.toLowerCase()

      if (!ALLOWED_TAGS.has(tag)) {
        // Replace disallowed element with its text content
        const textNode = document.createTextNode(el.textContent || '')
        node.replaceChild(textNode, el)
        continue
      }

      // Remove disallowed attributes
      const attrs = Array.from(el.attributes)
      for (const attr of attrs) {
        const name = attr.name.toLowerCase()
        if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) {
          el.removeAttribute(attr.name)
          continue
        }
        // Block javascript: protocol in URLs
        if ((name === 'href' || name === 'src') && attr.value.trim().toLowerCase().startsWith('javascript:')) {
          el.removeAttribute(attr.name)
        }
      }

      // Recursively sanitize children
      sanitizeNode(el)
    }
  }
}

interface ChatMessage {
  role: string
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  thinking?: string
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
const pendingImages = ref<Array<{ base64: string; mimeType: string }>>([])
const expandedThinking = ref<Record<number, boolean>>({})
const currentThinking = ref('')

function generateId (): string {
  return Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8)
}

/** Get displayable text from a message (handles string or multipart content). */
function getMessageText (msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(p => p.type === 'text')
      .map(p => p.text || '')
      .join('')
  }
  return ''
}

/** Get images from a multipart message. */
function getMessageImages (msg: ChatMessage): string[] {
  if (!Array.isArray(msg.content)) return []
  return msg.content
    .filter(p => p.type === 'image_url' && p.image_url?.url)
    .map(p => p.image_url!.url)
}

/** Render markdown content to sanitized HTML. */
function renderMarkdown (text: string): string {
  if (!text) return ''
  const raw = marked.parse(text, { async: false }) as string
  return sanitizeHtml(raw)
}

/** Toggle thinking block visibility. */
function toggleThinking (index: number) {
  expandedThinking.value[index] = !expandedThinking.value[index]
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
  pendingImages.value = []
  currentThinking.value = ''
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
  const titleText = firstUserMsg ? getMessageText(firstUserMsg) : ''
  const title = titleText
    ? (titleText.length > 40 ? titleText.substring(0, 40) + '...' : titleText)
    : '新对话'

  await window.electronAPI.saveConversation(JSON.parse(JSON.stringify({
    id,
    title,
    messages: messages.value,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    providerId: activeProviderId.value || undefined
  })))

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

// Handle image upload
function handleImageUpload (e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return

  for (const file of Array.from(input.files)) {
    if (!file.type.startsWith('image/')) continue
    if (file.size > 20 * 1024 * 1024) {
      alert('图片大小不能超过 20MB')
      continue
    }

    const reader = new FileReader()
    reader.onload = () => {
      const base64 = reader.result as string
      pendingImages.value.push({ base64, mimeType: file.type })
    }
    reader.readAsDataURL(file)
  }

  // Reset input so the same file can be selected again
  input.value = ''
}

function removeImage (index: number) {
  pendingImages.value.splice(index, 1)
}

// Send message with streaming
async function sendMessage () {
  const text = inputText.value.trim()
  if ((!text && pendingImages.value.length === 0) || isLoading.value) return

  // Build the message content (multipart if images present)
  let messageContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  if (pendingImages.value.length > 0) {
    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
    if (text) {
      parts.push({ type: 'text', text })
    }
    for (const img of pendingImages.value) {
      parts.push({ type: 'image_url', image_url: { url: img.base64 } })
    }
    messageContent = parts
  } else {
    messageContent = text
  }

  messages.value.push({ role: 'user', content: messageContent })
  inputText.value = ''
  pendingImages.value = []
  isLoading.value = true
  toolStatus.value = ''
  currentThinking.value = ''
  scrollToBottom()

  // Add placeholder assistant message
  messages.value.push({ role: 'assistant', content: '', thinking: '' })
  const assistantIdx = messages.value.length - 1

  try {
    if (window.electronAPI) {
      // Set up the stream listener
      const cleanup = window.electronAPI.onStreamEvent((event) => {
        if (event.type === 'thinking' && event.content) {
          // Accumulate thinking content
          currentThinking.value += event.content
          messages.value[assistantIdx].thinking = currentThinking.value
          scrollToBottom()
        } else if (event.type === 'token' && event.content) {
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
          if (!getMessageText(messages.value[assistantIdx]) && event.message?.content) {
            messages.value[assistantIdx].content = event.message.content
          }
          if (!getMessageText(messages.value[assistantIdx])) {
            messages.value[assistantIdx].content = '(无响应)'
          }
          // Set thinking from done event if available
          if (event.thinking && !messages.value[assistantIdx].thinking) {
            messages.value[assistantIdx].thinking = event.thinking
          }
          currentThinking.value = ''
          saveCurrentConversation()
        } else if (event.type === 'error') {
          isLoading.value = false
          toolStatus.value = ''
          currentThinking.value = ''
          if (cleanup) cleanup()
          messages.value[assistantIdx].content = `错误: ${event.error}`
        }
      })
      streamCleanup.value = cleanup

      // Send only user/assistant messages (not system)
      const chatMessages = messages.value.slice(0, -1).map(m => ({
        role: m.role,
        content: m.content
      }))
      await window.electronAPI.chatStream(chatMessages)

      // If stream finishes without a 'done' event
      if (isLoading.value) {
        isLoading.value = false
        if (!getMessageText(messages.value[assistantIdx])) {
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

          <!-- Thinking block (collapsible) -->
          <div v-if="msg.thinking" class="thinking-block">
            <div class="thinking-header" @click="toggleThinking(i)">
              <span class="thinking-icon">💭</span>
              <span class="thinking-label">思考过程</span>
              <span class="thinking-toggle">{{ expandedThinking[i] ? '▼' : '▶' }}</span>
            </div>
            <div v-if="expandedThinking[i]" class="thinking-content" v-html="renderMarkdown(msg.thinking)"></div>
          </div>

          <!-- User message with images -->
          <div v-if="msg.role === 'user'" class="message-content">
            <div v-if="getMessageImages(msg).length > 0" class="message-images">
              <img v-for="(imgUrl, idx) in getMessageImages(msg)" :key="idx" :src="imgUrl" class="message-image" />
            </div>
            <div v-html="renderMarkdown(getMessageText(msg))"></div>
          </div>

          <!-- Assistant message with markdown -->
          <div v-else class="message-content markdown-body" v-html="renderMarkdown(getMessageText(msg))"></div>
          <span v-if="isLoading && i === messages.length - 1 && msg.role === 'assistant'" class="cursor-blink">▍</span>
        </div>

        <div v-if="toolStatus" class="tool-status">
          🔧 {{ toolStatus }}
        </div>
      </div>

      <div class="chat-input">
        <!-- Image preview area -->
        <div v-if="pendingImages.length > 0" class="image-preview-bar">
          <div v-for="(img, idx) in pendingImages" :key="idx" class="image-preview-item">
            <img :src="img.base64" class="image-thumb" />
            <button class="image-remove" @click="removeImage(idx)">×</button>
          </div>
        </div>
        <div class="input-row">
          <label class="upload-btn" title="上传图片">
            📎
            <input type="file" accept="image/*" multiple hidden @change="handleImageUpload" />
          </label>
          <textarea
            v-model="inputText"
            placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            @keydown="handleKeydown"
            :disabled="isLoading"
            rows="3"
          />
          <button @click="sendMessage" :disabled="isLoading || (!inputText.trim() && pendingImages.length === 0)">
            {{ isLoading ? '...' : '发送' }}
          </button>
        </div>
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
  word-break: break-word;
  line-height: 1.6;
}

/* Markdown content styles */
.message-content :deep(p) {
  margin: 0.4em 0;
}

.message-content :deep(p:first-child) {
  margin-top: 0;
}

.message-content :deep(p:last-child) {
  margin-bottom: 0;
}

.message-content :deep(pre) {
  background: #18181b;
  border: 1px solid #3f3f46;
  border-radius: 8px;
  padding: 12px 16px;
  overflow-x: auto;
  font-size: 0.85em;
  line-height: 1.5;
  margin: 8px 0;
}

.message-content :deep(code) {
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  font-size: 0.9em;
}

.message-content :deep(:not(pre) > code) {
  background: #3f3f46;
  padding: 2px 6px;
  border-radius: 4px;
  color: #60a5fa;
}

.message-content :deep(ul),
.message-content :deep(ol) {
  padding-left: 1.5em;
  margin: 0.4em 0;
}

.message-content :deep(li) {
  margin: 0.2em 0;
}

.message-content :deep(h1),
.message-content :deep(h2),
.message-content :deep(h3),
.message-content :deep(h4) {
  margin: 0.6em 0 0.3em;
  line-height: 1.3;
}

.message-content :deep(h1) { font-size: 1.3em; }
.message-content :deep(h2) { font-size: 1.15em; }
.message-content :deep(h3) { font-size: 1.05em; }

.message-content :deep(blockquote) {
  border-left: 3px solid #3b82f6;
  padding-left: 12px;
  color: #a1a1aa;
  margin: 0.5em 0;
}

.message-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
  font-size: 0.9em;
}

.message-content :deep(th),
.message-content :deep(td) {
  border: 1px solid #3f3f46;
  padding: 6px 10px;
  text-align: left;
}

.message-content :deep(th) {
  background: #27272a;
  font-weight: 600;
}

.message-content :deep(a) {
  color: #60a5fa;
  text-decoration: none;
}

.message-content :deep(a:hover) {
  text-decoration: underline;
}

.message-content :deep(hr) {
  border: none;
  border-top: 1px solid #3f3f46;
  margin: 0.8em 0;
}

/* User message images */
.message-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.message-image {
  max-width: 200px;
  max-height: 200px;
  border-radius: 8px;
  object-fit: cover;
  border: 1px solid #3f3f46;
}

/* Thinking block */
.thinking-block {
  margin-bottom: 8px;
  border: 1px solid #3f3f46;
  border-radius: 8px;
  overflow: hidden;
  background: #1a1a2e;
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 0.82em;
  color: #a78bfa;
  user-select: none;
}

.thinking-header:hover {
  background: #1e1e35;
}

.thinking-icon {
  font-size: 1em;
}

.thinking-label {
  flex: 1;
  font-weight: 500;
}

.thinking-toggle {
  font-size: 0.7em;
  color: #71717a;
}

.thinking-content {
  padding: 8px 12px;
  border-top: 1px solid #27272a;
  font-size: 0.82em;
  color: #a1a1aa;
  line-height: 1.5;
  max-height: 300px;
  overflow-y: auto;
}

.thinking-content :deep(p) {
  margin: 0.3em 0;
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

/* Chat input */
.chat-input {
  padding: 12px 24px 16px;
  border-top: 1px solid #27272a;
}

.image-preview-bar {
  display: flex;
  gap: 8px;
  padding-bottom: 8px;
  flex-wrap: wrap;
}

.image-preview-item {
  position: relative;
  display: inline-block;
}

.image-thumb {
  width: 60px;
  height: 60px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid #3f3f46;
}

.image-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #ef4444;
  color: white;
  border: none;
  font-size: 0.7em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.input-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

.upload-btn {
  padding: 10px 8px;
  cursor: pointer;
  font-size: 1.2em;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
  flex-shrink: 0;
}

.upload-btn:hover {
  background: #27272a;
}

.input-row textarea {
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

.input-row textarea:focus {
  outline: none;
  border-color: #3b82f6;
}

.input-row button {
  padding: 10px 20px;
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 0.9em;
  cursor: pointer;
  flex-shrink: 0;
}

.input-row button:hover:not(:disabled) {
  background: #2563eb;
}

.input-row button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
