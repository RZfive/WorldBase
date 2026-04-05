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

interface FilePreviewState {
  active: boolean
  filePath: string
  content: string
  truncated: boolean
}

interface SkillItem {
  id: string
  name: string
  description?: string
  content?: string
}

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
const filePreview = ref<FilePreviewState>({
  active: false,
  filePath: '',
  content: '',
  truncated: false
})

const availableSkills = ref<SkillItem[]>([])
const activeSkillIds = ref<Set<string>>(new Set())
const showSkillPicker = ref(false)

const streamingConvIds = reactive(new Set<string>())
const backgroundStreamMessages = new Map<string, { messages: ChatMessage[]; assistantIdx: number }>()
const activeCleanups = new Map<string, () => void>()

const isLoading = computed(() => {
  return currentConversationId.value ? streamingConvIds.has(currentConversationId.value) : false
})

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
  void syncActiveSkills()
}

async function syncActiveSkills () {
  if (!window.electronAPI?.setActiveSkills) return
  try {
    await window.electronAPI.setActiveSkills(Array.from(activeSkillIds.value))
  } catch { /* ignore */ }
}

function generateId (): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  const randomBytes = new Uint32Array(2)
  globalThis.crypto.getRandomValues(randomBytes)
  return `${Date.now().toString(36)}_${Array.from(randomBytes, value => value.toString(36)).join('')}`
}

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

function resetTransientStreamState () {
  toolStatus.value = ''
  progressSteps.value = []
  currentThinking.value = ''
  filePreview.value = {
    active: false,
    filePath: '',
    content: '',
    truncated: false
  }
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
  await window.electronAPI.saveProviders(JSON.parse(JSON.stringify({
    providers: nextProviders,
    activeProviderId: activeProviderId.value
  })))
}

async function loadConversations () {
  if (!window.electronAPI) return
  try {
    conversations.value = await window.electronAPI.listConversations()
  } catch { /* ignore */ }
}

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

function newConversation () {
  if (currentConversationId.value && streamingConvIds.has(currentConversationId.value)) {
    backgroundStreamMessages.set(currentConversationId.value, {
      messages: messages.value,
      assistantIdx: messages.value.length - 1
    })
    void doSaveConversation(currentConversationId.value, messages.value)
  }

  currentConversationId.value = null
  messages.value = []
  resetTransientStreamState()
  pendingImages.value = []
}

async function loadConversation (id: string) {
  if (!window.electronAPI) return

  if (currentConversationId.value && currentConversationId.value !== id && streamingConvIds.has(currentConversationId.value)) {
    backgroundStreamMessages.set(currentConversationId.value, {
      messages: messages.value,
      assistantIdx: messages.value.length - 1
    })
    void doSaveConversation(currentConversationId.value, messages.value)
  }

  const bg = backgroundStreamMessages.get(id)
  if (bg) {
    currentConversationId.value = id
    messages.value = bg.messages
    backgroundStreamMessages.delete(id)
    resetTransientStreamState()
    return
  }

  const conv = await window.electronAPI.getConversation(id)
  if (conv) {
    currentConversationId.value = conv.id
    messages.value = conv.messages
    resetTransientStreamState()
  }
}

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

async function sendMessage () {
  const text = inputText.value.trim()
  if ((!text && pendingImages.value.length === 0) || isLoading.value) return

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
  resetTransientStreamState()

  messages.value.push({ role: 'assistant', content: '', thinking: '' })

  const targetMessages = messages.value
  const assistantIdx = targetMessages.length - 1
  const sessionId = generateId()
  let thinkingAccum = ''

  streamingConvIds.add(convId)

  try {
    if (window.electronAPI) {
      await persistProviderSelection()

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
            resetTransientStreamState()
          }
        } else if (event.type === 'token' && event.content) {
          targetMessages[assistantIdx].content =
            ((targetMessages[assistantIdx].content as string) || '') + event.content
        } else if (event.type === 'file_preview_start' && event.filePath) {
          if (isForeground) {
            filePreview.value = {
              active: true,
              filePath: event.filePath,
              content: '',
              truncated: Boolean(event.truncated)
            }
          }
        } else if (event.type === 'file_preview_chunk' && event.content) {
          if (isForeground && filePreview.value.filePath === event.filePath) {
            filePreview.value = {
              ...filePreview.value,
              content: filePreview.value.content + event.content
            }
          }
        } else if (event.type === 'file_preview_end') {
          if (isForeground) {
            filePreview.value = {
              ...filePreview.value,
              active: false,
              truncated: Boolean(event.truncated ?? filePreview.value.truncated)
            }
          }
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
          if (!getMessageText(targetMessages[assistantIdx]) && event.message?.content) {
            targetMessages[assistantIdx].content = event.message.content
          }
          if (!getMessageText(targetMessages[assistantIdx])) {
            targetMessages[assistantIdx].content = '(无响应)'
          }
          if (event.thinking && !targetMessages[assistantIdx].thinking) {
            targetMessages[assistantIdx].thinking = event.thinking
          }

          cleanup()
          activeCleanups.delete(sessionId)
          streamingConvIds.delete(convId)
          backgroundStreamMessages.delete(convId)

          void doSaveConversation(convId, targetMessages)

          if (isForeground) {
            resetTransientStreamState()
          }
        } else if (event.type === 'error') {
          targetMessages[assistantIdx].content = `错误: ${event.error}`

          cleanup()
          activeCleanups.delete(sessionId)
          streamingConvIds.delete(convId)
          backgroundStreamMessages.delete(convId)

          if (isForeground) {
            resetTransientStreamState()
          }
        }
      })

      activeCleanups.set(sessionId, cleanup)

      const chatMessages = JSON.parse(JSON.stringify(targetMessages.slice(0, -1).map(m => ({
        role: m.role,
        content: m.content
      }))))
      await window.electronAPI.chatStream(chatMessages, sessionId)

      if (streamingConvIds.has(convId)) {
        streamingConvIds.delete(convId)
        backgroundStreamMessages.delete(convId)
        const pendingCleanup = activeCleanups.get(sessionId)
        if (pendingCleanup) {
          pendingCleanup()
          activeCleanups.delete(sessionId)
        }
        if (!getMessageText(targetMessages[assistantIdx])) {
          targetMessages[assistantIdx].content = '(无响应)'
        }
        void doSaveConversation(convId, targetMessages)
        if (currentConversationId.value === convId) {
          resetTransientStreamState()
        }
      }
    } else {
      const chatMessages = JSON.parse(JSON.stringify(targetMessages.slice(0, -1).map(m => ({ role: m.role, content: m.content }))))
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatMessages })
      })
      const response = await res.json() as { content?: string }
      targetMessages[assistantIdx].content = response.content || '(无响应)'
      streamingConvIds.delete(convId)
      void doSaveConversation(convId, targetMessages)
      resetTransientStreamState()
    }
  } catch (err) {
    targetMessages[assistantIdx].content = `错误: ${(err as Error).message}`
    streamingConvIds.delete(convId)
    resetTransientStreamState()
  }
}

watch(activeProviderId, (newId) => {
  const provider = providers.value.find(item => item.id === newId)
  if (provider) {
    selectedModel.value = provider.activeModel || provider.models[0] || ''
  }
})

watch(() => props.projectContext, (ctx) => {
  if (ctx) {
    const name = (ctx.name || ctx.id || '未知项目') as string
    inputText.value = `请帮我继续优化项目"${name}"（项目ID: ${ctx.id}）。请先查看项目当前的代码结构，然后告诉我可以改进的地方。`
    emit('contextConsumed')
  }
}, { immediate: true })

onMounted(async () => {
  await loadConversations()
  await loadProviders()
  await loadSkills()
})

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
        :file-preview="filePreview"
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

.chat-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
</style>