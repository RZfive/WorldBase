<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import ConversationSidebar from './ConversationSidebar.vue'
import MessageList from './MessageList.vue'
import ChatInput from './ChatInput.vue'
import ChatHeader from './ChatHeader.vue'

type MessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>

type ChatMessageBlock =
  | { id: string; kind: 'content'; content: MessageContent }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; toolRun: ToolRun }
  | { id: string; kind: 'file_preview'; filePath: string; previewContent: string; truncated: boolean; active: boolean }
  | { id: string; kind: 'attachment'; fileName: string; fileType: string; fileSizeLabel: string; previewText: string }
  | { id: string; kind: 'auth_request'; requestId: string; title: string; detail: string; status: 'pending' | 'approved' | 'denied' }

interface ChatMessage {
  role: string
  content: MessageContent
  thinking?: string
  modelLabel?: string
  toolRuns?: ToolRun[]
  blocks?: ChatMessageBlock[]
}

interface ToolProgressEntry {
  stage: string
  detail?: string
}

interface ToolRun {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  progress: ToolProgressEntry[]
}

interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  providerId?: string
  selectedModel?: string
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

interface PendingOfficeFile {
  id: string
  name: string
  filePath: string
  fileType: string
  fileSizeLabel: string
  promptContent: string
  previewText: string
}

interface AuthRequestPayload {
  requestId: string
  title: string
  detail: string
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
const pendingImages = ref<Array<{ base64: string; mimeType: string }>>([])
const pendingFiles = ref<PendingOfficeFile[]>([])
const isUploadingFiles = ref(false)
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
const backgroundStreamMessages = new Map<string, {
  messages: ChatMessage[]
  assistantIdx: number
  targetProjectId: string | null
  providerId: string | null
  selectedModel: string | null
}>()
const activeCleanups = new Map<string, () => void>()
const conversationTargets = new Map<string, string | null>()
let providerChangeCleanup: (() => void) | null = null
let authRequestCleanup: (() => void) | null = null

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

const currentModelLabel = computed(() => {
  const provider = providers.value.find(item => item.id === activeProviderId.value)
  const labelParts = [selectedModel.value, provider?.name].filter(Boolean)
  return labelParts.length > 0 ? labelParts.join(' · ') : 'The World AI'
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

function createBlockId (prefix: string): string {
  return `${prefix}_${generateId()}`
}

function cloneToolRuns (toolRuns: ToolRun[]): ToolRun[] {
  return toolRuns.map(toolRun => ({
    ...toolRun,
    progress: toolRun.progress.map(step => ({ ...step }))
  }))
}

function createToolRun (name: string): ToolRun {
  return {
    id: generateId(),
    name,
    status: 'running',
    progress: []
  }
}

function ensureBlocks (message: ChatMessage): ChatMessageBlock[] {
  if (!Array.isArray(message.blocks)) {
    message.blocks = []
  }
  return message.blocks
}

function createContentBlock (content: MessageContent = ''): ChatMessageBlock {
  return {
    id: createBlockId('content'),
    kind: 'content',
    content
  }
}

function createThinkingBlock (text = ''): ChatMessageBlock {
  return {
    id: createBlockId('thinking'),
    kind: 'thinking',
    text
  }
}

function createToolBlock (toolRun: ToolRun): ChatMessageBlock {
  return {
    id: createBlockId('tool'),
    kind: 'tool',
    toolRun
  }
}

function createFilePreviewBlock (filePath: string, truncated = false): ChatMessageBlock {
  return {
    id: createBlockId('preview'),
    kind: 'file_preview',
    filePath,
    previewContent: '',
    truncated,
    active: true
  }
}

function createAttachmentBlock (file: PendingOfficeFile): ChatMessageBlock {
  return {
    id: createBlockId('attachment'),
    kind: 'attachment',
    fileName: file.name,
    fileType: file.fileType,
    fileSizeLabel: file.fileSizeLabel,
    previewText: file.previewText
  }
}

function createAuthRequestBlock (request: AuthRequestPayload): ChatMessageBlock {
  return {
    id: createBlockId('auth'),
    kind: 'auth_request',
    requestId: request.requestId,
    title: request.title,
    detail: request.detail,
    status: 'pending'
  }
}

function getLastBlock (blocks: ChatMessageBlock[]): ChatMessageBlock | null {
  return blocks.length > 0 ? blocks[blocks.length - 1] : null
}

function ensureStreamingContentBlock (message: ChatMessage): Extract<ChatMessageBlock, { kind: 'content' }> {
  const blocks = ensureBlocks(message)
  const lastBlock = getLastBlock(blocks)
  if (lastBlock?.kind === 'content' && typeof lastBlock.content === 'string') {
    return lastBlock
  }

  const created = createContentBlock('') as Extract<ChatMessageBlock, { kind: 'content' }>
  blocks.push(created)
  return created
}

function ensureThinkingBlock (message: ChatMessage): Extract<ChatMessageBlock, { kind: 'thinking' }> {
  const blocks = ensureBlocks(message)
  const lastBlock = getLastBlock(blocks)
  if (lastBlock?.kind === 'thinking') {
    return lastBlock
  }

  const created = createThinkingBlock('') as Extract<ChatMessageBlock, { kind: 'thinking' }>
  blocks.push(created)
  return created
}

function getLastActivePreviewBlock (message: ChatMessage, filePath?: string): Extract<ChatMessageBlock, { kind: 'file_preview' }> | null {
  const blocks = ensureBlocks(message)
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block.kind !== 'file_preview' || !block.active) continue
    if (!filePath || block.filePath === filePath) {
      return block
    }
  }
  return null
}

function syncLegacyToolRuns (message: ChatMessage, toolRuns: ToolRun[]): void {
  message.toolRuns = cloneToolRuns(toolRuns)
}

function appendFinalContentBlock (message: ChatMessage, finalContent: MessageContent | undefined): void {
  if (finalContent === undefined) return

  const blocks = ensureBlocks(message)
  const hasContentBlock = blocks.some(block => block.kind === 'content' && (typeof block.content === 'string'
    ? block.content.trim().length > 0
    : block.content.length > 0))

  if (!hasContentBlock) {
    blocks.push(createContentBlock(finalContent))
    return
  }

  if (Array.isArray(finalContent)) {
    const imageParts = finalContent.filter(part => part.type === 'image_url')
    if (imageParts.length > 0) {
      blocks.push(createContentBlock(imageParts))
    }
  }
}

function findLastRunningToolRun (toolRuns: ToolRun[], preferredName?: string): ToolRun | null {
  for (let index = toolRuns.length - 1; index >= 0; index--) {
    const toolRun = toolRuns[index]
    if (toolRun.status !== 'running') continue
    if (!preferredName || toolRun.name === preferredName) {
      return toolRun
    }
  }
  return null
}

function findLastRunningToolBlock (message: ChatMessage): Extract<ChatMessageBlock, { kind: 'tool' }> | null {
  const blocks = ensureBlocks(message)
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block.kind === 'tool' && block.toolRun.status === 'running') {
      return block
    }
  }
  return null
}

function findLatestAssistantMessage (): ChatMessage | null {
  for (let index = messages.value.length - 1; index >= 0; index--) {
    if (messages.value[index].role === 'assistant') {
      return messages.value[index]
    }
  }
  return null
}

function finalizePendingAuthBlocks (message: ChatMessage): void {
  for (const block of ensureBlocks(message)) {
    if (block.kind === 'auth_request' && block.status === 'pending') {
      block.status = 'denied'
    }
  }
}

function formatFileSize (size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function getElectronFilePath (file: File): string | null {
  const candidate = (file as File & { path?: string }).path
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null
}

function trimPreviewText (content: string, maxLength = 180): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}…`
}

function buildUploadedFilesPrompt (files: PendingOfficeFile[]): string {
  return files
    .map(file => `【用户上传文件：${file.name}】\n文件类型：${file.fileType.toUpperCase()}\n文件内容如下：\n${file.promptContent}\n【文件结束】`)
    .join('\n\n')
}

function getConversationTitleText (msg?: ChatMessage): string {
  if (!msg) return ''

  if (Array.isArray(msg.blocks) && msg.blocks.length > 0) {
    const contentText = msg.blocks
      .filter((block): block is Extract<ChatMessageBlock, { kind: 'content' }> => block.kind === 'content')
      .flatMap(block => typeof block.content === 'string'
        ? [{ type: 'text', text: block.content }]
        : block.content)
      .filter(part => part.type === 'text')
      .map(part => part.text || '')
      .join(' ')
      .trim()

    if (contentText) return contentText

    const attachmentNames = msg.blocks
      .filter((block): block is Extract<ChatMessageBlock, { kind: 'attachment' }> => block.kind === 'attachment')
      .map(block => block.fileName)

    if (attachmentNames.length > 0) {
      return `上传文件：${attachmentNames.join('、')}`
    }
  }

  return getMessageText(msg)
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
      targetProjectId: targetProjectId.value,
      providerId: activeProviderId.value || null,
      selectedModel: selectedModel.value || null
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
  pendingFiles.value = []
  resetTransientStreamState()
  setConversationTarget(conversationId, projectId)

  await doSaveConversation(conversationId, [], {
    titleOverride: `优化 · ${name}`,
    targetProjectId: projectId
  })
}

async function applyProvidersConfig (
  config: ProvidersConfig,
  preferredProviderId?: string | null,
  preferredModelId?: string | null
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
  const nextModelId = preferredModelId && active?.models.includes(preferredModelId)
    ? preferredModelId
    : active?.activeModel || active?.models[0] || ''
  selectedModel.value = nextModelId

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
  await persistConversationProviderMeta()
}

async function loadConversations () {
  if (!window.electronAPI) return
  try {
    conversations.value = await window.electronAPI.listConversations()
  } catch { /* ignore */ }
}

async function loadProviders (preferredProviderId?: string | null, preferredModelId?: string | null) {
  if (!window.electronAPI) return
  try {
    const config = await window.electronAPI.getProviders()
    const currentConversation = currentConversationId.value
      ? conversations.value.find(item => item.id === currentConversationId.value)
      : null
    await applyProvidersConfig(
      config,
      preferredProviderId,
      preferredModelId || currentConversation?.selectedModel || selectedModel.value || null
    )
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
  pendingFiles.value = []
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
    pendingFiles.value = []
    pendingImages.value = []
    await loadProviders(bg.providerId || null, bg.selectedModel || null)
    return
  }

  const conv = await window.electronAPI.getConversation(id)
  if (conv) {
    currentConversationId.value = conv.id
    messages.value = conv.messages
    targetProjectId.value = conv.targetProjectId || null
    setConversationTarget(conv.id, conv.targetProjectId || null)
    resetTransientStreamState()
    pendingFiles.value = []
    pendingImages.value = []
    await loadProviders(conv.providerId || null, conv.selectedModel || null)
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
  const titleText = getConversationTitleText(firstUserMsg)
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
    selectedModel: selectedModel.value || undefined,
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

async function addFiles (files: File[]) {
  if (!window.electronAPI?.readUploadedOfficeFile || files.length === 0) return

  isUploadingFiles.value = true

  try {
    for (const file of files) {
      const filePath = getElectronFilePath(file)
      if (!filePath) {
        alert(`无法读取文件路径：${file.name}`)
        continue
      }

      try {
        const uploaded = await window.electronAPI.readUploadedOfficeFile(filePath)
        pendingFiles.value.push({
          id: generateId(),
          name: uploaded.fileName,
          filePath: uploaded.filePath,
          fileType: uploaded.fileType,
          fileSizeLabel: formatFileSize(uploaded.size),
          promptContent: uploaded.content,
          previewText: trimPreviewText(uploaded.content)
        })
      } catch (err) {
        alert(`${file.name} 上传失败：${(err as Error).message}`)
      }
    }
  } finally {
    isUploadingFiles.value = false
  }
}

function removeImage (index: number) {
  pendingImages.value.splice(index, 1)
}

function removeFile (id: string) {
  pendingFiles.value = pendingFiles.value.filter(file => file.id !== id)
}

function handleAuthRequest (request: AuthRequestPayload) {
  const assistantMessage = findLatestAssistantMessage()
  if (!assistantMessage) return

  const blocks = ensureBlocks(assistantMessage)
  const existing = blocks.find((block): block is Extract<ChatMessageBlock, { kind: 'auth_request' }> => {
    return block.kind === 'auth_request' && block.requestId === request.requestId
  })
  if (existing) return

  const toolBlock = findLastRunningToolBlock(assistantMessage)
  if (toolBlock) {
    const alreadyLogged = toolBlock.toolRun.progress.some(step => step.stage === '等待授权' && step.detail === request.title)
    if (!alreadyLogged) {
      toolBlock.toolRun.progress.push({ stage: '等待授权', detail: request.title })
    }
  }

  blocks.push(createAuthRequestBlock(request))
}

function respondToAuthRequest (requestId: string, approved: boolean) {
  for (const message of messages.value) {
    if (!Array.isArray(message.blocks)) continue
    const block = message.blocks.find((item): item is Extract<ChatMessageBlock, { kind: 'auth_request' }> => {
      return item.kind === 'auth_request' && item.requestId === requestId
    })
    if (!block) continue
    block.status = approved ? 'approved' : 'denied'
    break
  }

  window.electronAPI?.respondAuth(requestId, approved)
}

async function sendMessage () {
  const text = inputText.value.trim()
  if ((!text && pendingImages.value.length === 0 && pendingFiles.value.length === 0) || isLoading.value || isUploadingFiles.value) return

  let messageContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  const filePrompt = buildUploadedFilesPrompt(pendingFiles.value)
  const combinedText = [text, filePrompt].filter(Boolean).join('\n\n')
  const userBlocks: ChatMessageBlock[] = []

  if (text) {
    userBlocks.push(createContentBlock(text))
  }
  for (const file of pendingFiles.value) {
    userBlocks.push(createAttachmentBlock(file))
  }

  if (pendingImages.value.length > 0) {
    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
    if (combinedText) {
      parts.push({ type: 'text', text: combinedText })
    }
    for (const img of pendingImages.value) {
      parts.push({ type: 'image_url', image_url: { url: img.base64 } })
    }
    messageContent = parts
    userBlocks.push(createContentBlock(parts.filter(part => part.type === 'image_url')))
  } else {
    messageContent = combinedText
  }

  const convId = currentConversationId.value || generateId()
  currentConversationId.value = convId

  messages.value.push({
    role: 'user',
    content: messageContent,
    blocks: userBlocks.length > 0 ? userBlocks : undefined
  })
  inputText.value = ''
  pendingImages.value = []
  pendingFiles.value = []
  resetTransientStreamState()

  messages.value.push({
    role: 'assistant',
    content: '',
    thinking: '',
    modelLabel: currentModelLabel.value,
    toolRuns: [],
    blocks: []
  })

  const targetMessages = messages.value
  const assistantIdx = targetMessages.length - 1
  const assistantMessage = targetMessages[assistantIdx]
  const sessionId = generateId()
  let thinkingAccum = ''
  const toolRuns: ToolRun[] = []

  const syncAssistantToolRuns = () => {
    syncLegacyToolRuns(assistantMessage, toolRuns)
  }

  const ensureActiveToolRun = (name = '执行中') => {
    const existing = findLastRunningToolRun(toolRuns, name) || findLastRunningToolRun(toolRuns)
    if (existing) return existing
    const created = createToolRun(name)
    toolRuns.push(created)
    syncAssistantToolRuns()
    return created
  }

  streamingConvIds.add(convId)

  try {
    if (window.electronAPI) {
      const cleanup = window.electronAPI.onStreamEvent(sessionId, (event) => {
        const isForeground = currentConversationId.value === convId

        if (event.type === 'thinking' && event.content) {
          thinkingAccum += event.content
          assistantMessage.thinking = thinkingAccum
          const thinkingBlock = ensureThinkingBlock(assistantMessage)
          thinkingBlock.text += event.content
        } else if (event.type === 'reset') {
          thinkingAccum = ''
          assistantMessage.content = ''
          assistantMessage.thinking = ''
          assistantMessage.blocks = []
          if (isForeground) {
            resetTransientStreamState()
          }
        } else if (event.type === 'token' && event.content) {
          assistantMessage.content =
            ((assistantMessage.content as string) || '') + event.content
          const contentBlock = ensureStreamingContentBlock(assistantMessage)
          contentBlock.content = `${typeof contentBlock.content === 'string' ? contentBlock.content : ''}${event.content}`
        } else if (event.type === 'file_preview_start' && event.filePath) {
          const activeToolRun = ensureActiveToolRun('文件生成')
          const alreadyLogged = activeToolRun.progress.some(step => step.stage === '文件预览' && step.detail === event.filePath)
          if (!alreadyLogged) {
            activeToolRun.progress.push({ stage: '文件预览', detail: event.filePath })
            syncAssistantToolRuns()
          }
          ensureBlocks(assistantMessage).push(createFilePreviewBlock(event.filePath, Boolean(event.truncated)))
          if (isForeground) {
            filePreview.value = {
              active: true,
              filePath: event.filePath,
              content: '',
              truncated: Boolean(event.truncated)
            }
          }
        } else if (event.type === 'file_preview_chunk' && event.content) {
          const previewBlock = getLastActivePreviewBlock(assistantMessage, event.filePath)
          if (previewBlock) {
            previewBlock.previewContent += event.content
          }
          if (isForeground && filePreview.value.filePath === event.filePath) {
            filePreview.value = {
              ...filePreview.value,
              content: filePreview.value.content + event.content
            }
          }
        } else if (event.type === 'file_preview_end') {
          const previewBlock = getLastActivePreviewBlock(assistantMessage, event.filePath)
          if (previewBlock) {
            previewBlock.active = false
            previewBlock.truncated = Boolean(event.truncated ?? previewBlock.truncated)
          }
          if (isForeground) {
            filePreview.value = {
              ...filePreview.value,
              active: false,
              truncated: Boolean(event.truncated ?? filePreview.value.truncated)
            }
          }
        } else if (event.type === 'tool_start' && event.name) {
          const toolRun = createToolRun(event.name)
          toolRuns.push(toolRun)
          ensureBlocks(assistantMessage).push(createToolBlock(toolRun))
          syncAssistantToolRuns()
        } else if (event.type === 'progress' && event.stage) {
          const activeToolRun = ensureActiveToolRun()
          activeToolRun.progress.push({ stage: event.stage, detail: event.detail })
          syncAssistantToolRuns()
        } else if (event.type === 'tool_end') {
          const activeToolRun = findLastRunningToolRun(toolRuns, event.name) || findLastRunningToolRun(toolRuns)
          if (activeToolRun) {
            activeToolRun.status = 'completed'
            syncAssistantToolRuns()
          }
        } else if (event.type === 'done') {
          for (const toolRun of toolRuns) {
            if (toolRun.status === 'running') {
              toolRun.status = 'completed'
            }
          }
          finalizePendingAuthBlocks(assistantMessage)
          syncAssistantToolRuns()

          if (event.message?.content !== undefined) {
            if (Array.isArray(event.message.content)) {
              assistantMessage.content = event.message.content
            } else if (!getMessageText(assistantMessage) && event.message.content) {
              assistantMessage.content = event.message.content
            }
            appendFinalContentBlock(assistantMessage, event.message.content)
          }
          if (!hasRenderableContent(assistantMessage)) {
            assistantMessage.content = '(无响应)'
            ensureBlocks(assistantMessage).push(createContentBlock('(无响应)'))
          }
          if (event.thinking && !assistantMessage.thinking) {
            assistantMessage.thinking = event.thinking
            ensureBlocks(assistantMessage).push(createThinkingBlock(event.thinking))
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
          const activeToolRun = findLastRunningToolRun(toolRuns)
          if (activeToolRun) {
            activeToolRun.status = 'failed'
            activeToolRun.progress.push({ stage: '错误', detail: event.error })
            syncAssistantToolRuns()
          }
          finalizePendingAuthBlocks(assistantMessage)
          assistantMessage.content = `错误: ${event.error}`
          ensureBlocks(assistantMessage).push(createContentBlock(`错误: ${event.error}`))

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
        selectedModel.value || undefined,
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
        if (!hasRenderableContent(assistantMessage)) {
          assistantMessage.content = '(无响应)'
          ensureBlocks(assistantMessage).push(createContentBlock('(无响应)'))
        }
        finalizePendingAuthBlocks(assistantMessage)
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
      assistantMessage.content = response.content || '(无响应)'
      ensureBlocks(assistantMessage).push(createContentBlock(assistantMessage.content))
      finalizePendingAuthBlocks(assistantMessage)
      streamingConvIds.delete(convId)
      void doSaveConversation(convId, targetMessages)
      resetTransientStreamState()
    }
  } catch (err) {
    assistantMessage.content = `错误: ${(err as Error).message}`
    ensureBlocks(assistantMessage).push(createContentBlock(assistantMessage.content))
    finalizePendingAuthBlocks(assistantMessage)
    streamingConvIds.delete(convId)
    resetTransientStreamState()
  }
}

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
      void applyProvidersConfig(config, activeProviderId.value, selectedModel.value)
    })
  }

  if (window.electronAPI?.onAuthRequest) {
    authRequestCleanup = window.electronAPI.onAuthRequest(handleAuthRequest)
  }
})

onUnmounted(() => {
  for (const cleanup of activeCleanups.values()) {
    cleanup()
  }
  activeCleanups.clear()
  providerChangeCleanup?.()
  providerChangeCleanup = null
  authRequestCleanup?.()
  authRequestCleanup = null
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
        :file-preview="filePreview"
        @respond-auth="respondToAuthRequest"
      />

      <ChatInput
        v-model="inputText"
        :is-loading="isLoading"
        :pending-images="pendingImages"
        :pending-files="pendingFiles"
        :is-uploading-files="isUploadingFiles"
        :available-skills="availableSkills"
        :active-skill-ids="activeSkillIds"
        @send="sendMessage"
        @add-image="addImage"
        @add-files="addFiles"
        @remove-image="removeImage"
        @remove-file="removeFile"
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
