<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import ConversationSidebar from './layout/ConversationSidebar.vue'
import MessageList from './messages/MessageList.vue'
import ChatInput from './layout/ChatInput.vue'
import ChatHeader from './layout/ChatHeader.vue'
import DocumentDock from './layout/DocumentDock.vue'
import PinnedTodoPanel from './layout/PinnedTodoPanel.vue'
import { emitAuthResolution, onAuthResolution, type AuthResolutionPayload } from '../../utils/auth-events'

type MessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>
type AIExecutionAuthMode = 'strict' | 'auto'
type TodoStatus = 'not-started' | 'in-progress' | 'completed'
type ReasoningStrength = 'low' | 'medium' | 'high' | 'max'

interface TodoItem {
  id: number
  title: string
  status: TodoStatus
}

type ChatMessageBlock =
  | { id: string; kind: 'content'; content: MessageContent }
  | { id: string; kind: 'error'; message: string }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; toolRun: ToolRun }
  | { id: string; kind: 'todo'; items: TodoItem[] }
  | { id: string; kind: 'file_preview'; filePath: string; previewContent: string; truncated: boolean; active: boolean }
  | { id: string; kind: 'agent_sidechat'; session: AgentSidechatSession }
  | { id: string; kind: 'group_progress'; snapshot: AgentGroupProgressSnapshot }
  | { id: string; kind: 'group_transcript'; transcript: AgentGroupTranscript }
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
  reasoningStrength?: ReasoningStrength
  targetProjectId?: string
  agentId?: string
  groupId?: string
  channelBindingId?: string
}

interface SidebarAgentItem {
  id: string
  conversationId: string | null
  title: string
  subtitle: string
  icon: string
  modelId: string
  providerName: string
  modelOptions: string[]
  isStreaming: boolean
  isActive: boolean
}

interface SidebarGroupItem {
  id: string
  conversationId: string | null
  title: string
  subtitle: string
  icon: string
  isStreaming: boolean
  isActive: boolean
}

interface SidebarConversationItem {
  id: string
  title: string
  subtitle: string
  icon: string
  isStreaming: boolean
  isActive: boolean
}

interface GroupMentionHint {
  token: string
  label: string
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
const reasoningStrength = ref<ReasoningStrength>('medium')
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
const availableAgents = ref<AgentDefinition[]>([])
const availableAgentGroups = ref<AgentGroupDefinition[]>([])
const availableChannelBindings = ref<ChannelBinding[]>([])
const selectedAgentId = ref('')
const selectedGroupId = ref('')
const selectedChannelBindingId = ref('')
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
  reasoningStrength: ReasoningStrength
  agentId: string | null
  groupId: string | null
  channelBindingId: string | null
}>()
const activeCleanups = new Map<string, () => void>()
const activeStreamSessionIds = new Map<string, string>()
const conversationTargets = new Map<string, string | null>()
let providerChangeCleanup: (() => void) | null = null
let authRequestCleanup: (() => void) | null = null
let authResponseCleanup: (() => void) | null = null
let authResolvedCleanup: (() => void) | null = null
let skillsChangedCleanup: (() => void) | null = null
let agentWorkspaceChangeCleanup: (() => void) | null = null
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

const activeTodoItems = computed(() => getLatestVisibleTodoItems(messages.value, isLoading.value))

const shouldUseConversationProviderOverride = computed(() => {
  if (selectedGroupId.value || selectedChannelBindingId.value) return false
  if (!currentConversationId.value) return true  // new conversation: always allow override
  const defaultId = getDefaultAgentId()
  return !selectedAgentId.value || selectedAgentId.value === defaultId
})

const nonDefaultAgents = computed(() => {
  const defaultId = getDefaultAgentId()
  return availableAgents.value.filter(agent => agent.id !== defaultId)
})

const agentSelectorValue = computed(() => {
  const defaultId = getDefaultAgentId()
  return selectedAgentId.value === defaultId ? '' : selectedAgentId.value
})

const providersById = computed(() => {
  return new Map(providersConfig.value.providers.map(provider => [provider.id, provider]))
})

const agentsById = computed(() => {
  return new Map(availableAgents.value.map(agent => [agent.id, agent]))
})

const groupsById = computed(() => {
  return new Map(availableAgentGroups.value.map(group => [group.id, group]))
})

const currentAgentDefinition = computed(() => {
  return selectedAgentId.value ? agentsById.value.get(selectedAgentId.value) || null : null
})

const currentGroupDefinition = computed(() => {
  return selectedGroupId.value ? groupsById.value.get(selectedGroupId.value) || null : null
})

function getAgentIcon (agent?: Pick<AgentDefinition, 'icon'> | null): string {
  return agent?.icon?.trim() || '🤖'
}

function getGroupIcon (group?: Pick<AgentGroupDefinition, 'icon'> | null): string {
  return group?.icon?.trim() || '👥'
}

function getAgentProvider (agent?: AgentDefinition | null): ProviderOption | null {
  if (agent?.providerId) {
    return providersById.value.get(agent.providerId) || null
  }

  return activeProviderId.value
    ? providersById.value.get(activeProviderId.value) || null
    : null
}

function getAgentModelSelection (agent?: AgentDefinition | null): {
  providerName: string
  modelId: string
  modelOptions: string[]
} {
  const provider = getAgentProvider(agent)
  const modelOptions = provider?.models || []
  const modelId = agent?.modelId || provider?.activeModel || modelOptions[0] || ''

  return {
    providerName: provider?.name || '未配置供应商',
    modelId,
    modelOptions
  }
}

function resolveConversationIcon (conversation: ConversationSummary): string {
  if (conversation.groupId) {
    return getGroupIcon(groupsById.value.get(conversation.groupId) || null)
  }

  if (conversation.agentId) {
    return getAgentIcon(agentsById.value.get(conversation.agentId) || null)
  }

  return '💬'
}

function formatConversationSubtitle (updatedAt: string): string {
  try {
    return new Date(updatedAt).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return updatedAt
  }
}

function getPinnedAgentConversation (agentId: string): ConversationSummary | null {
  return conversations.value.find(conversation => {
    return conversation.agentId === agentId && !conversation.groupId && !conversation.channelBindingId
  }) || null
}

function getPinnedGroupConversation (groupId: string): ConversationSummary | null {
  return conversations.value.find(conversation => conversation.groupId === groupId) || null
}

const agentSidebarItems = computed<SidebarAgentItem[]>(() => {
  const defaultAgentId = getDefaultAgentId()

  return availableAgents.value
    .filter(agent => agent.id !== defaultAgentId)
    .map((agent) => {
      const conversation = getPinnedAgentConversation(agent.id)
      const selection = getAgentModelSelection(agent)

      return {
        id: agent.id,
        conversationId: conversation?.id || null,
        title: agent.name,
        subtitle: `${selection.providerName} · ${selection.modelId || '未配置模型'}`,
        icon: getAgentIcon(agent),
        modelId: selection.modelId,
        providerName: selection.providerName,
        modelOptions: selection.modelOptions,
        isStreaming: conversation ? streamingConvIds.has(conversation.id) : false,
        isActive: Boolean(conversation && currentConversationId.value === conversation.id)
      }
    })
})

const groupSidebarItems = computed<SidebarGroupItem[]>(() => {
  return availableAgentGroups.value.map((group) => {
    const conversation = getPinnedGroupConversation(group.id)
    const coordinatorName = group.coordinatorAgentId
      ? agentsById.value.get(group.coordinatorAgentId)?.name || '未设置协调 Agent'
      : '未设置协调 Agent'

    return {
      id: group.id,
      conversationId: conversation?.id || null,
      title: group.name,
      subtitle: `${group.memberAgentIds.length} 位 Agent · 协调 ${coordinatorName}`,
      icon: getGroupIcon(group),
      isStreaming: conversation ? streamingConvIds.has(conversation.id) : false,
      isActive: Boolean(conversation && currentConversationId.value === conversation.id)
    }
  })
})

const conversationSidebarItems = computed<SidebarConversationItem[]>(() => {
  const defaultAgentId = getDefaultAgentId()
  const pinnedConversationIds = new Set<string>([
    ...agentSidebarItems.value.map(item => item.conversationId).filter((value): value is string => Boolean(value)),
    ...groupSidebarItems.value.map(item => item.conversationId).filter((value): value is string => Boolean(value))
  ])

  return conversations.value
    .filter((conversation) => {
      if (pinnedConversationIds.has(conversation.id)) {
        return false
      }

      if (conversation.groupId && groupsById.value.has(conversation.groupId)) {
        return false
      }

      if (conversation.agentId && conversation.agentId !== defaultAgentId && agentsById.value.has(conversation.agentId)) {
        return false
      }

      return true
    })
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      subtitle: formatConversationSubtitle(conversation.updatedAt),
      icon: resolveConversationIcon(conversation),
      isStreaming: streamingConvIds.has(conversation.id),
      isActive: currentConversationId.value === conversation.id
    }))
})

const currentContextLabel = computed(() => {
  if (currentGroupDefinition.value) {
    return `${getGroupIcon(currentGroupDefinition.value)} ${currentGroupDefinition.value.name}`
  }

  if (currentAgentDefinition.value) {
    return `${getAgentIcon(currentAgentDefinition.value)} ${currentAgentDefinition.value.name}`
  }

  return '💬 新对话'
})

const currentContextDetail = computed(() => {
  if (currentGroupDefinition.value) {
    return `${currentGroupDefinition.value.memberAgentIds.length} 位 Agent 协作 · 可 @主Agent / @成员 单聊，@all 发起全组讨论`
  }

  return currentModelLabel.value
})

const groupMentionHints = computed<GroupMentionHint[]>(() => {
  const group = currentGroupDefinition.value
  if (!group) return []

  const hints: GroupMentionHint[] = [
    { token: '@主Agent', label: '主 Agent' },
    { token: '@all', label: '全组讨论' }
  ]
  const seenTokens = new Set(hints.map(item => item.token))

  for (const memberId of group.memberAgentIds) {
    const agent = agentsById.value.get(memberId)
    const token = `@${agent?.name || memberId}`
    if (seenTokens.has(token)) continue
    seenTokens.add(token)
    hints.push({
      token,
      label: agent?.name || memberId
    })
  }

  return hints
})

const currentModelLabel = computed(() => {
  if (currentGroupDefinition.value) {
    return `群组协作 · ${currentGroupDefinition.value.name}`
  }

  if (currentAgentDefinition.value) {
    const selection = getAgentModelSelection(currentAgentDefinition.value)
    const labelParts = [selection.modelId, selection.providerName].filter(Boolean)
    return labelParts.length > 0 ? labelParts.join(' · ') : currentAgentDefinition.value.name
  }

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

function getDefaultAgentId (): string {
  return availableAgents.value.find(agent => agent.id === 'agent_default')?.id || ''
}

async function loadAgentWorkspaceOptions () {
  if (!window.electronAPI?.listAgents || !window.electronAPI?.listAgentGroups || !window.electronAPI?.listChannelBindings) return

  try {
    const [agents, groups, bindings] = await Promise.all([
      window.electronAPI.listAgents(),
      window.electronAPI.listAgentGroups(),
      window.electronAPI.listChannelBindings()
    ])

    availableAgents.value = agents
    availableAgentGroups.value = groups
    availableChannelBindings.value = bindings

    if (selectedAgentId.value && !agents.some(agent => agent.id === selectedAgentId.value)) {
      selectedAgentId.value = ''
    }
    if (selectedGroupId.value && !groups.some(group => group.id === selectedGroupId.value)) {
      selectedGroupId.value = ''
    }
    if (selectedChannelBindingId.value && !bindings.some(binding => binding.id === selectedChannelBindingId.value)) {
      selectedChannelBindingId.value = ''
    }

    if (!selectedAgentId.value && !selectedGroupId.value && !selectedChannelBindingId.value) {
      selectedAgentId.value = getDefaultAgentId()
    }
  } catch { /* ignore */ }
}

function resetConversationComposerState (): void {
  messages.value = []
  targetProjectId.value = null
  currentAuthMode.value = 'strict'
  reasoningStrength.value = 'medium'
  inputText.value = ''
  resetTransientStreamState()
  pendingImages.value = []
  pendingFiles.value = []
  uploadFeedback.value = ''
}

function resolveConversationAgentSelection (value: { agentId?: string | null; groupId?: string | null; channelBindingId?: string | null }): string {
  if (value.groupId || value.channelBindingId) {
    return value.agentId || ''
  }

  return value.agentId || getDefaultAgentId()
}

function getPinnedContextTitle (): string | null {
  if (currentGroupDefinition.value) {
    return currentGroupDefinition.value.name
  }

  if (selectedAgentId.value && selectedAgentId.value !== getDefaultAgentId() && currentAgentDefinition.value) {
    return currentAgentDefinition.value.name
  }

  return null
}

async function createWorkspaceConversation (context: {
  agentId?: string
  groupId?: string
  channelBindingId?: string
  title: string
}): Promise<void> {
  const conversationId = generateId()

  stashCurrentConversationForNavigation()

  currentConversationId.value = conversationId
  resetConversationComposerState()
  selectedAgentId.value = context.agentId || ''
  selectedGroupId.value = context.groupId || ''
  selectedChannelBindingId.value = context.channelBindingId || ''

  await doSaveConversation(conversationId, [], {
    titleOverride: context.title,
    targetProjectId: null,
    allowEmpty: true
  })
}

async function openAgentWorkspaceConversation (agentId: string): Promise<void> {
  const existingConversation = getPinnedAgentConversation(agentId)
  if (existingConversation) {
    await loadConversation(existingConversation.id)
    return
  }

  const agent = agentsById.value.get(agentId)
  if (!agent) return

  await createWorkspaceConversation({
    agentId: agent.id,
    title: agent.name
  })
}

async function openGroupWorkspaceConversation (groupId: string): Promise<void> {
  const existingConversation = getPinnedGroupConversation(groupId)
  if (existingConversation) {
    await loadConversation(existingConversation.id)
    return
  }

  const group = groupsById.value.get(groupId)
  if (!group) return

  await createWorkspaceConversation({
    groupId: group.id,
    title: group.name
  })
}

async function handleSidebarAgentModelChange (payload: { agentId: string; modelId: string }): Promise<void> {
  if (!window.electronAPI?.saveAgent) return

  const agent = agentsById.value.get(payload.agentId)
  if (!agent) return

  await window.electronAPI.saveAgent({
    ...agent,
    modelId: payload.modelId || undefined
  })
  await loadAgentWorkspaceOptions()
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

function createErrorBlock (message: string): ChatMessageBlock {
  return {
    id: createBlockId('error'),
    kind: 'error',
    message
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

function createTodoBlock (items: TodoItem[]): ChatMessageBlock {
  return {
    id: createBlockId('todo'),
    kind: 'todo',
    items: items.map(item => ({ ...item }))
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

function cloneAgentSidechatSession (session: AgentSidechatSession): AgentSidechatSession {
  return {
    ...session,
    progress: session.progress.map(step => ({ ...step }))
  }
}

function createAgentSidechatBlock (session: AgentSidechatSession): ChatMessageBlock {
  return {
    id: createBlockId('sidechat'),
    kind: 'agent_sidechat',
    session: cloneAgentSidechatSession(session)
  }
}

function cloneGroupProgressSnapshot (snapshot: AgentGroupProgressSnapshot): AgentGroupProgressSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map(item => ({
      ...item,
      progress: item.progress.map(step => ({ ...step }))
    }))
  }
}

function createGroupProgressBlock (snapshot: AgentGroupProgressSnapshot): ChatMessageBlock {
  return {
    id: createBlockId('group_progress'),
    kind: 'group_progress',
    snapshot: cloneGroupProgressSnapshot(snapshot)
  }
}

function cloneGroupTranscript (transcript: AgentGroupTranscript): AgentGroupTranscript {
  return {
    ...transcript,
    entries: transcript.entries.map(entry => ({ ...entry }))
  }
}

function createGroupTranscriptBlock (transcript: AgentGroupTranscript): ChatMessageBlock {
  return {
    id: createBlockId('group_transcript'),
    kind: 'group_transcript',
    transcript: cloneGroupTranscript(transcript)
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

function positionGroupMetaBlocks (message: ChatMessage): void {
  const blocks = ensureBlocks(message)
  if (blocks.some(block => block.kind === 'agent_sidechat')) return
  const progressBlocks = blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'group_progress' }> => {
    return block.kind === 'group_progress'
  })
  const transcriptBlocks = blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'group_transcript' }> => {
    return block.kind === 'group_transcript'
  })

  if (progressBlocks.length === 0 && transcriptBlocks.length === 0) return

  const reorderedBlocks: ChatMessageBlock[] = blocks.filter(block => block.kind !== 'group_progress' && block.kind !== 'group_transcript')
  let insertIndex = -1
  for (let index = reorderedBlocks.length - 1; index >= 0; index--) {
    if (reorderedBlocks[index].kind === 'content') {
      insertIndex = index + 1
      break
    }
  }

  if (insertIndex < 0) {
    reorderedBlocks.push(...progressBlocks)
    reorderedBlocks.push(...transcriptBlocks)
  } else {
    reorderedBlocks.splice(insertIndex, 0, ...progressBlocks, ...transcriptBlocks)
  }

  blocks.splice(0, blocks.length, ...reorderedBlocks)
}

function upsertAgentSidechatBlock (message: ChatMessage, session: AgentSidechatSession): void {
  const blocks = ensureBlocks(message)
  const existing = blocks.find((block): block is Extract<ChatMessageBlock, { kind: 'agent_sidechat' }> => {
    return block.kind === 'agent_sidechat' && block.session.id === session.id
  })

  if (existing) {
    existing.session = cloneAgentSidechatSession(session)
    return
  }

  blocks.push(createAgentSidechatBlock(session))
}

function upsertGroupProgressBlock (message: ChatMessage, snapshot: AgentGroupProgressSnapshot): void {
  const blocks = ensureBlocks(message)
  const existing = blocks.find((block): block is Extract<ChatMessageBlock, { kind: 'group_progress' }> => {
    return block.kind === 'group_progress'
  })

  if (existing) {
    existing.snapshot = cloneGroupProgressSnapshot(snapshot)
  } else {
    blocks.push(createGroupProgressBlock(snapshot))
  }

  positionGroupMetaBlocks(message)
}

function upsertGroupTranscriptBlock (message: ChatMessage, transcript: AgentGroupTranscript): void {
  const blocks = ensureBlocks(message)
  const existing = blocks.find((block): block is Extract<ChatMessageBlock, { kind: 'group_transcript' }> => {
    return block.kind === 'group_transcript'
  })

  if (existing) {
    existing.transcript = cloneGroupTranscript(transcript)
  } else {
    blocks.push(createGroupTranscriptBlock(transcript))
  }

  positionGroupMetaBlocks(message)
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

function upsertErrorBlock (message: ChatMessage, errorMessage: string): void {
  const blocks = ensureBlocks(message)
  const existing = [...blocks].reverse().find((block): block is Extract<ChatMessageBlock, { kind: 'error' }> => block.kind === 'error')
  if (existing) {
    existing.message = errorMessage
    return
  }
  blocks.push(createErrorBlock(errorMessage))
}

function setAssistantErrorState (message: ChatMessage, errorMessage: string): void {
  if (getMessageTextContent(message.content).length === 0) {
    message.content = errorMessage
  }
  upsertErrorBlock(message, errorMessage)
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

function getLatestTodoBlock (message: ChatMessage): Extract<ChatMessageBlock, { kind: 'todo' }> | null {
  const blocks = Array.isArray(message.blocks) ? message.blocks : []
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block.kind === 'todo') {
      return block
    }
  }
  return null
}

function getLatestVisibleTodoItems (chatMessages: ChatMessage[] = messages.value, loading = isLoading.value): TodoItem[] {
  const latestAssistant = findLatestAssistantMessage(chatMessages)
  if (!latestAssistant) {
    return []
  }

  const todoBlock = getLatestTodoBlock(latestAssistant)
  if (!todoBlock) {
    return []
  }

  if (!loading && todoBlock.items.length > 0 && todoBlock.items.every(item => item.status === 'completed')) {
    return []
  }

  return todoBlock.items.map(item => ({ ...item }))
}

function syncTodoBlock (message: ChatMessage, items: TodoItem[]): void {
  const blocks = ensureBlocks(message)
  const nextItems = items.map(item => ({ ...item }))
  const existing = getLatestTodoBlock(message)
  if (nextItems.length === 0) {
    if (!existing) return
    const blockIndex = blocks.findIndex(block => block.id === existing.id)
    if (blockIndex >= 0) {
      blocks.splice(blockIndex, 1)
    }
    return
  }

  if (existing) {
    existing.items = nextItems
    return
  }

  blocks.push(createTodoBlock(nextItems))
}

function findLatestAssistantMessage (chatMessages: ChatMessage[] = messages.value): ChatMessage | null {
  for (let index = chatMessages.length - 1; index >= 0; index--) {
    if (chatMessages[index].role === 'assistant') {
      return chatMessages[index]
    }
  }
  return null
}

function getMessageTextContent (content: MessageContent): string {
  if (typeof content === 'string') {
    return content.trim()
  }

  return content
    .filter(part => part.type === 'text')
    .map(part => part.text || '')
    .join(' ')
    .trim()
}

function isAssistantMessageStopped (message: ChatMessage): boolean {
  if (getMessageTextContent(message.content).includes('(已停止)')) {
    return true
  }

  const toolRuns = Array.isArray(message.toolRuns) && message.toolRuns.length > 0
    ? message.toolRuns
    : (Array.isArray(message.blocks)
        ? message.blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'tool' }> => block.kind === 'tool').map(block => block.toolRun)
        : [])

  return toolRuns.some(toolRun => toolRun.progress.some(step => step.stage === '已停止'))
}

function buildInterruptedRunSummary (history: ChatMessage[]): string | null {
  const latestAssistant = findLatestAssistantMessage(history)
  if (!latestAssistant || !isAssistantMessageStopped(latestAssistant)) {
    return null
  }

  const lines = [
    '以下是上一轮被用户手动终止时的执行进度。如果用户是在继续同一个任务，请把这些内容视为已经完成或已知状态，不要要求用户重复说明，也不要重复已完成的步骤。'
  ]

  const todoBlock = getLatestTodoBlock(latestAssistant)
  if (todoBlock && todoBlock.items.length > 0) {
    lines.push('当前 Todo 状态：')
    for (const item of todoBlock.items) {
      const statusLabel = item.status === 'completed'
        ? '已完成'
        : item.status === 'in-progress'
          ? '进行中'
          : '未开始'
      lines.push(`- [${statusLabel}] ${item.id}. ${item.title}`)
    }
  }

  const toolRuns = Array.isArray(latestAssistant.toolRuns) && latestAssistant.toolRuns.length > 0
    ? latestAssistant.toolRuns
    : (Array.isArray(latestAssistant.blocks)
        ? latestAssistant.blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'tool' }> => block.kind === 'tool').map(block => block.toolRun)
        : [])

  if (toolRuns.length > 0) {
    lines.push('上一轮工具执行进度：')
    for (const toolRun of toolRuns) {
      const statusLabel = toolRun.status === 'failed'
        ? '失败'
        : toolRun.progress.some(step => step.stage === '已停止')
          ? '已中断'
          : toolRun.status === 'completed'
            ? '已完成'
            : '执行中'
      const recentProgress = toolRun.progress.slice(-3).map(step => step.detail ? `${step.stage}: ${step.detail}` : step.stage)
      lines.push(`- ${toolRun.name} [${statusLabel}]${recentProgress.length > 0 ? ` -> ${recentProgress.join(' | ')}` : ''}`)
    }
  }

  const authBlocks = Array.isArray(latestAssistant.blocks)
    ? latestAssistant.blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'auth_request' }> => block.kind === 'auth_request')
    : []
  if (authBlocks.length > 0) {
    lines.push('授权记录：')
    for (const block of authBlocks) {
      const statusLabel = block.status === 'approved' ? '已允许' : block.status === 'denied' ? '已拒绝' : '等待中'
      lines.push(`- ${statusLabel}: ${block.title}`)
    }
  }

  const previewBlocks = Array.isArray(latestAssistant.blocks)
    ? latestAssistant.blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'file_preview' }> => block.kind === 'file_preview')
    : []
  if (previewBlocks.length > 0) {
    lines.push('已生成或查看过的文件预览：')
    for (const block of previewBlocks.slice(-3)) {
      lines.push(`- ${block.filePath}`)
    }
  }

  return lines.join('\n')
}

function buildOutgoingChatMessages (sourceMessages: ChatMessage[]): Array<{ role: string; content: MessageContent }> {
  const outgoingMessages = sourceMessages.map(message => ({
    role: message.role,
    content: message.content
  }))

  if (sourceMessages.length === 0) {
    return outgoingMessages
  }

  const summary = buildInterruptedRunSummary(sourceMessages.slice(0, -1))
  if (!summary) {
    return outgoingMessages
  }

  const insertIndex = Math.max(outgoingMessages.length - 1, 0)
  outgoingMessages.splice(insertIndex, 0, {
    role: 'system',
    content: summary
  })

  return outgoingMessages
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
      providerId: shouldUseConversationProviderOverride.value ? (activeProviderId.value || null) : null,
      selectedModel: shouldUseConversationProviderOverride.value ? (selectedModel.value || null) : null,
      reasoningStrength: reasoningStrength.value,
      agentId: selectedAgentId.value || null,
      groupId: selectedGroupId.value || null,
      channelBindingId: selectedChannelBindingId.value || null
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
  reasoningStrength.value = 'medium'
  selectedAgentId.value = getDefaultAgentId()
  selectedGroupId.value = ''
  selectedChannelBindingId.value = ''
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

async function handleReasoningStrengthChange (value: ReasoningStrength) {
  reasoningStrength.value = value
  if (syncingProviderOptions.value || !currentConversationId.value) return
  await doSaveConversation(currentConversationId.value, messages.value, {
    targetProjectId: targetProjectId.value,
    allowEmpty: true
  })
}

async function handleAuthModeChange (authMode: AIExecutionAuthMode) {
  currentAuthMode.value = authMode
  const activeConversationId = currentConversationId.value
  const activeSessionId = activeConversationId ? activeStreamSessionIds.get(activeConversationId) : null
  if (activeSessionId && window.electronAPI?.updateChatSessionAuthMode) {
    try {
      await window.electronAPI.updateChatSessionAuthMode(activeSessionId, authMode)
    } catch { /* ignore */ }
  }
  if (!currentConversationId.value) return
  await doSaveConversation(currentConversationId.value, messages.value, {
    targetProjectId: targetProjectId.value,
    allowEmpty: true
  })
}

async function handleAgentSelectionChange (agentId: string) {
  selectedAgentId.value = agentId
  if (!currentConversationId.value) return
  await doSaveConversation(currentConversationId.value, messages.value, {
    targetProjectId: targetProjectId.value,
    allowEmpty: true
  })
}

async function handleGroupSelectionChange (groupId: string) {
  selectedGroupId.value = groupId
  if (!currentConversationId.value) return
  await doSaveConversation(currentConversationId.value, messages.value, {
    targetProjectId: targetProjectId.value,
    allowEmpty: true
  })
}

async function handleChannelBindingSelectionChange (channelBindingId: string) {
  selectedChannelBindingId.value = channelBindingId
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
  resetConversationComposerState()
  selectedAgentId.value = getDefaultAgentId()
  selectedGroupId.value = ''
  selectedChannelBindingId.value = ''
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
    reasoningStrength.value = bg.reasoningStrength
    selectedAgentId.value = resolveConversationAgentSelection(bg)
    selectedGroupId.value = bg.groupId || ''
    selectedChannelBindingId.value = bg.channelBindingId || ''
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
    reasoningStrength.value = conv.reasoningStrength || 'medium'
    selectedAgentId.value = resolveConversationAgentSelection(conv)
    selectedGroupId.value = conv.groupId || ''
    selectedChannelBindingId.value = conv.channelBindingId || ''
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
  const resolvedTitle = options?.titleOverride || getPinnedContextTitle() || (titleText
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
    providerId: shouldUseConversationProviderOverride.value ? (activeProviderId.value || undefined) : undefined,
    selectedModel: shouldUseConversationProviderOverride.value ? (selectedModel.value || undefined) : undefined,
    reasoningStrength: reasoningStrength.value,
    targetProjectId: resolvedTargetProjectId || undefined,
    agentId: selectedAgentId.value || undefined,
    groupId: selectedGroupId.value || undefined,
    channelBindingId: selectedChannelBindingId.value || undefined
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
          } else if (event.type === 'group_progress' && event.groupProgress) {
            upsertGroupProgressBlock(assistantMessage, event.groupProgress)
          } else if (event.type === 'agent_sidechat' && event.sidechat) {
            upsertAgentSidechatBlock(assistantMessage, event.sidechat)
          } else if (event.type === 'group_transcript' && event.transcript) {
            upsertGroupTranscriptBlock(assistantMessage, event.transcript)
          } else if (event.type === 'tool_start' && event.name) {
            const toolRun = createToolRun(event.name)
            toolRuns.push(toolRun)
            ensureBlocks(assistantMessage).push(createToolBlock(toolRun))
            syncAssistantToolRuns()
          } else if (event.type === 'todo_update' && Array.isArray(event.items)) {
            syncTodoBlock(assistantMessage, event.items)
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
              positionGroupMetaBlocks(assistantMessage)
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
              setAssistantErrorState(assistantMessage, event.error || '流式响应失败，但未返回具体错误信息')
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
          setAssistantErrorState(assistantMessage, (err as Error).message)
          finishSession(true)
        }
      })

      activeCleanups.set(sessionId, cleanup)

      const chatMessages = JSON.parse(JSON.stringify(buildOutgoingChatMessages(targetMessages.slice(0, -1))))
      await window.electronAPI.chatStream(
        chatMessages,
        sessionId,
        convId,
        shouldUseConversationProviderOverride.value ? (activeProviderId.value || undefined) : undefined,
        shouldUseConversationProviderOverride.value ? (selectedModel.value || undefined) : undefined,
        targetProjectId.value ?? undefined,
        currentAuthMode.value,
        reasoningStrength.value,
        selectedAgentId.value || undefined,
        selectedGroupId.value || undefined,
        selectedChannelBindingId.value || undefined
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
      const chatMessages = JSON.parse(JSON.stringify(buildOutgoingChatMessages(targetMessages.slice(0, -1))))
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
    setAssistantErrorState(assistantMessage, (err as Error).message)
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
  await loadAgentWorkspaceOptions()

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

  if (window.electronAPI?.onAgentWorkspaceChanged) {
    agentWorkspaceChangeCleanup = window.electronAPI.onAgentWorkspaceChanged(() => {
      void loadAgentWorkspaceOptions()
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
  agentWorkspaceChangeCleanup?.()
  agentWorkspaceChangeCleanup = null
  authResponseCleanup?.()
  authResponseCleanup = null
})
</script>

<template>
  <div class="chat-layout">
    <ConversationSidebar
      :agent-items="agentSidebarItems"
      :group-items="groupSidebarItems"
      :conversation-items="conversationSidebarItems"
      @new-conversation="newConversation"
      @select-conversation="loadConversation"
      @open-agent="openAgentWorkspaceConversation"
      @open-group="openGroupWorkspaceConversation"
      @delete-conversation="deleteConversation"
    />

    <div class="chat-panel">
      <ChatHeader
        :context-label="currentContextLabel"
        :context-detail="currentContextDetail"
        :available-channel-bindings="availableChannelBindings"
        :selected-channel-binding-id="selectedChannelBindingId"
        :available-skills="availableSkills"
        :active-skill-ids="activeSkillIds"
        :show-skill-picker="showSkillPicker"
        @update:selected-channel-binding-id="handleChannelBindingSelectionChange"
        @toggle-skill-picker="showSkillPicker = !showSkillPicker"
        @toggle-skill="toggleSkill"
      />

      <PinnedTodoPanel
        v-if="activeTodoItems.length > 0"
        :items="activeTodoItems"
        :is-loading="isLoading"
      />

      <MessageList
        :key="currentConversationId || 'draft'"
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
        :reasoning-strength="reasoningStrength"
        :auth-mode="currentAuthMode"
        :plan-mode-active="planModeActive"
        :providers="providers"
        :active-provider-id="activeProviderId"
        :selected-model="selectedModel"
        :show-provider-selector="shouldUseConversationProviderOverride"
        :available-agents="nonDefaultAgents"
        :selected-agent-id="agentSelectorValue"
        :group-mention-hints="groupMentionHints"
        :is-new-conversation="!currentConversationId"
        @send="sendMessage"
        @stop="stopCurrentStream"
        @add-attachments="addAttachments"
        @remove-image="removeImage"
        @remove-file="removeFile"
        @update:reasoning-strength="handleReasoningStrengthChange"
        @toggle-skill="toggleSkill"
        @toggle-document-dock="documentDockVisible = !documentDockVisible"
        @update:auth-mode="handleAuthModeChange"
        @toggle-plan-mode="togglePlanMode"
        @update:active-provider-id="handleProviderSelectionChange"
        @update:selected-model="handleModelSelectionChange"
        @update:selected-agent-id="handleAgentSelectionChange"
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
