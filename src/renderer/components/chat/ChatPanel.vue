<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
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
  targetProjectId?: string
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

interface ProvidersConfig {
  providers: ProviderOption[]
  activeProviderId: string
  enabledProviderIds: string[]
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
/** The project being edited/optimized in this conversation. */
const targetProjectId = ref<string | null>(null)
const providers = ref<ProviderOption[]>([])
const providersConfig = ref<ProvidersConfig>({
  providers: [],
  activeProviderId: '',
  enabledProviderIds: []
})
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
const syncingProviderOptions = ref(false)

const streamingConvIds = reactive(new Set<string>())
const backgroundStreamMessages = new Map<string, { messages: ChatMessage[]; assistantIdx: number; targetProjectId: string | null }>()
const activeCleanups = new Map<string, () => void>()
const conversationTargets = new Map<string, string | null>()
let providerChangeCleanup: (() => void) | null = null

function getEnabledProviders (config: ProvidersConfig): ProviderOption[] {
  const enabledIds = new Set(
    (config.enabledProviderIds.length > 0 ? config.enabledProviderIds : [config.activeProviderId])
      .filter(Boolean)
  )
  const enabledProviders = config.providers.filter(provider => enabledIds.has(provider.id))
  return enabledProviders.length > 0 ? enabledProviders : config.providers
}

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

function hasRenderableContent (msg: ChatMessage): boolean {
  if (typeof msg.content === 'string') {
    return msg.content.trim().length > 0
  }

  return msg.content.some(part => {
    if (part.type === 'text') {
      return Boolean(part.text?.trim())
    }
    return Boolean(part.image_url?.url)
  })
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

function setConversationTarget (convId: string, projectId: string | null | undefined) {
  if (!projectId) {
    conversationTargets.delete(convId)
    return
  }
  conversationTargets.set(convId, projectId)
}

function getConversationTarget (convId: string | null | undefined): string | null {
  if (!convId) return null
  return conversationTargets.get(convId) ?? null
}

function getConversationCreatedAt (convId: string): string {
  return conversations.value.find(conversation => conversation.id === convId)?.createdAt || new Date().toISOString()
}

function stashCurrentConversationForNavigation () {
  if (currentConversationId.value && streamingConvIds.has(currentConversationId.value)) {
    backgroundStreamMessages.set(currentConversationId.value, {
      messages: messages.value,
      assistantIdx: messages.value.length - 1,
      targetProjectId: targetProjectId.value
    })
    void doSaveConversation(currentConversationId.value, messages.value, { targetProjectId: targetProjectId.value })
  }
}

async function startOptimizationConversation (ctx: Record<string, unknown>) {
  const projectId = typeof ctx.id === 'string' ? ctx.id : null
  const name = String(ctx.name || ctx.id || '未知项目')
  const conversationId = generateId()

  stashCurrentConversationForNavigation()

  currentConversationId.value = conversationId
  messages.value = []
  targetProjectId.value = projectId
  inputText.value = `请帮我继续优化项目"${name}"（项目ID: ${ctx.id}）。请先查看项目当前的代码结构，然后告诉我可以改进的地方。`
  pendingImages.value = []
  resetTransientStreamState()
  setConversationTarget(conversationId, projectId)

  await doSaveConversation(conversationId, [], {
    titleOverride: `优化 · ${name}`,
    targetProjectId: projectId
  })
}

async function persistProviderModelSelection () {
  if (!window.electronAPI || !activeProviderId.value) return
  const providerIndex = providersConfig.value.providers.findIndex(provider => provider.id === activeProviderId.value)
  if (providerIndex < 0) return

  const nextProviders = providersConfig.value.providers.map((provider, index) => {
    if (index !== providerIndex) {
      return provider
    }
    return {
      ...provider,
      activeModel: selectedModel.value || provider.activeModel || provider.models[0] || ''
    }
  })

  providersConfig.value = {
    ...providersConfig.value,
    providers: nextProviders
  }
  providers.value = getEnabledProviders(providersConfig.value)
  await window.electronAPI.saveProviders(JSON.parse(JSON.stringify({
    providers: nextProviders,
    activeProviderId: providersConfig.value.activeProviderId,
    enabledProviderIds: providersConfig.value.enabledProviderIds
  })))
}

async function applyProvidersConfig (
  config: ProvidersConfig,
  preferredProviderId?: string | null
) {
  syncingProviderOptions.value = true
  providersConfig.value = {
    providers: config.providers.map(provider => ({ ...provider })),
    activeProviderId: config.activeProviderId,
    enabledProviderIds: [...config.enabledProviderIds]
  }
  providers.value = getEnabledProviders(providersConfig.value)

  const candidateIds = [
    preferredProviderId,
    currentConversationId.value ? conversations.value.find(item => item.id === currentConversationId.value)?.providerId : null,
    activeProviderId.value,
    config.activeProviderId
  ]

  const nextProviderId = candidateIds.find(id => id && providers.value.some(provider => provider.id === id))
    || providers.value[0]?.id
    || ''

  activeProviderId.value = nextProviderId
  const active = providers.value.find(provider => provider.id === nextProviderId)
  selectedModel.value = active?.activeModel || active?.models[0] || ''

  await nextTick()
  syncingProviderOptions.value = false
}

async function persistConversationProviderMeta () {
  if (!currentConversationId.value) return
  await doSaveConversation(currentConversationId.value, messages.value, {
    targetProjectId: targetProjectId.value,
    allowEmpty: true
  })
}

async function handleProviderSelectionChange (providerId: string) {
  activeProviderId.value = providerId
  const provider = providers.value.find(item => item.id === providerId)
  selectedModel.value = provider?.activeModel || provider?.models[0] || ''

  if (syncingProviderOptions.value) return
  await persistConversationProviderMeta()
}

async function handleModelSelectionChange (model: string) {
  selectedModel.value = model
  if (syncingProviderOptions.value) return
  await persistProviderModelSelection()
  await persistConversationProviderMeta()
}

async function loadConversations () {
  if (!window.electronAPI) return
  try {
    conversations.value = await window.electronAPI.listConversations()
  } catch { /* ignore */ }
}

async function loadProviders (preferredProviderId?: string | null) {
  if (!window.electronAPI) return
  try {
    const config = await window.electronAPI.getProviders()
    await applyProvidersConfig(config, preferredProviderId)
  } catch { /* ignore */ }
}

function newConversation () {
  stashCurrentConversationForNavigation()

  currentConversationId.value = null
  messages.value = []
  targetProjectId.value = null
  inputText.value = ''
  resetTransientStreamState()
  pendingImages.value = []
}

async function loadConversation (id: string) {
  if (!window.electronAPI) return

  if (currentConversationId.value && currentConversationId.value !== id) {
    stashCurrentConversationForNavigation()
  }

  const bg = backgroundStreamMessages.get(id)
  if (bg) {
    currentConversationId.value = id
    messages.value = bg.messages
    targetProjectId.value = bg.targetProjectId
    setConversationTarget(id, bg.targetProjectId)
    backgroundStreamMessages.delete(id)
    resetTransientStreamState()
    await loadProviders(conversations.value.find(item => item.id === id)?.providerId || null)
    return
  }

  const conv = await window.electronAPI.getConversation(id)
  if (conv) {
    currentConversationId.value = conv.id
    messages.value = conv.messages
    targetProjectId.value = conv.targetProjectId || null
    setConversationTarget(conv.id, conv.targetProjectId || null)
    resetTransientStreamState()
    await loadProviders(conv.providerId || null)
  }
}

async function doSaveConversation (
  convId: string,
  msgs: ChatMessage[],
  options?: { titleOverride?: string; targetProjectId?: string | null; allowEmpty?: boolean }
) {
  if (!window.electronAPI) return
  const existingConversation = conversations.value.find(conversation => conversation.id === convId)
  if (msgs.length === 0 && !options?.titleOverride && !options?.allowEmpty && !existingConversation) return

  const firstUserMsg = msgs.find(m => m.role === 'user')
  const titleText = firstUserMsg ? getMessageText(firstUserMsg) : ''
  const resolvedTitle = options?.titleOverride || (titleText
    ? (titleText.length > 40 ? titleText.substring(0, 40) + '...' : titleText)
    : (existingConversation?.title || '新对话'))
  const resolvedTargetProjectId = options && Object.prototype.hasOwnProperty.call(options, 'targetProjectId')
    ? (options.targetProjectId ?? null)
    : getConversationTarget(convId)

  setConversationTarget(convId, resolvedTargetProjectId)

  await window.electronAPI.saveConversation(JSON.parse(JSON.stringify({
    id: convId,
    title: resolvedTitle,
    messages: msgs,
    createdAt: getConversationCreatedAt(convId),
    updatedAt: new Date().toISOString(),
    providerId: activeProviderId.value || undefined,
    targetProjectId: resolvedTargetProjectId || undefined
  })))

  await loadConversations()
}

async function deleteConversation (id: string) {
  if (!window.electronAPI) return
  await window.electronAPI.deleteConversation(id)
  conversationTargets.delete(id)
  backgroundStreamMessages.delete(id)
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
      await persistProviderModelSelection()

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
          if (event.message?.content !== undefined) {
            if (Array.isArray(event.message.content)) {
              targetMessages[assistantIdx].content = event.message.content
            } else if (!getMessageText(targetMessages[assistantIdx]) && event.message.content) {
              targetMessages[assistantIdx].content = event.message.content
            }
          }
          if (!hasRenderableContent(targetMessages[assistantIdx])) {
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
      await window.electronAPI.chatStream(
        chatMessages,
        sessionId,
        activeProviderId.value || undefined,
        targetProjectId.value ?? undefined
      )

      if (streamingConvIds.has(convId)) {
        streamingConvIds.delete(convId)
        backgroundStreamMessages.delete(convId)
        const pendingCleanup = activeCleanups.get(sessionId)
        if (pendingCleanup) {
          pendingCleanup()
          activeCleanups.delete(sessionId)
        }
        if (!hasRenderableContent(targetMessages[assistantIdx])) {
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
  if (!ctx) return

  void startOptimizationConversation(ctx).finally(() => {
    emit('contextConsumed')
  })
}, { immediate: true })

onMounted(async () => {
  await loadConversations()
  await loadProviders()
  await loadSkills()

  if (window.electronAPI?.onProvidersChanged) {
    providerChangeCleanup = window.electronAPI.onProvidersChanged((config) => {
      void applyProvidersConfig(config)
    })
  }
})

onUnmounted(() => {
  for (const cleanup of activeCleanups.values()) {
    cleanup()
  }
  activeCleanups.clear()
  providerChangeCleanup?.()
  providerChangeCleanup = null
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
        @update:active-provider-id="handleProviderSelectionChange"
        @update:selected-model="handleModelSelectionChange"
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