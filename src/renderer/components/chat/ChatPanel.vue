<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import ConversationSidebar from './ConversationSidebar.vue'
import MessageList from './MessageList.vue'
import ChatInput from './ChatInput.vue'
import ChatHeader from './ChatHeader.vue'

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
  baseUrl: string
  apiKey: string
  models: string[]
  modelContextWindows?: Record<string, number>
  activeModel: string
  enableThinking?: boolean
}

// State
const props = defineProps<{
  projectContext?: Record<string, unknown> | null
}>()

const emit = defineEmits<{
  (e: 'contextConsumed'): void
}>()

const messages = ref<ChatMessage[]>([])
const inputText = ref('')
const conversations = ref<ConversationSummary[]>([])
const currentConversationId = ref<string | null>(null)
const providers = ref<ProviderOption[]>([])
const activeProviderId = ref('')
const selectedModel = ref('')
const toolStatus = ref('')
const progressSteps = ref<Array<{ stage: string; detail?: string }>>([])
const pendingImages = ref<Array<{ base64: string; mimeType: string }>>([])
const currentThinking = ref('')

// --- Skill selector state ---
interface SkillItem { id: string; name: string; description?: string; content?: string }
const availableSkills = ref<SkillItem[]>([])
const activeSkillIds = ref<Set<string>>(new Set())
const showSkillPicker = ref(false)

async function loadSkills () {
  if (!window.electronAPI?.listSkills) return
  try {
    availableSkills.value = await window.electronAPI.listSkills() as SkillItem[]
  } catch { /* ignore */ }
}

function toggleSkill (id: string) {
  if (activeSkillIds.value.has(id)) {
    activeSkillIds.value.delete(id)
  } else {
    activeSkillIds.value.add(id)
  }
  // Sync to AI engine
  syncActiveSkills()
}

async function syncActiveSkills () {
  if (!window.electronAPI?.setActiveSkills) return
  try {
    await window.electronAPI.setActiveSkills(Array.from(activeSkillIds.value))
  } catch { /* ignore */ }
}

// --- Concurrent stream tracking ---
// Set of conversation IDs that are currently streaming
const streamingConvIds = reactive(new Set<string>())
// Background stream state: messages array for conversations that are streaming in background
const backgroundStreamMessages = new Map<string, { messages: ChatMessage[]; assistantIdx: number }>()
// Active cleanup functions keyed by sessionId
const activeCleanups = new Map<string, () => void>()
// Whether the CURRENT conversation is streaming
const isLoading = computed(() => {
  return currentConversationId.value ? streamingConvIds.has(currentConversationId.value) : false
})

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

async function persistProviderSelection () {
  if (!window.electronAPI || !activeProviderId.value) return
  const providerIndex = providers.value.findIndex(provider => provider.id === activeProviderId.value)
  if (providerIndex < 0) return

  const nextProviders = providers.value.map((provider, index) => {
    if (index !== providerIndex) {
      return provider
    }
    return {
      ...provider,
      activeModel: selectedModel.value || provider.activeModel || provider.models[0] || ''
    }
  })

  providers.value = nextProviders
  // Use JSON round-trip to strip Vue reactive proxies before IPC
  await window.electronAPI.saveProviders(JSON.parse(JSON.stringify({
    providers: nextProviders,
    activeProviderId: activeProviderId.value
  })))
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
    providers.value = config.providers.map(p => ({ ...p }))
    activeProviderId.value = config.activeProviderId
    const active = providers.value.find(p => p.id === activeProviderId.value)
    if (active) {
      selectedModel.value = active.activeModel
    }
  } catch { /* ignore */ }
}

// Start a new conversation
function newConversation () {
  // If current conversation is streaming, move it to background
  if (currentConversationId.value && streamingConvIds.has(currentConversationId.value)) {
    backgroundStreamMessages.set(currentConversationId.value, {
      messages: messages.value,
      assistantIdx: messages.value.length - 1
    })
    // Save progress so far
    doSaveConversation(currentConversationId.value, messages.value)
  }
  currentConversationId.value = null
  messages.value = []
  toolStatus.value = ''
  progressSteps.value = []
  pendingImages.value = []
  currentThinking.value = ''
}

// Load a conversation
async function loadConversation (id: string) {
  if (!window.electronAPI) return

  // If switching away from a streaming conversation, move it to background
  if (currentConversationId.value && currentConversationId.value !== id && streamingConvIds.has(currentConversationId.value)) {
    backgroundStreamMessages.set(currentConversationId.value, {
      messages: messages.value,
      assistantIdx: messages.value.length - 1
    })
    doSaveConversation(currentConversationId.value, messages.value)
  }

  // Check if target conversation has a background stream — restore it
  const bg = backgroundStreamMessages.get(id)
  if (bg) {
    currentConversationId.value = id
    messages.value = bg.messages
    backgroundStreamMessages.delete(id)
    toolStatus.value = ''
    progressSteps.value = []
    currentThinking.value = ''
    return
  }

  // Normal load from disk
  const conv = await window.electronAPI.getConversation(id)
  if (conv) {
    currentConversationId.value = conv.id
    messages.value = conv.messages
    toolStatus.value = ''
    progressSteps.value = []
    currentThinking.value = ''
  }
}

// Save a conversation by explicit ID and messages array
async function doSaveConversation (convId: string, msgs: ChatMessage[]) {
  if (!window.electronAPI) return
  if (msgs.length === 0) return

  const firstUserMsg = msgs.find(m => m.role === 'user')
  const titleText = firstUserMsg ? getMessageText(firstUserMsg) : ''
  const title = titleText
    ? (titleText.length > 40 ? titleText.substring(0, 40) + '...' : titleText)
    : '新对话'

  await window.electronAPI.saveConversation(JSON.parse(JSON.stringify({
    id: convId,
    title,
    messages: msgs,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    providerId: activeProviderId.value || undefined
  })))

  await loadConversations()
}

// Delete a conversation
async function deleteConversation (id: string) {
  if (!window.electronAPI) return
  await window.electronAPI.deleteConversation(id)
  if (currentConversationId.value === id) {
    newConversation()
  }
  await loadConversations()
}

function addImage (base64: string, mimeType: string) {
  pendingImages.value.push({ base64, mimeType })
}

function removeImage (index: number) {
  pendingImages.value.splice(index, 1)
}

// Send message with streaming (supports concurrent background streams)
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

  const convId = currentConversationId.value || generateId()
  currentConversationId.value = convId

  messages.value.push({ role: 'user', content: messageContent })
  inputText.value = ''
  pendingImages.value = []
  toolStatus.value = ''
  progressSteps.value = []
  currentThinking.value = ''

  // Add placeholder assistant message
  messages.value.push({ role: 'assistant', content: '', thinking: '' })

  // Capture state for the stream callback closure
  const targetMessages = messages.value
  const assistantIdx = targetMessages.length - 1
  const sessionId = generateId()
  let thinkingAccum = ''

  // Mark this conversation as streaming
  streamingConvIds.add(convId)

  try {
    if (window.electronAPI) {
      await persistProviderSelection()
      // Set up per-session stream listener
      const cleanup = window.electronAPI.onStreamEvent(sessionId, (event) => {
        const isForeground = currentConversationId.value === convId

        if (event.type === 'thinking' && event.content) {
          thinkingAccum += event.content
          targetMessages[assistantIdx].thinking = thinkingAccum
          if (isForeground) {
            currentThinking.value = thinkingAccum
          }
        } else if (event.type === 'reset') {
          thinkingAccum = ''
          targetMessages[assistantIdx].content = ''
          targetMessages[assistantIdx].thinking = ''
          if (isForeground) {
            currentThinking.value = ''
          }
        } else if (event.type === 'token' && event.content) {
          targetMessages[assistantIdx].content =
            ((targetMessages[assistantIdx].content as string) || '') + event.content
        } else if (event.type === 'tool_start' && event.name) {
          if (isForeground) {
            toolStatus.value = `正在执行: ${event.name}...`
            progressSteps.value = []
          }
        } else if (event.type === 'progress' && event.stage) {
          if (isForeground) {
            progressSteps.value.push({ stage: event.stage, detail: event.detail })
          }
        } else if (event.type === 'tool_end') {
          if (isForeground) {
            toolStatus.value = ''
            progressSteps.value = []
          }
        } else if (event.type === 'done') {
          // Finalize content
          if (!getMessageText(targetMessages[assistantIdx]) && event.message?.content) {
            targetMessages[assistantIdx].content = event.message.content
          }
          if (!getMessageText(targetMessages[assistantIdx])) {
            targetMessages[assistantIdx].content = '(无响应)'
          }
          if (event.thinking && !targetMessages[assistantIdx].thinking) {
            targetMessages[assistantIdx].thinking = event.thinking
          }

          // Cleanup
          cleanup()
          activeCleanups.delete(sessionId)
          streamingConvIds.delete(convId)
          backgroundStreamMessages.delete(convId)

          // Auto-save
          doSaveConversation(convId, targetMessages)

          if (isForeground) {
            toolStatus.value = ''
            progressSteps.value = []
            currentThinking.value = ''
          }
        } else if (event.type === 'error') {
          targetMessages[assistantIdx].content = `错误: ${event.error}`

          cleanup()
          activeCleanups.delete(sessionId)
          streamingConvIds.delete(convId)
          backgroundStreamMessages.delete(convId)

          if (isForeground) {
            toolStatus.value = ''
            progressSteps.value = []
            currentThinking.value = ''
          }
        }
      })

      activeCleanups.set(sessionId, cleanup)

      // Send only user/assistant messages (not the placeholder)
      // Use JSON round-trip to strip Vue reactive proxies before IPC
      const chatMessages = JSON.parse(JSON.stringify(targetMessages.slice(0, -1).map(m => ({
        role: m.role,
        content: m.content
      }))))
      await window.electronAPI.chatStream(chatMessages, sessionId)

      // Safety fallback: if stream finished without a 'done' event
      if (streamingConvIds.has(convId)) {
        streamingConvIds.delete(convId)
        backgroundStreamMessages.delete(convId)
        const pendingCleanup = activeCleanups.get(sessionId)
        if (pendingCleanup) { pendingCleanup(); activeCleanups.delete(sessionId) }
        if (!getMessageText(targetMessages[assistantIdx])) {
          targetMessages[assistantIdx].content = '(无响应)'
        }
        doSaveConversation(convId, targetMessages)
      }
    } else {
      // HTTP fallback (non-streaming)
      const chatMessages = JSON.parse(JSON.stringify(targetMessages.slice(0, -1).map(m => ({ role: m.role, content: m.content }))))
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatMessages })
      })
      const response = await res.json() as { content?: string }
      targetMessages[assistantIdx].content = response.content || '(无响应)'
      streamingConvIds.delete(convId)
      doSaveConversation(convId, targetMessages)
    }
  } catch (err) {
    targetMessages[assistantIdx].content = `错误: ${(err as Error).message}`
    streamingConvIds.delete(convId)
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
  await loadSkills()
})

// Watch for project context changes (e.g. "continue optimizing this app")
watch(() => props.projectContext, (ctx) => {
  if (ctx) {
    const name = (ctx.name || ctx.id || '未知项目') as string
    inputText.value = `请帮我继续优化项目"${name}"（项目ID: ${ctx.id}）。请先查看项目当前的代码结构，然后告诉我可以改进的地方。`
    emit('contextConsumed')
  }
}, { immediate: true })

onUnmounted(() => {
  for (const cleanup of activeCleanups.values()) {
    cleanup()
  }
  activeCleanups.clear()
})
</script>

<template>
  <div class="chat-layout">
    <ConversationSidebar
      :conversations="conversations"
      :current-conversation-id="currentConversationId"
      :streaming-conv-ids="streamingConvIds"
      @new-conversation="newConversation"
      @select-conversation="loadConversation"
      @delete-conversation="deleteConversation"
    />

    <div class="chat-panel">
      <ChatHeader
        :providers="providers"
        :active-provider-id="activeProviderId"
        :selected-model="selectedModel"
        :available-skills="availableSkills"
        :active-skill-ids="activeSkillIds"
        :show-skill-picker="showSkillPicker"
        @update:active-provider-id="activeProviderId = $event"
        @update:selected-model="selectedModel = $event"
        @toggle-skill-picker="showSkillPicker = !showSkillPicker"
        @toggle-skill="toggleSkill"
      />

      <MessageList
        :messages="messages"
        :is-loading="isLoading"
        :tool-status="toolStatus"
        :progress-steps="progressSteps"
      />

      <ChatInput
        v-model="inputText"
        :is-loading="isLoading"
        :pending-images="pendingImages"
        :available-skills="availableSkills"
        :active-skill-ids="activeSkillIds"
        @send="sendMessage"
        @add-image="addImage"
        @remove-image="removeImage"
        @toggle-skill="toggleSkill"
      />
    </div>
  </div>
</template>

<style scoped>
.chat-layout {
  display: flex;
  height: 100%;
}

/* Chat panel column */
.chat-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
</style>
