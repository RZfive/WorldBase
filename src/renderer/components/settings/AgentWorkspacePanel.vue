<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MultiSelectDropdown from './MultiSelectDropdown.vue'

interface ToolCatalogEntry {
  name: string
  description: string
}

type WorkspaceTab = 'agents' | 'groups' | 'bindings' | 'memory'

const { t } = useI18n()

const memoryScopeOptions: Array<{ value: AgentMemoryScope; labelKey: string }> = [
  { value: 'user', labelKey: 'settings.agentWorkspace.scopeUser' },
  { value: 'agent', labelKey: 'settings.agentWorkspace.scopeAgent' },
  { value: 'project', labelKey: 'settings.agentWorkspace.scopeProject' },
  { value: 'group', labelKey: 'settings.agentWorkspace.scopeGroup' },
  { value: 'channel', labelKey: 'settings.agentWorkspace.scopeChannel' }
]

const memoryTypeOptions: Array<{ value: MemoryType; labelKey: string }> = [
  { value: 'knowledge', labelKey: 'settings.agentWorkspace.memoryTypeKnowledge' },
  { value: 'user_trait', labelKey: 'settings.agentWorkspace.memoryTypeUserTrait' },
  { value: 'agent_skill', labelKey: 'settings.agentWorkspace.memoryTypeAgentSkill' },
  { value: 'step', labelKey: 'settings.agentWorkspace.memoryTypeStep' }
]

const activeTab = ref<WorkspaceTab>('agents')
const agents = ref<AgentDefinition[]>([])
const groups = ref<AgentGroupDefinition[]>([])
const bindings = ref<ChannelBinding[]>([])
const connectors = ref<ConnectorDefinition[]>([])
const memoryEntries = ref<MemoryEntry[]>([])
const providersConfig = ref<AIProvidersConfig>({
  providers: [],
  activeProviderId: '',
  enabledProviderIds: []
})
const skills = ref<SkillInfo[]>([])
const agentTools = ref<ToolCatalogEntry[]>([])
const memoryQuery = ref('')
const memoryScopeType = ref<AgentMemoryScope>('user')
const memoryScopeId = ref('')
const showMemoryFilters = ref(false)
const addingMemory = ref(false)
const savingMemory = ref(false)
const memoryCompactionStatus = ref<MemoryCompactionStatus | null>(null)
const memoryCompactionStarting = ref(false)
const memoryCompacting = computed(() => memoryCompactionStarting.value || memoryCompactionStatus.value?.status === 'running')
const statusMessage = ref('')
let providerChangeCleanup: (() => void) | null = null
let skillsChangeCleanup: (() => void) | null = null
let workspaceChangeCleanup: (() => void) | null = null
let memoryCompactionCleanup: (() => void) | null = null

const draftAgent = reactive({
  id: '',
  name: '',
  icon: '🤖',
  description: '',
  systemPrompt: '',
  providerId: '',
  modelId: '',
  reasoningStrength: 'medium' as AgentReasoningStrength,
  skillIds: [] as string[],
  allowedTools: [] as string[],
  deniedTools: [] as string[],
  memoryScopes: ['user', 'agent', 'project'] as AgentMemoryScope[],
  allowUserTraits: true,
  allowAgentSkills: true,
  allowSteps: true,
  allowKnowledge: true,
  autoReplyEnabled: false,
  autoReplyRequireMention: true
})

const draftGroup = reactive({
  id: '',
  name: '',
  icon: '👥',
  description: '',
  coordinatorAgentId: '',
  memberAgentIds: [] as string[],
  maxRounds: 2,
  maxParallelWorkers: 2,
  sharedMemoryScopes: ['group'] as Array<'group' | 'project' | 'channel'>,
  visibility: 'summary_only' as 'summary_only' | 'expandable_internal_transcript'
})

const draftBinding = reactive({
  id: '',
  connectorType: 'custom' as ConnectorType,
  name: '',
  externalChannelId: '',
  externalThreadId: '',
  boundConversationId: '',
  boundGroupId: '',
  defaultAgentId: '',
  targetProjectId: '',
  incomingSecret: '',
  outgoingWebhookUrl: '',
  appId: '',
  appSecret: '',
  verificationToken: '',
  encryptKey: '',
  botUserId: '',
  autoReply: false,
  requireApprovalForRiskyTools: true
})

const bindingTest = reactive({
  text: t('settings.agentWorkspace.bindingTestDefaultText'),
  running: false,
  result: ''
})

const draftMemory = reactive({
  title: '',
  summary: '',
  details: '',
  tagsText: '',
  scopeType: 'user' as AgentMemoryScope,
  scopeId: 'local-user',
  memoryType: 'knowledge' as MemoryType,
  pinned: true
})

const selectedConnector = computed(() => {
  return connectors.value.find(connector => connector.id === draftBinding.connectorType) || null
})

const bindingWebhookUrl = computed(() => {
  const bindingPart = draftBinding.id || ':bindingId'
  return `http://localhost:19527/api/im/webhook/${draftBinding.connectorType}/${bindingPart}`
})

const bindingOpenClawUrl = computed(() => {
  const bindingPart = draftBinding.id || ':bindingId'
  return `http://localhost:19527/api/im/openclaw/${bindingPart}`
})

function setStatus (message: string) {
  statusMessage.value = message
}

function memoryScopeLabel (value: AgentMemoryScope): string {
  const option = memoryScopeOptions.find(item => item.value === value)
  return option ? t(option.labelKey) : value
}

function memoryTypeLabel (value: MemoryType): string {
  const option = memoryTypeOptions.find(item => item.value === value)
  return option ? t(option.labelKey) : value
}

function formatMemoryCompactionResult (result: MemoryCompactionResult): string {
  return t('settings.agentWorkspace.memoryCompactionCompleted', {
    scanned: result.scanned,
    removed: result.removedUseless,
    merged: result.merged,
    updated: result.updated,
    retained: result.retained
  })
}

const hasMemoryScopeFilter = computed(() => memoryScopeId.value.trim().length > 0)

const memoryScopeFilterText = computed(() => {
  if (!hasMemoryScopeFilter.value) return t('settings.agentWorkspace.allScopes')
  return `${memoryScopeLabel(memoryScopeType.value)} / ${memoryScopeId.value.trim()}`
})

function formatMemoryCompactionStatus (status: MemoryCompactionStatus): string {
  if (status.status === 'running') {
    const batchText = status.totalChunks > 0
      ? t('settings.agentWorkspace.memoryBatchProgressWrapped', { completed: status.completedChunks, total: status.totalChunks })
      : ''
    const detail = status.detail ? t('settings.agentWorkspace.colonDetail', { detail: status.detail }) : ''
    return t('settings.agentWorkspace.memoryCompactionRunning', { stage: status.stage, batch: batchText, detail })
  }

  if (status.status === 'completed' && status.result) {
    return formatMemoryCompactionResult(status.result)
  }

  if (status.status === 'failed') {
    return t('settings.agentWorkspace.memoryCompactionFailed', { message: status.error || status.detail || t('common.unknown') })
  }

  return ''
}

function applyMemoryCompactionStatus (status: MemoryCompactionStatus) {
  memoryCompactionStatus.value = status
  memoryCompactionStarting.value = false
  const message = formatMemoryCompactionStatus(status)
  if (message) {
    setStatus(message)
  }
  if (status.status === 'completed') {
    void loadMemory()
  }
}

const memoryCompactionProgressText = computed(() => {
  const status = memoryCompactionStatus.value
  if (!status || status.status !== 'running') return ''
  const batchText = status.totalChunks > 0
    ? t('settings.agentWorkspace.memoryBatchProgress', { completed: status.completedChunks, total: status.totalChunks })
    : t('settings.agentWorkspace.preparing')
  return status.detail
    ? `${batchText} · ${status.stage} · ${status.detail}`
    : `${batchText} · ${status.stage}`
})

function toggleStringValue<T extends string> (collection: T[], value: T): T[] {
  return collection.includes(value)
    ? collection.filter(item => item !== value)
    : [...collection, value]
}

const selectedProvider = computed(() => {
  return providersConfig.value.providers.find(provider => provider.id === draftAgent.providerId) || null
})

const availableModels = computed(() => {
  return selectedProvider.value?.models || []
})

const skillOptions = computed(() => {
  return skills.value.map(skill => ({
    value: skill.id,
    label: skill.name,
    description: skill.description
  }))
})

const toolOptions = computed(() => {
  return agentTools.value.map(tool => ({
    value: tool.name,
    label: tool.name,
    description: tool.description
  }))
})

function getDefaultProviderSelection (): { providerId: string; modelId: string } {
  const provider = providersConfig.value.providers.find(item => item.id === providersConfig.value.activeProviderId)
    || providersConfig.value.providers[0]

  if (!provider) {
    return { providerId: '', modelId: '' }
  }

  return {
    providerId: provider.id,
    modelId: provider.activeModel || provider.models[0] || ''
  }
}

function syncDraftAgentModel (preferProviderDefault = false) {
  const provider = selectedProvider.value
  if (!provider) {
    draftAgent.modelId = ''
    return
  }

  if (preferProviderDefault || !provider.models.includes(draftAgent.modelId)) {
    draftAgent.modelId = provider.activeModel || provider.models[0] || ''
  }
}

function pruneAgentSelections () {
  const validSkillIds = new Set(skills.value.map(skill => skill.id))
  draftAgent.skillIds = draftAgent.skillIds.filter(skillId => validSkillIds.has(skillId))

  const validToolNames = new Set(agentTools.value.map(tool => tool.name))
  draftAgent.allowedTools = draftAgent.allowedTools.filter(toolName => validToolNames.has(toolName))
  draftAgent.deniedTools = draftAgent.deniedTools.filter(toolName => validToolNames.has(toolName))

  const validProviderIds = new Set(providersConfig.value.providers.map(provider => provider.id))
  if (draftAgent.providerId && !validProviderIds.has(draftAgent.providerId)) {
    const defaults = getDefaultProviderSelection()
    draftAgent.providerId = defaults.providerId
    draftAgent.modelId = defaults.modelId
  }

  syncDraftAgentModel(false)
}

function resetAgentDraft () {
  const defaults = getDefaultProviderSelection()
  draftAgent.id = ''
  draftAgent.name = ''
  draftAgent.icon = '🤖'
  draftAgent.description = ''
  draftAgent.systemPrompt = ''
  draftAgent.providerId = defaults.providerId
  draftAgent.modelId = defaults.modelId
  draftAgent.reasoningStrength = 'medium'
  draftAgent.skillIds = []
  draftAgent.allowedTools = []
  draftAgent.deniedTools = []
  draftAgent.memoryScopes = ['user', 'agent', 'project']
  draftAgent.allowUserTraits = true
  draftAgent.allowAgentSkills = true
  draftAgent.allowSteps = true
  draftAgent.allowKnowledge = true
  draftAgent.autoReplyEnabled = false
  draftAgent.autoReplyRequireMention = true
}

function loadAgentIntoDraft (agent?: AgentDefinition | null) {
  if (!agent) {
    resetAgentDraft()
    return
  }

  draftAgent.id = agent.id
  draftAgent.name = agent.name
  draftAgent.icon = agent.icon || '🤖'
  draftAgent.description = agent.description
  draftAgent.systemPrompt = agent.systemPrompt
  draftAgent.providerId = agent.providerId || ''
  draftAgent.modelId = agent.modelId || ''
  draftAgent.reasoningStrength = agent.reasoningStrength || 'medium'
  draftAgent.skillIds = [...agent.skillIds]
  draftAgent.allowedTools = [...(agent.allowedTools || [])]
  draftAgent.deniedTools = [...(agent.deniedTools || [])]
  draftAgent.memoryScopes = [...agent.memoryScopes]
  draftAgent.allowUserTraits = agent.memoryWritePolicy.allowUserTraits
  draftAgent.allowAgentSkills = agent.memoryWritePolicy.allowAgentSkills
  draftAgent.allowSteps = agent.memoryWritePolicy.allowSteps
  draftAgent.allowKnowledge = agent.memoryWritePolicy.allowKnowledge
  draftAgent.autoReplyEnabled = agent.autoReplyPolicy?.enabled ?? false
  draftAgent.autoReplyRequireMention = agent.autoReplyPolicy?.requireMention ?? true
  pruneAgentSelections()
}

function resetGroupDraft () {
  draftGroup.id = ''
  draftGroup.name = ''
  draftGroup.icon = '👥'
  draftGroup.description = ''
  draftGroup.coordinatorAgentId = ''
  draftGroup.memberAgentIds = []
  draftGroup.maxRounds = 2
  draftGroup.maxParallelWorkers = 2
  draftGroup.sharedMemoryScopes = ['group']
  draftGroup.visibility = 'summary_only'
}

function loadGroupIntoDraft (group?: AgentGroupDefinition | null) {
  if (!group) {
    resetGroupDraft()
    return
  }

  draftGroup.id = group.id
  draftGroup.name = group.name
  draftGroup.icon = group.icon || '👥'
  draftGroup.description = group.description || ''
  draftGroup.coordinatorAgentId = group.coordinatorAgentId
  draftGroup.memberAgentIds = [...group.memberAgentIds]
  draftGroup.maxRounds = group.maxRounds
  draftGroup.maxParallelWorkers = group.maxParallelWorkers
  draftGroup.sharedMemoryScopes = [...group.sharedMemoryScopes]
  draftGroup.visibility = group.visibility
}

function resetBindingDraft () {
  draftBinding.id = ''
  draftBinding.connectorType = 'custom'
  draftBinding.name = ''
  draftBinding.externalChannelId = ''
  draftBinding.externalThreadId = ''
  draftBinding.boundConversationId = ''
  draftBinding.boundGroupId = ''
  draftBinding.defaultAgentId = ''
  draftBinding.targetProjectId = ''
  draftBinding.incomingSecret = ''
  draftBinding.outgoingWebhookUrl = ''
  draftBinding.appId = ''
  draftBinding.appSecret = ''
  draftBinding.verificationToken = ''
  draftBinding.encryptKey = ''
  draftBinding.botUserId = ''
  draftBinding.autoReply = false
  draftBinding.requireApprovalForRiskyTools = true
}

function loadBindingIntoDraft (binding?: ChannelBinding | null) {
  if (!binding) {
    resetBindingDraft()
    return
  }

  draftBinding.id = binding.id
  draftBinding.connectorType = binding.connectorType
  draftBinding.name = binding.name || ''
  draftBinding.externalChannelId = binding.externalChannelId
  draftBinding.externalThreadId = binding.externalThreadId || ''
  draftBinding.boundConversationId = binding.boundConversationId || ''
  draftBinding.boundGroupId = binding.boundGroupId || ''
  draftBinding.defaultAgentId = binding.defaultAgentId || ''
  draftBinding.targetProjectId = binding.targetProjectId || ''
  draftBinding.incomingSecret = binding.incomingSecret || ''
  draftBinding.outgoingWebhookUrl = binding.outgoingWebhookUrl || ''
  draftBinding.appId = binding.appId || ''
  draftBinding.appSecret = binding.appSecret || ''
  draftBinding.verificationToken = binding.verificationToken || ''
  draftBinding.encryptKey = binding.encryptKey || ''
  draftBinding.botUserId = binding.botUserId || ''
  draftBinding.autoReply = binding.autoReply
  draftBinding.requireApprovalForRiskyTools = binding.requireApprovalForRiskyTools
}

async function loadAgents () {
  if (!window.electronAPI?.listAgents) return
  agents.value = await window.electronAPI.listAgents()
  if (!draftAgent.id && agents.value.length > 0) {
    loadAgentIntoDraft(agents.value[0])
  }
}

async function loadGroups () {
  if (!window.electronAPI?.listAgentGroups) return
  groups.value = await window.electronAPI.listAgentGroups()
  if (!draftGroup.id && groups.value.length > 0) {
    loadGroupIntoDraft(groups.value[0])
  }
}

async function loadBindings () {
  if (!window.electronAPI?.listChannelBindings || !window.electronAPI?.listImConnectors) return
  const [nextBindings, nextConnectors] = await Promise.all([
    window.electronAPI.listChannelBindings(),
    window.electronAPI.listImConnectors()
  ])
  bindings.value = nextBindings
  connectors.value = nextConnectors
  if (!draftBinding.id && bindings.value.length > 0) {
    loadBindingIntoDraft(bindings.value[0])
  }
}

async function loadProvidersCatalog () {
  if (!window.electronAPI?.getProviders) return
  providersConfig.value = await window.electronAPI.getProviders()
  if (!draftAgent.id && !draftAgent.providerId) {
    const defaults = getDefaultProviderSelection()
    draftAgent.providerId = defaults.providerId
    draftAgent.modelId = defaults.modelId
  }
  pruneAgentSelections()
}

async function loadSkillsCatalog () {
  if (!window.electronAPI?.listSkills) return
  skills.value = await window.electronAPI.listSkills()
  pruneAgentSelections()
}

async function loadToolCatalog () {
  if (!window.electronAPI?.listAgentToolDefinitions) return
  agentTools.value = await window.electronAPI.listAgentToolDefinitions()
  pruneAgentSelections()
}

async function loadMemory () {
  if (!window.electronAPI?.listMemory) return
  memoryEntries.value = await window.electronAPI.listMemory({
    query: memoryQuery.value || undefined,
    scopeType: memoryScopeId.value ? memoryScopeType.value : undefined,
    scopeId: memoryScopeId.value || undefined,
    limit: 50
  })
}

function clearMemoryScopeFilter () {
  memoryScopeId.value = ''
  void loadMemory()
}

function resetMemoryDraft () {
  draftMemory.title = ''
  draftMemory.summary = ''
  draftMemory.details = ''
  draftMemory.tagsText = ''
  draftMemory.scopeType = memoryScopeType.value
  draftMemory.scopeId = memoryScopeId.value.trim() || (memoryScopeType.value === 'user' ? 'local-user' : '')
  draftMemory.memoryType = 'knowledge'
  draftMemory.pinned = true
}

function toggleMemoryCreator () {
  addingMemory.value = !addingMemory.value
  if (addingMemory.value) {
    resetMemoryDraft()
  }
}

function parseMemoryTags (value: string): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const rawTag of value.split(/[,，\n]/)) {
    const tag = rawTag.trim()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

async function saveManualMemory () {
  if (!window.electronAPI?.saveMemory || savingMemory.value) return

  const title = draftMemory.title.trim()
  const summary = draftMemory.summary.trim()
  const scopeId = draftMemory.scopeId.trim()
  if (!title) {
    setStatus(t('settings.agentWorkspace.requiredMemoryTitle'))
    return
  }
  if (!summary) {
    setStatus(t('settings.agentWorkspace.requiredMemorySummary'))
    return
  }
  if (!scopeId) {
    setStatus(t('settings.agentWorkspace.requiredScopeId'))
    return
  }

  savingMemory.value = true
  try {
    await window.electronAPI.saveMemory({
      title,
      summary,
      details: draftMemory.details.trim() || undefined,
      tags: parseMemoryTags(draftMemory.tagsText),
      scopeType: draftMemory.scopeType,
      scopeId,
      memoryType: draftMemory.memoryType,
      pinned: draftMemory.pinned,
      importance: draftMemory.pinned ? 0.85 : 0.7,
      confidence: 1
    })
    addingMemory.value = false
    await loadMemory()
    setStatus(t('settings.agentWorkspace.memoryAdded'))
    resetMemoryDraft()
  } catch (error) {
    setStatus(t('settings.agentWorkspace.memoryAddFailed', { message: (error as Error).message }))
  } finally {
    savingMemory.value = false
  }
}

async function syncMemoryCompactionStatus () {
  if (!window.electronAPI?.getMemoryCompactionStatus) return
  applyMemoryCompactionStatus(await window.electronAPI.getMemoryCompactionStatus())
}

async function loadAll () {
  await Promise.all([
    loadProvidersCatalog(),
    loadSkillsCatalog(),
    loadToolCatalog(),
    loadAgents(),
    loadGroups(),
    loadBindings(),
    loadMemory()
  ])
}

async function reloadAgentWorkspaceEntities (entity?: 'agent' | 'group' | 'binding') {
  if (entity === 'agent') {
    await Promise.all([loadAgents(), loadGroups(), loadBindings()])
    return
  }

  if (entity === 'group') {
    await Promise.all([loadGroups(), loadBindings()])
    return
  }

  if (entity === 'binding') {
    await loadBindings()
    return
  }

  await Promise.all([loadAgents(), loadGroups(), loadBindings()])
}

async function saveAgent () {
  if (!window.electronAPI?.saveAgent) return
  const saved = await window.electronAPI.saveAgent({
    id: draftAgent.id || undefined,
    name: draftAgent.name,
    icon: draftAgent.icon.trim() || undefined,
    description: draftAgent.description,
    systemPrompt: draftAgent.systemPrompt,
    providerId: draftAgent.providerId || undefined,
    modelId: draftAgent.modelId || undefined,
    reasoningStrength: draftAgent.reasoningStrength,
    skillIds: [...draftAgent.skillIds],
    allowedTools: [...draftAgent.allowedTools],
    deniedTools: [...draftAgent.deniedTools],
    memoryScopes: [...draftAgent.memoryScopes],
    memoryWritePolicy: {
      allowUserTraits: draftAgent.allowUserTraits,
      allowAgentSkills: draftAgent.allowAgentSkills,
      allowSteps: draftAgent.allowSteps,
      allowKnowledge: draftAgent.allowKnowledge
    },
    autoReplyPolicy: {
      enabled: draftAgent.autoReplyEnabled,
      requireMention: draftAgent.autoReplyRequireMention
    }
  })
  await loadAgents()
  loadAgentIntoDraft(saved)
  setStatus(t('settings.agentWorkspace.agentSaved', { name: saved.name }))
}

async function removeAgent () {
  if (!draftAgent.id || !window.electronAPI?.deleteAgent) return
  const deleted = await window.electronAPI.deleteAgent(draftAgent.id)
  if (!deleted) {
    setStatus(t('settings.agentWorkspace.agentDeleteBlocked'))
    return
  }
  resetAgentDraft()
  await loadAgents()
  setStatus(t('settings.agentWorkspace.agentDeleted'))
}

async function saveGroup () {
  if (!window.electronAPI?.saveAgentGroup) return
  const saved = await window.electronAPI.saveAgentGroup({
    id: draftGroup.id || undefined,
    name: draftGroup.name,
    icon: draftGroup.icon.trim() || undefined,
    description: draftGroup.description || undefined,
    coordinatorAgentId: draftGroup.coordinatorAgentId,
    memberAgentIds: [...draftGroup.memberAgentIds],
    maxRounds: draftGroup.maxRounds,
    maxParallelWorkers: draftGroup.maxParallelWorkers,
    sharedMemoryScopes: [...draftGroup.sharedMemoryScopes],
    visibility: draftGroup.visibility
  })
  await loadGroups()
  loadGroupIntoDraft(saved)
  setStatus(t('settings.agentWorkspace.groupSaved', { name: saved.name }))
}

async function removeGroup () {
  if (!draftGroup.id || !window.electronAPI?.deleteAgentGroup) return
  const deleted = await window.electronAPI.deleteAgentGroup(draftGroup.id)
  if (!deleted) {
    setStatus(t('settings.agentWorkspace.groupDeleteFailed'))
    return
  }
  resetGroupDraft()
  await loadGroups()
  setStatus(t('settings.agentWorkspace.groupDeleted'))
}

async function saveBinding () {
  if (!window.electronAPI?.saveChannelBinding) return
  const saved = await window.electronAPI.saveChannelBinding({
    id: draftBinding.id || undefined,
    connectorType: draftBinding.connectorType,
    name: draftBinding.name || undefined,
    externalChannelId: draftBinding.externalChannelId,
    externalThreadId: draftBinding.externalThreadId || undefined,
    boundConversationId: draftBinding.boundConversationId || undefined,
    boundGroupId: draftBinding.boundGroupId || undefined,
    defaultAgentId: draftBinding.defaultAgentId || undefined,
    targetProjectId: draftBinding.targetProjectId || undefined,
    incomingSecret: draftBinding.incomingSecret || undefined,
    outgoingWebhookUrl: draftBinding.outgoingWebhookUrl || undefined,
    appId: draftBinding.appId || undefined,
    appSecret: draftBinding.appSecret || undefined,
    verificationToken: draftBinding.verificationToken || undefined,
    encryptKey: draftBinding.encryptKey || undefined,
    botUserId: draftBinding.botUserId || undefined,
    autoReply: draftBinding.autoReply,
    requireApprovalForRiskyTools: draftBinding.requireApprovalForRiskyTools
  })
  await loadBindings()
  loadBindingIntoDraft(saved)
  setStatus(t('settings.agentWorkspace.bindingSaved', { channel: saved.externalChannelId }))
}

async function removeBinding () {
  if (!draftBinding.id || !window.electronAPI?.deleteChannelBinding) return
  const deleted = await window.electronAPI.deleteChannelBinding(draftBinding.id)
  if (!deleted) {
    setStatus(t('settings.agentWorkspace.bindingDeleteFailed'))
    return
  }
  resetBindingDraft()
  await loadBindings()
  setStatus(t('settings.agentWorkspace.bindingDeleted'))
}

async function testBindingReply () {
  if (!draftBinding.id || !window.electronAPI?.testChannelBinding || bindingTest.running) return
  bindingTest.running = true
  bindingTest.result = ''
  try {
    const result = await window.electronAPI.testChannelBinding(draftBinding.id, bindingTest.text)
    bindingTest.result = result.reply || t('settings.agentWorkspace.noReplyGenerated')
    setStatus(t('settings.agentWorkspace.bindingTestDone'))
  } catch (error) {
    bindingTest.result = t('settings.agentWorkspace.bindingTestFailedWithMessage', { message: (error as Error).message })
    setStatus(t('settings.agentWorkspace.bindingTestFailed'))
  } finally {
    bindingTest.running = false
  }
}

async function toggleMemoryPinned (entry: MemoryEntry) {
  if (!window.electronAPI?.pinMemory) return
  await window.electronAPI.pinMemory(entry.id, !entry.pinned)
  await loadMemory()
}

async function removeMemory (entry: MemoryEntry) {
  if (!window.electronAPI?.deleteMemory) return
  await window.electronAPI.deleteMemory(entry.id)
  await loadMemory()
}

async function compactMemory () {
  if (!window.electronAPI?.compactMemory || memoryCompacting.value) return
  if (!window.confirm(t('settings.agentWorkspace.memoryCompactConfirm'))) return

  memoryCompactionStarting.value = true
  setStatus(t('settings.agentWorkspace.memoryCompactionStarting'))
  try {
    const result = await window.electronAPI.compactMemory()
    await loadMemory()
    setStatus(formatMemoryCompactionResult(result))
  } catch (err) {
    setStatus(t('settings.agentWorkspace.memoryCompactionFailed', { message: (err as Error).message }))
  } finally {
    memoryCompactionStarting.value = false
    void syncMemoryCompactionStatus()
  }
}

onMounted(() => {
  void loadAll()
  void syncMemoryCompactionStatus()

  if (window.electronAPI?.onProvidersChanged) {
    providerChangeCleanup = window.electronAPI.onProvidersChanged(() => {
      void loadProvidersCatalog()
    })
  }

  if (window.electronAPI?.onSkillsChanged) {
    skillsChangeCleanup = window.electronAPI.onSkillsChanged(() => {
      void loadSkillsCatalog()
    })
  }

  if (window.electronAPI?.onAgentWorkspaceChanged) {
    workspaceChangeCleanup = window.electronAPI.onAgentWorkspaceChanged((event) => {
      void reloadAgentWorkspaceEntities(event.entity)
    })
  }

  if (window.electronAPI?.onMemoryCompactionStatusChanged) {
    memoryCompactionCleanup = window.electronAPI.onMemoryCompactionStatusChanged((status) => {
      applyMemoryCompactionStatus(status)
    })
  }
})

onUnmounted(() => {
  providerChangeCleanup?.()
  skillsChangeCleanup?.()
  workspaceChangeCleanup?.()
  memoryCompactionCleanup?.()
})

watch(() => draftAgent.providerId, (nextProviderId, previousProviderId) => {
  if (!nextProviderId || nextProviderId === previousProviderId) return
  syncDraftAgentModel(true)
})

watch(activeTab, (nextTab, previousTab) => {
  if (nextTab !== 'memory' || nextTab === previousTab) return
  void loadMemory()
  void syncMemoryCompactionStatus()
})
</script>

<template>
  <div class="workspace-panel">
    <div class="panel-header">
      <div>
        <h2>{{ $t('settings.agentWorkspace.title') }}</h2>
        <p>{{ $t('settings.agentWorkspace.description') }}</p>
      </div>
      <span v-if="statusMessage" class="status-chip">{{ statusMessage }}</span>
    </div>

    <div class="tab-strip">
      <button :class="['tab-btn', { active: activeTab === 'agents' }]" @click="activeTab = 'agents'">Agent</button>
      <button :class="['tab-btn', { active: activeTab === 'groups' }]" @click="activeTab = 'groups'">{{ $t('settings.agentWorkspace.tabGroups') }}</button>
      <button :class="['tab-btn', { active: activeTab === 'bindings' }]" @click="activeTab = 'bindings'">{{ $t('settings.agentWorkspace.tabBindings') }}</button>
      <button :class="['tab-btn', { active: activeTab === 'memory' }]" @click="activeTab = 'memory'">{{ $t('settings.agentWorkspace.tabMemory') }}</button>
    </div>

    <div v-if="activeTab === 'agents'" class="workspace-grid">
      <aside class="list-panel">
        <div class="list-toolbar">
          <button class="ghost-btn" @click="loadAgentIntoDraft(null)">{{ $t('settings.agentWorkspace.newAgent') }}</button>
          <button class="ghost-btn" @click="loadAgents">{{ $t('settings.agentWorkspace.refresh') }}</button>
        </div>
        <button
          v-for="agent in agents"
          :key="agent.id"
          :class="['list-item', { active: draftAgent.id === agent.id }]"
          @click="loadAgentIntoDraft(agent)"
        >
          <div class="list-item-main">
            <span class="list-item-icon">{{ agent.icon || '🤖' }}</span>
            <div>
              <strong>{{ agent.name }}</strong>
              <span>{{ agent.description || $t('settings.agentWorkspace.noDescription') }}</span>
            </div>
          </div>
        </button>
      </aside>

      <section class="editor-panel">
        <div class="form-grid two-col">
          <label>
            <span>{{ $t('settings.agentWorkspace.name') }}</span>
            <input v-model="draftAgent.name" class="input" :placeholder="$t('settings.agentWorkspace.agentNamePlaceholder')">
          </label>
          <label>
            <span>{{ $t('settings.agentWorkspace.icon') }}</span>
            <input v-model="draftAgent.icon" class="input" maxlength="4" :placeholder="$t('settings.agentWorkspace.agentIconPlaceholder')">
          </label>
        </div>

        <div class="form-grid two-col">
          <label>
            <span>{{ $t('settings.agentWorkspace.reasoningStrength') }}</span>
            <select v-model="draftAgent.reasoningStrength" class="input">
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
          </label>
          <label>
            <span>{{ $t('settings.agentWorkspace.modelProvider') }}</span>
            <select v-model="draftAgent.providerId" class="input">
              <option value="">{{ $t('settings.agentWorkspace.selectProvider') }}</option>
              <option v-for="provider in providersConfig.providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
            </select>
          </label>
          <label>
            <span>{{ $t('settings.agentWorkspace.model') }}</span>
            <select v-model="draftAgent.modelId" class="input" :disabled="!draftAgent.providerId">
              <option value="">{{ $t('settings.agentWorkspace.selectModel') }}</option>
              <option v-for="model in availableModels" :key="model" :value="model">{{ model }}</option>
            </select>
          </label>
        </div>

        <label>
          <span>{{ $t('settings.agentWorkspace.descriptionLabel') }}</span>
          <input v-model="draftAgent.description" class="input" :placeholder="$t('settings.agentWorkspace.agentDescriptionPlaceholder')">
        </label>

        <label>
          <span>{{ $t('settings.agentWorkspace.systemPrompt') }}</span>
          <textarea v-model="draftAgent.systemPrompt" class="textarea" rows="8" :placeholder="$t('settings.agentWorkspace.systemPromptPlaceholder')"></textarea>
        </label>

        <div class="form-grid three-col multi-select-grid">
          <MultiSelectDropdown
            v-model="draftAgent.skillIds"
            :label="$t('settings.agentWorkspace.defaultSkills')"
            :placeholder="$t('settings.agentWorkspace.selectSkills')"
            :search-placeholder="$t('settings.agentWorkspace.searchSkill')"
            :empty-text="$t('settings.agentWorkspace.noInstalledSkills')"
            :options="skillOptions"
          />
          <MultiSelectDropdown
            v-model="draftAgent.allowedTools"
            :label="$t('settings.agentWorkspace.allowedTools')"
            :placeholder="$t('settings.agentWorkspace.emptyMeansUnlimited')"
            :search-placeholder="$t('settings.agentWorkspace.searchTool')"
            :empty-text="$t('settings.agentWorkspace.noTools')"
            :options="toolOptions"
          />
          <MultiSelectDropdown
            v-model="draftAgent.deniedTools"
            :label="$t('settings.agentWorkspace.deniedTools')"
            :placeholder="$t('settings.agentWorkspace.selectDisabledTools')"
            :search-placeholder="$t('settings.agentWorkspace.searchTool')"
            :empty-text="$t('settings.agentWorkspace.noTools')"
            :options="toolOptions"
          />
        </div>

        <div class="check-grid">
          <div>
            <h3>{{ $t('settings.agentWorkspace.memoryScopes') }}</h3>
            <label v-for="scope in ['user', 'agent', 'project', 'group', 'channel']" :key="scope" class="check-row">
              <input
                :checked="draftAgent.memoryScopes.includes(scope as AgentMemoryScope)"
                type="checkbox"
                @change="draftAgent.memoryScopes = toggleStringValue(draftAgent.memoryScopes, scope as AgentMemoryScope)"
              >
              <span>{{ scope }}</span>
            </label>
          </div>

          <div>
            <h3>{{ $t('settings.agentWorkspace.memoryWritePolicy') }}</h3>
            <label class="check-row"><input v-model="draftAgent.allowUserTraits" type="checkbox"><span>{{ $t('settings.agentWorkspace.keepUserTraits') }}</span></label>
            <label class="check-row"><input v-model="draftAgent.allowAgentSkills" type="checkbox"><span>{{ $t('settings.agentWorkspace.keepAgentSkills') }}</span></label>
            <label class="check-row"><input v-model="draftAgent.allowSteps" type="checkbox"><span>{{ $t('settings.agentWorkspace.keepImportantSteps') }}</span></label>
            <label class="check-row"><input v-model="draftAgent.allowKnowledge" type="checkbox"><span>{{ $t('settings.agentWorkspace.keepKnowledge') }}</span></label>
          </div>

          <div>
            <h3>{{ $t('settings.agentWorkspace.autoReply') }}</h3>
            <label class="check-row"><input v-model="draftAgent.autoReplyEnabled" type="checkbox"><span>{{ $t('settings.agentWorkspace.enableAutoReply') }}</span></label>
            <label class="check-row"><input v-model="draftAgent.autoReplyRequireMention" type="checkbox"><span>{{ $t('settings.agentWorkspace.requireMention') }}</span></label>
          </div>
        </div>

        <div class="action-row">
          <button class="primary-btn" @click="saveAgent">{{ $t('settings.agentWorkspace.saveAgent') }}</button>
          <button class="ghost-btn" @click="removeAgent" :disabled="!draftAgent.id">{{ $t('settings.agentWorkspace.deleteAgent') }}</button>
        </div>
      </section>
    </div>

    <div v-else-if="activeTab === 'groups'" class="workspace-grid">
      <aside class="list-panel">
        <div class="list-toolbar">
          <button class="ghost-btn" @click="loadGroupIntoDraft(null)">{{ $t('settings.agentWorkspace.newGroup') }}</button>
          <button class="ghost-btn" @click="loadGroups">{{ $t('settings.agentWorkspace.refresh') }}</button>
        </div>
        <button
          v-for="group in groups"
          :key="group.id"
          :class="['list-item', { active: draftGroup.id === group.id }]"
          @click="loadGroupIntoDraft(group)"
        >
          <div class="list-item-main">
            <span class="list-item-icon group">{{ group.icon || '👥' }}</span>
            <div>
              <strong>{{ group.name }}</strong>
              <span>{{ group.description || $t('settings.agentWorkspace.noDescription') }}</span>
            </div>
          </div>
        </button>
      </aside>

      <section class="editor-panel">
        <div class="form-grid two-col">
          <label>
            <span>{{ $t('settings.agentWorkspace.groupName') }}</span>
            <input v-model="draftGroup.name" class="input" :placeholder="$t('settings.agentWorkspace.groupNamePlaceholder')">
          </label>
          <label>
            <span>{{ $t('settings.agentWorkspace.icon') }}</span>
            <input v-model="draftGroup.icon" class="input" maxlength="4" :placeholder="$t('settings.agentWorkspace.groupIconPlaceholder')">
          </label>
        </div>

        <div class="form-grid two-col">
          <label>
            <span>{{ $t('settings.agentWorkspace.coordinatorAgent') }}</span>
            <select v-model="draftGroup.coordinatorAgentId" class="input">
              <option value="">{{ $t('settings.agentWorkspace.pleaseSelect') }}</option>
              <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
            </select>
          </label>
        </div>

        <label>
          <span>{{ $t('settings.agentWorkspace.descriptionLabel') }}</span>
          <input v-model="draftGroup.description" class="input" :placeholder="$t('settings.agentWorkspace.groupDescriptionPlaceholder')">
        </label>

        <div class="form-grid two-col">
          <label>
            <span>{{ $t('settings.agentWorkspace.maxRounds') }}</span>
            <input v-model.number="draftGroup.maxRounds" class="input" min="1" max="5" type="number">
          </label>
          <label>
            <span>{{ $t('settings.agentWorkspace.maxParallelWorkers') }}</span>
            <input v-model.number="draftGroup.maxParallelWorkers" class="input" min="1" max="5" type="number">
          </label>
        </div>

        <div class="check-grid">
          <div>
            <h3>{{ $t('settings.agentWorkspace.members') }}</h3>
            <label v-for="agent in agents" :key="agent.id" class="check-row">
              <input
                :checked="draftGroup.memberAgentIds.includes(agent.id)"
                type="checkbox"
                @change="draftGroup.memberAgentIds = toggleStringValue(draftGroup.memberAgentIds, agent.id)"
              >
              <span>{{ agent.name }}</span>
            </label>
          </div>

          <div>
            <h3>{{ $t('settings.agentWorkspace.sharedMemoryScopes') }}</h3>
            <label v-for="scope in ['group', 'project', 'channel']" :key="scope" class="check-row">
              <input
                :checked="draftGroup.sharedMemoryScopes.includes(scope as 'group' | 'project' | 'channel')"
                type="checkbox"
                @change="draftGroup.sharedMemoryScopes = toggleStringValue(draftGroup.sharedMemoryScopes, scope as 'group' | 'project' | 'channel')"
              >
              <span>{{ scope }}</span>
            </label>
          </div>

          <div>
            <h3>{{ $t('settings.agentWorkspace.visibility') }}</h3>
            <label class="check-row"><input v-model="draftGroup.visibility" type="radio" value="summary_only"><span>{{ $t('settings.agentWorkspace.summaryOnly') }}</span></label>
            <label class="check-row"><input v-model="draftGroup.visibility" type="radio" value="expandable_internal_transcript"><span>{{ $t('settings.agentWorkspace.expandableTranscript') }}</span></label>
          </div>
        </div>

        <div class="action-row">
          <button class="primary-btn" @click="saveGroup">{{ $t('settings.agentWorkspace.saveGroup') }}</button>
          <button class="ghost-btn" @click="removeGroup" :disabled="!draftGroup.id">{{ $t('settings.agentWorkspace.deleteGroup') }}</button>
        </div>
      </section>
    </div>

    <div v-else-if="activeTab === 'bindings'" class="workspace-grid">
      <aside class="list-panel">
        <div class="list-toolbar">
          <button class="ghost-btn" @click="loadBindingIntoDraft(null)">{{ $t('settings.agentWorkspace.newBinding') }}</button>
          <button class="ghost-btn" @click="loadBindings">{{ $t('settings.agentWorkspace.refresh') }}</button>
        </div>
        <button
          v-for="binding in bindings"
          :key="binding.id"
          :class="['list-item', { active: draftBinding.id === binding.id }]"
          @click="loadBindingIntoDraft(binding)"
        >
          <strong>{{ binding.name || `${binding.connectorType} · ${binding.externalChannelId || binding.id}` }}</strong>
          <span>{{ binding.autoReply ? $t('settings.agentWorkspace.autoReply') : $t('settings.agentWorkspace.receiveOnly') }} · {{ binding.defaultAgentId || binding.boundGroupId || $t('settings.agentWorkspace.defaultModel') }}</span>
        </button>
      </aside>

      <section class="editor-panel">
        <div class="form-grid two-col">
          <label>
            <span>{{ $t('settings.agentWorkspace.bindingName') }}</span>
            <input v-model="draftBinding.name" class="input" :placeholder="$t('settings.agentWorkspace.bindingNamePlaceholder')">
          </label>
          <label>
            <span>{{ $t('settings.agentWorkspace.connector') }}</span>
            <select v-model="draftBinding.connectorType" class="input">
              <option v-for="connector in connectors" :key="connector.id" :value="connector.id">{{ connector.name }}</option>
            </select>
          </label>
        </div>

        <div class="binding-endpoint-card">
          <div>
            <strong>{{ selectedConnector?.name || draftBinding.connectorType }}</strong>
            <span>{{ selectedConnector?.description }}</span>
          </div>
          <div class="binding-endpoint-list">
            <code>{{ bindingWebhookUrl }}</code>
            <code v-if="draftBinding.connectorType === 'custom'">{{ bindingOpenClawUrl }}</code>
          </div>
        </div>

        <div class="form-grid two-col">
          <label>
            <span>{{ $t('settings.agentWorkspace.defaultAgent') }}</span>
            <select v-model="draftBinding.defaultAgentId" class="input">
              <option value="">{{ $t('settings.agentWorkspace.none') }}</option>
              <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
            </select>
          </label>
        </div>

        <div class="form-grid two-col">
          <label>
            <span>{{ $t('settings.agentWorkspace.externalChannelId') }}</span>
            <input v-model="draftBinding.externalChannelId" class="input" :placeholder="$t('settings.agentWorkspace.required')">
          </label>
          <label>
            <span>{{ $t('settings.agentWorkspace.externalThreadId') }}</span>
            <input v-model="draftBinding.externalThreadId" class="input" :placeholder="$t('settings.agentWorkspace.optional')">
          </label>
        </div>

        <div class="form-grid three-col">
          <label>
            <span>{{ $t('settings.agentWorkspace.boundConversationId') }}</span>
            <input v-model="draftBinding.boundConversationId" class="input" :placeholder="$t('settings.agentWorkspace.optional')">
          </label>
          <label>
            <span>{{ $t('settings.agentWorkspace.boundGroup') }}</span>
            <select v-model="draftBinding.boundGroupId" class="input">
              <option value="">{{ $t('settings.agentWorkspace.none') }}</option>
              <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
            </select>
          </label>
          <label>
            <span>{{ $t('settings.agentWorkspace.targetProjectId') }}</span>
            <input v-model="draftBinding.targetProjectId" class="input" :placeholder="$t('settings.agentWorkspace.optional')">
          </label>
        </div>

        <div v-if="selectedConnector?.credentialFields.length" class="form-grid two-col">
          <label v-for="field in selectedConnector.credentialFields" :key="field.key">
            <span>{{ field.label }}</span>
            <input
              v-model="draftBinding[field.key]"
              class="input"
              :type="field.secret ? 'password' : 'text'"
              :placeholder="field.placeholder || $t('settings.agentWorkspace.optional')"
            >
          </label>
        </div>

        <div class="form-grid two-col">
          <label>
            <span>{{ $t('settings.agentWorkspace.botUserId') }}</span>
            <input v-model="draftBinding.botUserId" class="input" :placeholder="$t('settings.agentWorkspace.botUserIdPlaceholder')">
          </label>
        </div>

        <div class="check-grid single-col">
          <label class="check-row"><input v-model="draftBinding.autoReply" type="checkbox"><span>{{ $t('settings.agentWorkspace.autoReply') }}</span></label>
          <label class="check-row"><input v-model="draftBinding.requireApprovalForRiskyTools" type="checkbox"><span>{{ $t('settings.agentWorkspace.requireRiskyApproval') }}</span></label>
        </div>

        <div class="binding-test-card">
          <div class="binding-test-head">
            <strong>{{ $t('settings.agentWorkspace.localTest') }}</strong>
            <span>{{ $t('settings.agentWorkspace.localTestHint') }}</span>
          </div>
          <div class="binding-test-row">
            <input v-model="bindingTest.text" class="input" :placeholder="$t('settings.agentWorkspace.bindingTestPlaceholder')">
            <button class="ghost-btn" type="button" :disabled="!draftBinding.id || bindingTest.running" @click="testBindingReply">
              {{ bindingTest.running ? $t('settings.agentWorkspace.testing') : $t('settings.agentWorkspace.sendTest') }}
            </button>
          </div>
          <p v-if="bindingTest.result" class="binding-test-result">{{ bindingTest.result }}</p>
        </div>

        <div class="action-row">
          <button class="primary-btn" @click="saveBinding">{{ $t('settings.agentWorkspace.saveBinding') }}</button>
          <button class="ghost-btn" @click="removeBinding" :disabled="!draftBinding.id">{{ $t('settings.agentWorkspace.deleteBinding') }}</button>
        </div>
      </section>
    </div>

    <div v-else class="memory-panel">
      <div class="memory-toolbar">
        <input
          v-model="memoryQuery"
          class="input memory-search"
          type="search"
          :placeholder="$t('settings.agentWorkspace.memorySearchPlaceholder')"
          @keyup.enter="loadMemory"
        >
        <span :class="['memory-filter-pill', { active: hasMemoryScopeFilter }]">{{ memoryScopeFilterText }}</span>
        <button class="primary-btn" type="button" @click="loadMemory">{{ $t('settings.agentWorkspace.query') }}</button>
        <button :class="['ghost-btn', { active: showMemoryFilters }]" type="button" @click="showMemoryFilters = !showMemoryFilters">{{ $t('settings.agentWorkspace.filter') }}</button>
        <button class="ghost-btn" type="button" @click="toggleMemoryCreator">{{ addingMemory ? $t('settings.agentWorkspace.collapseAdd') : $t('settings.agentWorkspace.manualAdd') }}</button>
        <button class="ghost-btn" :disabled="memoryCompacting" @click="compactMemory">
          {{ memoryCompacting ? $t('settings.agentWorkspace.compacting') : $t('settings.agentWorkspace.aiCompact') }}
        </button>
      </div>

      <div v-if="showMemoryFilters" class="memory-filter-row">
        <label>
          <span>{{ $t('settings.agentWorkspace.scope') }}</span>
          <select v-model="memoryScopeType" class="input memory-scope-select">
            <option v-for="option in memoryScopeOptions" :key="option.value" :value="option.value">{{ $t(option.labelKey) }}</option>
          </select>
        </label>
        <label>
          <span>Scope ID</span>
          <input v-model="memoryScopeId" class="input memory-scope-id" placeholder="local-user / agent_xxx / project_xxx" @keyup.enter="loadMemory">
        </label>
        <button class="ghost-btn" type="button" :disabled="!hasMemoryScopeFilter" @click="clearMemoryScopeFilter">{{ $t('settings.agentWorkspace.all') }}</button>
      </div>

      <form v-if="addingMemory" class="memory-create-card" @submit.prevent="saveManualMemory">
        <div class="memory-create-grid">
          <label>
            <span>{{ $t('settings.agentWorkspace.memoryTitle') }}</span>
            <input v-model="draftMemory.title" class="input" :placeholder="$t('settings.agentWorkspace.memoryTitlePlaceholder')">
          </label>
          <label>
            <span>{{ $t('settings.agentWorkspace.type') }}</span>
            <select v-model="draftMemory.memoryType" class="input">
              <option v-for="option in memoryTypeOptions" :key="option.value" :value="option.value">{{ $t(option.labelKey) }}</option>
            </select>
          </label>
          <label>
            <span>{{ $t('settings.agentWorkspace.scope') }}</span>
            <select v-model="draftMemory.scopeType" class="input">
              <option v-for="option in memoryScopeOptions" :key="option.value" :value="option.value">{{ $t(option.labelKey) }}</option>
            </select>
          </label>
          <label>
            <span>Scope ID</span>
            <input v-model="draftMemory.scopeId" class="input" placeholder="local-user / agent_xxx / project_xxx">
          </label>
          <label class="memory-create-summary">
            <span>{{ $t('settings.agentWorkspace.summary') }}</span>
            <textarea v-model="draftMemory.summary" class="textarea" rows="2" :placeholder="$t('settings.agentWorkspace.memorySummaryPlaceholder')" />
          </label>
          <label class="memory-create-summary">
            <span>{{ $t('settings.agentWorkspace.details') }}</span>
            <textarea v-model="draftMemory.details" class="textarea" rows="3" :placeholder="$t('settings.agentWorkspace.memoryDetailsPlaceholder')" />
          </label>
          <label>
            <span>{{ $t('settings.agentWorkspace.tags') }}</span>
            <input v-model="draftMemory.tagsText" class="input" :placeholder="$t('settings.agentWorkspace.tagsPlaceholder')">
          </label>
          <label class="check-row memory-pin-row">
            <input v-model="draftMemory.pinned" type="checkbox">
            <span>{{ $t('settings.agentWorkspace.pin') }}</span>
          </label>
        </div>
        <div class="action-row memory-create-actions">
          <button class="primary-btn" type="submit" :disabled="savingMemory">{{ savingMemory ? $t('common.saving') : $t('settings.agentWorkspace.saveMemory') }}</button>
          <button class="ghost-btn" type="button" @click="addingMemory = false">{{ $t('common.cancel') }}</button>
        </div>
      </form>

      <div v-if="memoryCompactionProgressText" class="memory-progress" role="status">
        <span>{{ memoryCompactionProgressText }}</span>
      </div>

      <div class="memory-list">
        <div v-if="memoryEntries.length === 0" class="memory-empty">
          {{ $t('settings.agentWorkspace.noMemoryMatches') }}
        </div>
        <article v-for="entry in memoryEntries" :key="entry.id" class="memory-card">
          <div class="memory-card-head">
            <div>
              <strong>{{ entry.title }}</strong>
              <span>{{ memoryTypeLabel(entry.memoryType) }} · {{ memoryScopeLabel(entry.scopeType) }} / {{ entry.scopeId }}</span>
            </div>
            <div class="memory-actions">
              <button class="ghost-btn small" @click="toggleMemoryPinned(entry)">{{ entry.pinned ? $t('settings.agentWorkspace.unpin') : $t('settings.agentWorkspace.pin') }}</button>
              <button class="ghost-btn small danger" @click="removeMemory(entry)">{{ $t('common.delete') }}</button>
            </div>
          </div>
          <p>{{ entry.summary }}</p>
          <p v-if="entry.details" class="memory-details">{{ entry.details }}</p>
          <small>{{ entry.tags.join(', ') || $t('settings.agentWorkspace.noTags') }}</small>
        </article>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workspace-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 18px 20px;
  gap: 14px;
  overflow: hidden;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.panel-header h2 {
  margin: 0 0 6px;
  font-size: 1.05rem;
}

.panel-header p {
  margin: 0;
  color: var(--app-text-soft);
  font-size: 0.9rem;
}

.status-chip {
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--app-accent-soft);
  color: var(--app-accent);
  font-size: 0.8rem;
  white-space: nowrap;
}

.tab-strip {
  display: flex;
  gap: 8px;
}

.tab-btn,
.ghost-btn,
.primary-btn {
  border: 1px solid var(--app-border);
  background: var(--app-panel);
  color: var(--app-text);
  border-radius: 10px;
  padding: 8px 12px;
  cursor: pointer;
}

.tab-btn.active,
.primary-btn {
  background: var(--app-accent-soft);
  border-color: var(--app-accent);
  color: var(--app-accent);
}

.ghost-btn.active {
  background: var(--app-accent-soft);
  border-color: color-mix(in srgb, var(--app-accent) 58%, var(--app-border));
  color: var(--app-accent);
}

.tab-btn:disabled,
.ghost-btn:disabled,
.primary-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ghost-btn.small {
  padding: 5px 8px;
  font-size: 0.8rem;
}

.ghost-btn.danger {
  color: #ef4444;
}

.workspace-grid {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 14px;
  min-height: 0;
  flex: 1;
}

.list-panel,
.editor-panel,
.memory-panel {
  min-height: 0;
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: 16px;
}

.list-panel {
  display: flex;
  flex-direction: column;
  padding: 10px;
  gap: 8px;
  overflow: auto;
}

.list-toolbar,
.action-row,
.memory-toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.list-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--app-border);
  background: var(--app-main-surface);
  color: var(--app-text);
  cursor: pointer;
  text-align: left;
}

.list-item-main {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
}

.list-item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-accent) 12%, var(--app-panel));
  font-size: 1rem;
  flex-shrink: 0;
}

.list-item-icon.group {
  background: color-mix(in srgb, #14b8a6 16%, var(--app-panel));
}

.list-item.active {
  border-color: var(--app-accent);
  background: var(--app-accent-soft);
}

.list-item span {
  color: var(--app-text-soft);
  font-size: 0.82rem;
}

.editor-panel,
.memory-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  overflow: auto;
}

.form-grid {
  display: grid;
  gap: 12px;
}

.form-grid.two-col {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.form-grid.three-col {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.multi-select-grid {
  align-items: start;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--app-text-soft);
  font-size: 0.88rem;
}

.input,
.textarea {
  width: 100%;
  border: 1px solid var(--app-input-border);
  background: var(--app-input-bg);
  color: var(--app-text);
  border-radius: 10px;
  padding: 10px 12px;
  box-sizing: border-box;
}

.textarea {
  resize: vertical;
}

.check-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.check-grid.single-col {
  grid-template-columns: 1fr;
}

.check-grid h3 {
  margin: 0 0 8px;
  font-size: 0.9rem;
  color: var(--app-text);
}

.check-row {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.binding-endpoint-card {
  display: grid;
  grid-template-columns: minmax(180px, 0.7fr) minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-main-surface);
}

.binding-endpoint-card strong,
.binding-endpoint-card span {
  display: block;
}

.binding-endpoint-card span {
  margin-top: 4px;
  color: var(--app-text-soft);
  font-size: 0.82rem;
  line-height: 1.45;
}

.binding-endpoint-card code {
  min-width: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--app-panel-subtle);
  color: var(--app-text);
  font-size: 0.78rem;
  overflow-wrap: anywhere;
}

.binding-endpoint-list {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.binding-test-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-accent-soft) 18%, var(--app-main-surface));
}

.binding-test-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.binding-test-head span {
  color: var(--app-text-soft);
  font-size: 0.82rem;
}

.binding-test-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.binding-test-result {
  margin: 0;
  color: var(--app-text);
  font-size: 0.86rem;
  line-height: 1.5;
  white-space: pre-wrap;
}

.memory-toolbar {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto auto auto auto auto;
  align-items: center;
  gap: 8px;
}

.memory-toolbar .input,
.memory-toolbar .ghost-btn,
.memory-toolbar .primary-btn {
  min-height: 34px;
  padding-top: 7px;
  padding-bottom: 7px;
}

.memory-filter-pill {
  display: inline-flex;
  align-items: center;
  max-width: 220px;
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: var(--app-main-surface);
  color: var(--app-text-soft);
  font-size: 0.8rem;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.memory-filter-pill.active {
  border-color: color-mix(in srgb, var(--app-accent) 38%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 48%, var(--app-main-surface));
  color: var(--app-accent);
}

.memory-filter-row {
  display: grid;
  grid-template-columns: minmax(118px, 160px) minmax(220px, 320px) auto;
  align-items: end;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-main-surface);
}

.memory-filter-row label {
  gap: 4px;
}

.memory-filter-row label span {
  font-size: 0.78rem;
}

.memory-filter-row .input,
.memory-filter-row .ghost-btn {
  min-height: 34px;
  padding-top: 7px;
  padding-bottom: 7px;
}

.memory-search,
.memory-scope-id,
.memory-scope-select {
  min-width: 0;
}

.memory-create-card {
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-main-surface);
}

.memory-create-grid {
  display: grid;
  grid-template-columns: minmax(180px, 1.2fr) minmax(120px, 0.65fr) minmax(120px, 0.65fr) minmax(150px, 1fr);
  gap: 10px;
}

.memory-create-summary {
  grid-column: 1 / -1;
}

.memory-pin-row {
  align-self: end;
  min-height: 38px;
}

.memory-create-actions {
  justify-content: flex-end;
  margin-top: 10px;
}

.memory-progress {
  display: flex;
  align-items: center;
  min-height: 34px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 26%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 38%, transparent);
  color: var(--app-text-soft);
  font-size: 0.82rem;
}

.memory-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.memory-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 96px;
  border: 1px dashed var(--app-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-main-surface) 68%, transparent);
  color: var(--app-text-soft);
  font-size: 0.86rem;
}

.memory-card {
  border: 1px solid var(--app-border);
  border-radius: 12px;
  padding: 12px;
  background: var(--app-main-surface);
}

.memory-card-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.memory-card-head span,
.memory-card small {
  display: block;
  margin-top: 4px;
  color: var(--app-text-soft);
}

.memory-card p {
  margin: 10px 0 0;
  color: var(--app-text);
}

.memory-card .memory-details {
  margin-top: 6px;
  color: var(--app-text-soft);
  font-size: 0.82rem;
  line-height: 1.5;
  white-space: pre-wrap;
}

.memory-actions {
  display: flex;
  gap: 8px;
}

@media (max-width: 1100px) {
  .binding-endpoint-card,
  .memory-filter-row,
  .memory-create-grid {
    grid-template-columns: 1fr 1fr;
  }

  .binding-endpoint-card code,
  .binding-test-row,
  .memory-filter-row label:nth-child(2),
  .memory-create-summary {
    grid-column: 1 / -1;
  }

  .binding-test-row {
    grid-template-columns: 1fr;
  }
}
</style>
