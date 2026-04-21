<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import ConversationSidebar from './layout/ConversationSidebar.vue'
import MessageList from './messages/MessageList.vue'
import ChatInput from './layout/ChatInput.vue'
import ChatHeader from './layout/ChatHeader.vue'
import DocumentDock from './layout/DocumentDock.vue'
import { emitAuthResolution, onAuthResolution, type AuthResolutionPayload } from '../../utils/auth-events'

type MessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>
type AIExecutionAuthMode = 'strict' | 'auto'

type ChatMessageBlock =
  | { id: string; kind: 'content'; content: MessageContent }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; toolRun: ToolRun }
  | { id: string; kind: 'file_preview'; filePath: string; previewContent: string; truncated: boolean; active: boolean }
  | { id: string; kind: 'web_search'; query: string; engine: string; results: WebSearchResultItem[] }
  | { id: string; kind: 'web_fetch'; query?: string; result: WebFetchResultEntry }
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

interface WebSearchResultItem {
  rank: number
  title: string
  url: string
  snippet: string
  source: string
  published_at?: string
}

interface WebFetchResultEntry {
  url: string
  final_url?: string
  ok: boolean
  status?: number
  status_text?: string
  content_type?: string
  title?: string
  description?: string
  content: string
  excerpt_strategy?: 'query_snippets' | 'leading_text'
  query_snippets?: string[]
  query_match_count?: number
  truncated: boolean
  fetched_at: string
  error?: string
}

interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  authMode?: AIExecutionAuthMode
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

interface PendingAttachment {
  id: string
  name: string
  filePath: string
  fileType: string
  fileSizeLabel: string
  promptContent: string
  previewText: string
}

interface UploadedAttachmentResult {
  filePath: string
  fileName: string
  size: number
  fileType: string
  content: string
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
  (e: 'openWebLink', url: string): void
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
const currentAuthMode = ref<AIExecutionAuthMode>('strict')
const pendingImages = ref<Array<{ base64: string; mimeType: string }>>([])
const pendingFiles = ref<PendingAttachment[]>([])
const isUploadingFiles = ref(false)
const uploadFeedback = ref('')
const filePreview = ref<FilePreviewState>({
  active: false,
  filePath: '',
  content: '',
  truncated: false
})

const availableSkills = ref<SkillItem[]>([])
const activeSkillIds = ref<Set<string>>(new Set())
const showSkillPicker = ref(false)
const planModeActive = ref(false)
const syncingProviderOptions = ref(false)
const documentDockVisible = ref(false)
const DOCUMENT_TAG_PATTERN = /\[\[doc:([A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g
const PROJECT_TAG_PATTERN = /\[\[project:([^\]|]+)(?:\|([^\]]*))?\]\]/g

const streamingConvIds = reactive(new Set<string>())
const backgroundStreamMessages = new Map<string, {
  messages: ChatMessage[]
  assistantIdx: number
  targetProjectId: string | null
  authMode: AIExecutionAuthMode
  providerId: string | null
  selectedModel: string | null
}>()
const activeCleanups = new Map<string, () => void>()
const activeStreamSessionIds = new Map<string, string>()
const conversationTargets = new Map<string, string | null>()
let providerChangeCleanup: (() => void) | null = null
let authRequestCleanup: (() => void) | null = null
let authResponseCleanup: (() => void) | null = null
let authResolvedCleanup: (() => void) | null = null
let skillsChangedCleanup: (() => void) | null = null
const MAX_ATTACHMENT_PREVIEW_TEXT_LENGTH = 180
const MAX_IMAGE_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024

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
    const nextSkills = await window.electronAPI.listSkills() as SkillItem[]
    availableSkills.value = nextSkills

    const availableIds = new Set(nextSkills.map(skill => skill.id))
    const nextActiveIds = Array.from(activeSkillIds.value).filter(id => availableIds.has(id))
    if (nextActiveIds.length !== activeSkillIds.value.size) {
      activeSkillIds.value = new Set(nextActiveIds)
      void syncActiveSkills()
    }
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

function createWebSearchBlock (query: string, engine: string, results: WebSearchResultItem[]): ChatMessageBlock {
  return {
    id: createBlockId('websearch'),
    kind: 'web_search',
    query,
    engine,
    results
  }
}

function createWebFetchBlock (result: WebFetchResultEntry, query?: string): ChatMessageBlock {
  return {
    id: createBlockId('webfetch'),
    kind: 'web_fetch',
    query,
    result
  }
}

function createAttachmentBlock (file: PendingAttachment): ChatMessageBlock {
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

  if (typeof finalContent === 'string') {
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index]
      if (block.kind === 'content' && typeof block.content === 'string') {
        block.content = finalContent
        return
      }
    }

    if (finalContent.trim().length > 0) {
      blocks.push(createContentBlock(finalContent))
    }
    return
  }

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

function findLatestAssistantMessage (chatMessages: ChatMessage[] = messages.value): ChatMessage | null {
  for (let index = chatMessages.length - 1; index >= 0; index--) {
    if (chatMessages[index].role === 'assistant') {
      return chatMessages[index]
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

function markToolRunStopped (toolRun: ToolRun): void {
  toolRun.status = 'completed'
  const alreadyMarked = toolRun.progress.some(step => step.stage === '已停止')
  if (!alreadyMarked) {
    toolRun.progress.push({ stage: '已停止', detail: '用户中断了本次生成' })
  }
}

function markAssistantMessageStopped (message: ChatMessage): void {
  for (const toolRun of message.toolRuns || []) {
    if (toolRun.status === 'running') {
      markToolRunStopped(toolRun)
    }
  }

  for (const block of ensureBlocks(message)) {
    if (block.kind === 'tool' && block.toolRun.status === 'running') {
      markToolRunStopped(block.toolRun)
    }
  }

  finalizePendingAuthBlocks(message)

  if (!hasRenderableContent(message)) {
    message.content = '(已停止)'
    ensureBlocks(message).push(createContentBlock('(已停止)'))
  }
}

function releaseStreamSession (convId: string, sessionId: string): void {
  const cleanup = activeCleanups.get(sessionId)
  if (cleanup) {
    cleanup()
    activeCleanups.delete(sessionId)
  }

  activeStreamSessionIds.delete(convId)
  streamingConvIds.delete(convId)
  backgroundStreamMessages.delete(convId)
}

function formatFileSize (size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function getElectronFilePath (file: File): string | null {
  // Electron file inputs expose an absolute `path`; standard browsers do not.
  const candidate = (file as File & { path?: string }).path
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null
}

function isImageAttachment (file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name)
}

async function readFileAsDataUrl (file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error || new Error(`无法读取文件：${file.name}`))
    reader.readAsDataURL(file)
  })
}

async function readFileAsUint8Array (file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

async function readUploadedAttachment (file: File): Promise<UploadedAttachmentResult> {
  if (window.electronAPI?.readUploadedAttachmentBuffer) {
    const bytes = await readFileAsUint8Array(file)
    return window.electronAPI.readUploadedAttachmentBuffer({
      fileName: file.name,
      fileType: file.type || undefined,
      bytes
    })
  }

  const filePath = getElectronFilePath(file)
  if (filePath && window.electronAPI?.readUploadedAttachmentFile) {
    return window.electronAPI.readUploadedAttachmentFile(filePath)
  }

  throw new Error(`当前环境不支持读取附件：${file.name}`)
}

function trimPreviewText (content: string, maxLength = MAX_ATTACHMENT_PREVIEW_TEXT_LENGTH): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}…`
}

function buildUploadedFilesPrompt (files: PendingAttachment[]): string {
  return files
    .map(file => `【用户附件：${file.name}】\n文件类型：${file.fileType.toUpperCase()}\n文件内容如下：\n${file.promptContent}\n【附件结束】`)
    .join('\n\n')
}

function extractDocumentTagRefs (text: string): { regionIds: string[]; normalizedText: string } {
  const regionIds = new Set<string>()
  const normalizedText = text.replace(DOCUMENT_TAG_PATTERN, (_match, regionId: string, rawLabel?: string) => {
    regionIds.add(regionId)
    const label = rawLabel?.trim() || '文档标签'
    return `文档标签「${label}」`
  })

  return {
    regionIds: Array.from(regionIds),
    normalizedText
  }
}

function extractProjectTagRefs (text: string): { projectId: string | null; normalizedText: string } {
  let projectId: string | null = null
  const normalizedText = text.replace(PROJECT_TAG_PATTERN, (_match, id: string) => {
    if (!projectId) projectId = id
    return ''
  }).replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')
  return { projectId, normalizedText }
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
      return `附件：${attachmentNames.join('、')}`
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
      authMode: currentAuthMode.value,
      providerId: activeProviderId.value || null,
      selectedModel: selectedModel.value || null
    })
    void doSaveConversation(currentConversationId.value, messages.value, { targetProjectId: targetProjectId.value })
  }
}

async function startOptimizationConversation (ctx: Record<string, unknown>) {
  const projectId = typeof ctx.id === 'string' ? ctx.id : null
  const name = String(ctx.name || ctx.id || '未知项目')
  const projectRef = projectId ? `[[project:${projectId}|${name}]]` : ''
  const conversationId = generateId()

  stashCurrentConversationForNavigation()

  currentConversationId.value = conversationId
  messages.value = []
  targetProjectId.value = projectId
  currentAuthMode.value = 'strict'
  inputText.value = `${projectRef}${projectRef ? '\n' : ''}请先检查这个项目的当前代码、运行状态和最近日志，明确告诉我这个项目现在的具体问题、风险点和可优化项，然后再继续修改。`
  pendingImages.value = []
  pendingFiles.value = []
  uploadFeedback.value = ''
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

async function handleAuthModeChange (authMode: AIExecutionAuthMode) {
  currentAuthMode.value = authMode
  if (!currentConversationId.value) return
  await doSaveConversation(currentConversationId.value, messages.value, {
    targetProjectId: targetProjectId.value,
    allowEmpty: true
  })
}

async function togglePlanMode () {
  planModeActive.value = !planModeActive.value
  if (window.electronAPI?.setPlanMode) {
    try {
      await window.electronAPI.setPlanMode(planModeActive.value)
    } catch { /* ignore */ }
  }
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
  currentAuthMode.value = 'strict'
  inputText.value = ''
  resetTransientStreamState()
  pendingImages.value = []
  pendingFiles.value = []
  uploadFeedback.value = ''
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
    currentAuthMode.value = bg.authMode
    setConversationTarget(id, bg.targetProjectId)
    backgroundStreamMessages.delete(id)
    resetTransientStreamState()
    pendingFiles.value = []
    pendingImages.value = []
    uploadFeedback.value = ''
    await loadProviders(bg.providerId || null, bg.selectedModel || null)
    return
  }

  const conv = await window.electronAPI.getConversation(id)
  if (conv) {
    currentConversationId.value = conv.id
    messages.value = conv.messages
    targetProjectId.value = conv.targetProjectId || null
    currentAuthMode.value = conv.authMode === 'auto' ? 'auto' : 'strict'
    setConversationTarget(conv.id, conv.targetProjectId || null)
    resetTransientStreamState()
    pendingFiles.value = []
    pendingImages.value = []
    uploadFeedback.value = ''
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
    authMode: currentAuthMode.value,
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
  activeStreamSessionIds.delete(id)
  if (currentConversationId.value === id) {
    newConversation()
  }
  await loadConversations()
}

async function stopCurrentStream () {
  if (!window.electronAPI || !currentConversationId.value) return
  const convId = currentConversationId.value
  const targetMessages = messages.value
  const sessionId = activeStreamSessionIds.get(convId)
  if (!sessionId) return

  try {
    await window.electronAPI.stopChatStream(sessionId)
  } catch (err) {
    console.warn('[chat] Failed to request stream stop:', (err as Error).message)
  }

  if (!streamingConvIds.has(convId)) return

  const assistantMessage = findLatestAssistantMessage(targetMessages)
  if (assistantMessage) {
    markAssistantMessageStopped(assistantMessage)
  }

  releaseStreamSession(convId, sessionId)
  if (currentConversationId.value === convId) {
    resetTransientStreamState()
  }
  void doSaveConversation(convId, targetMessages)
}

async function addAttachments (files: File[]) {
  if (files.length === 0) return

  isUploadingFiles.value = true
  uploadFeedback.value = ''

  try {
    for (const file of files) {
      if (isImageAttachment(file)) {
        if (file.size > MAX_IMAGE_ATTACHMENT_SIZE_BYTES) {
          uploadFeedback.value = `${file.name} 添加失败：图片大小不能超过 20MB`
          continue
        }

        try {
          const base64 = await readFileAsDataUrl(file)
          pendingImages.value.push({
            base64,
            mimeType: file.type || 'image/png'
          })
          uploadFeedback.value = ''
        } catch (err) {
          uploadFeedback.value = `${file.name} 添加失败：${(err as Error).message}`
        }
        continue
      }

      try {
        const uploaded = await readUploadedAttachment(file)
        pendingFiles.value.push({
          id: generateId(),
          name: uploaded.fileName,
          filePath: uploaded.filePath || getElectronFilePath(file) || file.name,
          fileType: uploaded.fileType,
          fileSizeLabel: formatFileSize(uploaded.size),
          promptContent: uploaded.content,
          previewText: trimPreviewText(uploaded.content)
        })
        uploadFeedback.value = ''
      } catch (err) {
        uploadFeedback.value = `${file.name} 添加失败：${(err as Error).message}`
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
  if (pendingFiles.value.length === 0) {
    uploadFeedback.value = ''
  }
}

function insertDocumentTag (tag: string) {
  const spacer = inputText.value.length > 0 && !/\s$/.test(inputText.value) ? ' ' : ''
  inputText.value = `${inputText.value}${spacer}${tag} `
}

function handleAuthRequest (request: AuthRequestPayload) {
  let assistantMessage = findLatestAssistantMessage()

  // If no assistant message exists (edge case), create one so the auth card has a home
  if (!assistantMessage) {
    const placeholder: ChatMessage = {
      role: 'assistant',
      content: '',
      blocks: []
    }
    messages.value.push(placeholder)
    assistantMessage = placeholder
  }

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

function applyAuthResolution (requestId: string, approved: boolean) {
  for (const message of messages.value) {
    if (!Array.isArray(message.blocks)) continue
    const block = message.blocks.find((item): item is Extract<ChatMessageBlock, { kind: 'auth_request' }> => {
      return item.kind === 'auth_request' && item.requestId === requestId
    })
    if (!block) continue
    block.status = approved ? 'approved' : 'denied'
    break
  }
}

function handleAuthResolution (payload: AuthResolutionPayload) {
  applyAuthResolution(payload.requestId, payload.approved)
}

function respondToAuthRequest (requestId: string, approved: boolean) {
  emitAuthResolution({ requestId, approved })
  window.electronAPI?.respondAuth(requestId, approved)
}

async function sendMessage () {
  const text = inputText.value.trim()
  if ((!text && pendingImages.value.length === 0 && pendingFiles.value.length === 0) || isLoading.value || isUploadingFiles.value) return

  let messageContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  const filePrompt = buildUploadedFilesPrompt(pendingFiles.value)
  const { projectId: taggedProjectId, normalizedText: textAfterProject } = extractProjectTagRefs(text)
  if (taggedProjectId && !targetProjectId.value) {
    targetProjectId.value = taggedProjectId
    setConversationTarget(currentConversationId.value || '', taggedProjectId)
  }
  const { regionIds: referencedDocumentRegionIds, normalizedText } = extractDocumentTagRefs(textAfterProject)

  let docSelectionsPrompt = ''
  if (referencedDocumentRegionIds.length > 0 && window.electronAPI?.buildDocumentSelectionsPrompt) {
    try {
      docSelectionsPrompt = await window.electronAPI.buildDocumentSelectionsPrompt(referencedDocumentRegionIds)
    } catch { /* ignore */ }
  }

  const combinedText = [normalizedText, filePrompt, docSelectionsPrompt].filter(Boolean).join('\n\n')
  const userBlocks: ChatMessageBlock[] = []

  if (normalizedText) {
    userBlocks.push(createContentBlock(normalizedText))
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
  uploadFeedback.value = ''
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
  activeStreamSessionIds.set(convId, sessionId)

  try {
    if (window.electronAPI) {
      const cleanup = window.electronAPI.onStreamEvent(sessionId, (event) => {
        const isForeground = currentConversationId.value === convId
        const finishSession = (saveConversation = false) => {
          releaseStreamSession(convId, sessionId)
          if (saveConversation) {
            void doSaveConversation(convId, targetMessages)
          }
          if (isForeground) {
            resetTransientStreamState()
          }
        }

        try {
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
          } else if (event.type === 'web_search_result' && event.query) {
            ensureBlocks(assistantMessage).push(createWebSearchBlock(event.query, event.engine || 'web', Array.isArray(event.results) ? event.results : []))
          } else if (event.type === 'web_fetch_result' && event.result) {
            ensureBlocks(assistantMessage).push(createWebFetchBlock(event.result as WebFetchResultEntry, event.query))
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
            try {
              for (const toolRun of toolRuns) {
                if (toolRun.status === 'running') {
                  toolRun.status = 'completed'
                }
              }
              finalizePendingAuthBlocks(assistantMessage)
              syncAssistantToolRuns()

              if (event.message?.content !== undefined) {
                assistantMessage.content = event.message.content
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
            } finally {
              finishSession(true)
            }
          } else if (event.type === 'error') {
            try {
              const activeToolRun = findLastRunningToolRun(toolRuns)
              if (activeToolRun) {
                activeToolRun.status = 'failed'
                activeToolRun.progress.push({ stage: '错误', detail: event.error })
                syncAssistantToolRuns()
              }
              finalizePendingAuthBlocks(assistantMessage)
              assistantMessage.content = `错误: ${event.error}`
              ensureBlocks(assistantMessage).push(createContentBlock(`错误: ${event.error}`))
            } finally {
              finishSession()
            }
          } else if (event.type === 'stopped') {
            try {
              markAssistantMessageStopped(assistantMessage)
              syncAssistantToolRuns()
            } finally {
              finishSession(true)
            }
          }
        } catch (err) {
          console.error('[chat] Failed to handle stream event:', event, err)

          const activeToolRun = findLastRunningToolRun(toolRuns)
          if (activeToolRun) {
            activeToolRun.status = 'failed'
            activeToolRun.progress.push({ stage: '渲染错误', detail: (err as Error).message })
            syncAssistantToolRuns()
          }

          finalizePendingAuthBlocks(assistantMessage)
          assistantMessage.content = `错误: ${(err as Error).message}`
          ensureBlocks(assistantMessage).push(createContentBlock(assistantMessage.content))
          finishSession(true)
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
        convId,
        activeProviderId.value || undefined,
        selectedModel.value || undefined,
        targetProjectId.value ?? undefined,
        currentAuthMode.value
      )

      if (streamingConvIds.has(convId)) {
        releaseStreamSession(convId, sessionId)
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
      activeStreamSessionIds.delete(convId)
      streamingConvIds.delete(convId)
      void doSaveConversation(convId, targetMessages)
      if (currentConversationId.value === convId) {
        resetTransientStreamState()
      }
    }
  } catch (err) {
    releaseStreamSession(convId, sessionId)
    assistantMessage.content = `错误: ${(err as Error).message}`
    ensureBlocks(assistantMessage).push(createContentBlock(assistantMessage.content))
    finalizePendingAuthBlocks(assistantMessage)
    if (currentConversationId.value === convId) {
      resetTransientStreamState()
    }
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

  if (window.electronAPI?.onAuthResolved) {
    authResolvedCleanup = window.electronAPI.onAuthResolved(handleAuthResolution)
  }

  if (window.electronAPI?.onSkillsChanged) {
    skillsChangedCleanup = window.electronAPI.onSkillsChanged(() => {
      void loadSkills()
    })
  }

  authResponseCleanup = onAuthResolution(handleAuthResolution)
})

onUnmounted(() => {
  for (const cleanup of activeCleanups.values()) {
    cleanup()
  }
  activeCleanups.clear()
  activeStreamSessionIds.clear()
  providerChangeCleanup?.()
  providerChangeCleanup = null
  authRequestCleanup?.()
  authRequestCleanup = null
  authResolvedCleanup?.()
  authResolvedCleanup = null
  skillsChangedCleanup?.()
  skillsChangedCleanup = null
  authResponseCleanup?.()
  authResponseCleanup = null
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
        :auth-mode="currentAuthMode"
        :available-skills="availableSkills"
        :active-skill-ids="activeSkillIds"
        :show-skill-picker="showSkillPicker"
        :plan-mode-active="planModeActive"
        @update:active-provider-id="handleProviderSelectionChange"
        @update:selected-model="handleModelSelectionChange"
        @update:auth-mode="handleAuthModeChange"
        @toggle-skill-picker="showSkillPicker = !showSkillPicker"
        @toggle-skill="toggleSkill"
        @toggle-plan-mode="togglePlanMode"
      />

      <MessageList
        :messages="messages"
        :is-loading="isLoading"
        :file-preview="filePreview"
        @respond-auth="respondToAuthRequest"
        @open-link="(url) => emit('openWebLink', url)"
      />

      <DocumentDock
        :visible="documentDockVisible"
        @close="documentDockVisible = false"
        @selections-changed="() => {}"
        @insert-selection-tag="insertDocumentTag"
      />

      <ChatInput
        v-model="inputText"
        :is-loading="isLoading"
        :pending-images="pendingImages"
        :pending-files="pendingFiles"
        :is-uploading-files="isUploadingFiles"
        :upload-feedback="uploadFeedback"
        :available-skills="availableSkills"
        :active-skill-ids="activeSkillIds"
        :document-dock-visible="documentDockVisible"
        @send="sendMessage"
        @stop="stopCurrentStream"
        @add-attachments="addAttachments"
        @remove-image="removeImage"
        @remove-file="removeFile"
        @toggle-skill="toggleSkill"
        @toggle-document-dock="documentDockVisible = !documentDockVisible"
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
  --chat-message-gutter: clamp(18px, 2.4vw, 40px);
  --chat-message-track-max: 1480px;
  --chat-message-column-max: 1120px;
  --chat-event-card-max: 1080px;
  --chat-bubble-max: 1120px;
  --chat-avatar-size: 40px;
  --chat-avatar-gap: 14px;
  --chat-avatar-footprint: calc(var(--chat-avatar-size) + var(--chat-avatar-gap));
  --chat-dual-avatar-footprint: calc(var(--chat-avatar-footprint) * 2);
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
</style>
