<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { renderMarkdown } from './markdown'

interface ChatMessage {
  role: string
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  thinking?: string
}

const props = defineProps<{
  messages: ChatMessage[]
  isLoading: boolean
  toolStatus: string
  progressSteps: Array<{ stage: string; detail?: string }>
}>()

const messagesContainer = ref<HTMLElement | null>(null)
const streamingLineRef = ref<HTMLElement | null>(null)
const progressLineRef = ref<HTMLElement | null>(null)
const expandedThinking = ref<Record<number, boolean>>({})

const latestProgressText = computed(() => {
  const latest = props.progressSteps[props.progressSteps.length - 1]
  if (!latest) return ''
  return latest.detail ? `${latest.stage} ${latest.detail}` : latest.stage
})

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

function getMessageImages (msg: ChatMessage): string[] {
  if (!Array.isArray(msg.content)) return []
  return msg.content
    .filter(p => p.type === 'image_url' && p.image_url?.url)
    .map(p => p.image_url!.url)
}

function collapseWhitespace (text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function toggleThinking (index: number) {
  expandedThinking.value[index] = !expandedThinking.value[index]
}

function scrollToBottom () {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// Auto-scroll when a new message is added
watch(() => props.messages.length, scrollToBottom)

// Auto-scroll and scroll streaming line when last message content changes
watch(
  () => {
    const last = props.messages[props.messages.length - 1]
    return last?.content
  },
  () => {
    scrollToBottom()
    nextTick(() => {
      if (streamingLineRef.value) {
        streamingLineRef.value.scrollLeft = streamingLineRef.value.scrollWidth
      }
    })
  }
)

// Auto-scroll progress line when a new progress step arrives
watch(
  () => props.progressSteps.length,
  () => {
    nextTick(() => {
      if (progressLineRef.value) {
        progressLineRef.value.scrollLeft = progressLineRef.value.scrollWidth
      }
    })
  }
)
</script>

<template>
  <div class="chat-messages" ref="messagesContainer">
    <div v-if="props.messages.length === 0" class="empty-state">
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
      v-for="(msg, i) in props.messages"
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

      <!-- Assistant message: streaming -->
      <div
        v-else-if="props.isLoading && i === props.messages.length - 1"
        ref="streamingLineRef"
        class="message-content streaming-line"
      >
        {{ collapseWhitespace(getMessageText(msg)) || 'AI 正在生成内容…' }}
      </div>
      <!-- Assistant message: rendered markdown -->
      <div v-else class="message-content markdown-body" v-html="renderMarkdown(getMessageText(msg))"></div>
      <span v-if="props.isLoading && i === props.messages.length - 1 && msg.role === 'assistant'" class="cursor-blink">▍</span>
    </div>

    <div v-if="props.toolStatus || props.progressSteps.length > 0" class="tool-progress-panel">
      <div v-if="props.toolStatus" class="tool-status-header">
        <span class="tool-status-icon">🔧</span>
        <span class="tool-status-text">{{ props.toolStatus }}</span>
        <span class="tool-status-spinner"></span>
      </div>
      <div v-if="props.progressSteps.length > 0" class="progress-steps">
        <div ref="progressLineRef" class="progress-step step-latest">
          {{ latestProgressText }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

.streaming-line {
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  scrollbar-width: none;
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
}

.streaming-line::-webkit-scrollbar {
  display: none;
}

/* Markdown content styles */
.message-content :deep(p) { margin: 0.4em 0; }
.message-content :deep(p:first-child) { margin-top: 0; }
.message-content :deep(p:last-child) { margin-bottom: 0; }

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

.message-content :deep(li) { margin: 0.2em 0; }

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

.message-content :deep(a) { color: #60a5fa; text-decoration: none; }
.message-content :deep(a:hover) { text-decoration: underline; }

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

.thinking-header:hover { background: #1e1e35; }
.thinking-icon { font-size: 1em; }
.thinking-label { flex: 1; font-weight: 500; }
.thinking-toggle { font-size: 0.7em; color: #71717a; }

.thinking-content {
  padding: 8px 12px;
  border-top: 1px solid #27272a;
  font-size: 0.82em;
  color: #a1a1aa;
  line-height: 1.5;
  max-height: 300px;
  overflow-y: auto;
}

.thinking-content :deep(p) { margin: 0.3em 0; }

.cursor-blink {
  animation: blink 0.8s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* Tool progress panel */
.tool-progress-panel {
  margin: 8px 0;
  background: #1a1a2e;
  border: 1px solid #27272a;
  border-radius: 10px;
  overflow: hidden;
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.tool-status-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 0.82em;
  color: #60a5fa;
  border-bottom: 1px solid #27272a;
}

.tool-status-icon { flex-shrink: 0; }
.tool-status-text { flex: 1; }

.tool-status-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid #3f3f46;
  border-top-color: #60a5fa;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.progress-steps { padding: 6px 0; }

.progress-step {
  display: block;
  padding: 3px 14px;
  font-size: 0.78em;
  color: #71717a;
  animation: stepSlideIn 0.25s ease;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  scrollbar-width: none;
}

.progress-step::-webkit-scrollbar { display: none; }

.progress-step.step-latest { color: #a1a1aa; }

@keyframes stepSlideIn {
  from { opacity: 0; transform: translateX(-8px); }
  to { opacity: 1; transform: translateX(0); }
}
</style>
