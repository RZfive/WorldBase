<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import MultiSelectDropdown from './MultiSelectDropdown.vue'

interface ToolCatalogEntry {
  name: string
  description: string
}

type WorkspaceTab = 'agents' | 'groups' | 'bindings' | 'memory'

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
const statusMessage = ref('')
let providerChangeCleanup: (() => void) | null = null
let skillsChangeCleanup: (() => void) | null = null
let workspaceChangeCleanup: (() => void) | null = null

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
  externalChannelId: '',
  externalThreadId: '',
  boundConversationId: '',
  boundGroupId: '',
  defaultAgentId: '',
  targetProjectId: '',
  autoReply: false,
  requireApprovalForRiskyTools: true
})

function setStatus (message: string) {
  statusMessage.value = message
}

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
  draftBinding.externalChannelId = ''
  draftBinding.externalThreadId = ''
  draftBinding.boundConversationId = ''
  draftBinding.boundGroupId = ''
  draftBinding.defaultAgentId = ''
  draftBinding.targetProjectId = ''
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
  draftBinding.externalChannelId = binding.externalChannelId
  draftBinding.externalThreadId = binding.externalThreadId || ''
  draftBinding.boundConversationId = binding.boundConversationId || ''
  draftBinding.boundGroupId = binding.boundGroupId || ''
  draftBinding.defaultAgentId = binding.defaultAgentId || ''
  draftBinding.targetProjectId = binding.targetProjectId || ''
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
  setStatus(`已保存 Agent: ${saved.name}`)
}

async function removeAgent () {
  if (!draftAgent.id || !window.electronAPI?.deleteAgent) return
  const deleted = await window.electronAPI.deleteAgent(draftAgent.id)
  if (!deleted) {
    setStatus('默认 Agent 不能删除，或删除失败')
    return
  }
  resetAgentDraft()
  await loadAgents()
  setStatus('已删除 Agent')
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
  setStatus(`已保存群组: ${saved.name}`)
}

async function removeGroup () {
  if (!draftGroup.id || !window.electronAPI?.deleteAgentGroup) return
  const deleted = await window.electronAPI.deleteAgentGroup(draftGroup.id)
  if (!deleted) {
    setStatus('删除群组失败')
    return
  }
  resetGroupDraft()
  await loadGroups()
  setStatus('已删除群组')
}

async function saveBinding () {
  if (!window.electronAPI?.saveChannelBinding) return
  const saved = await window.electronAPI.saveChannelBinding({
    id: draftBinding.id || undefined,
    connectorType: draftBinding.connectorType,
    externalChannelId: draftBinding.externalChannelId,
    externalThreadId: draftBinding.externalThreadId || undefined,
    boundConversationId: draftBinding.boundConversationId || undefined,
    boundGroupId: draftBinding.boundGroupId || undefined,
    defaultAgentId: draftBinding.defaultAgentId || undefined,
    targetProjectId: draftBinding.targetProjectId || undefined,
    autoReply: draftBinding.autoReply,
    requireApprovalForRiskyTools: draftBinding.requireApprovalForRiskyTools
  })
  await loadBindings()
  loadBindingIntoDraft(saved)
  setStatus(`已保存 IM 绑定: ${saved.externalChannelId}`)
}

async function removeBinding () {
  if (!draftBinding.id || !window.electronAPI?.deleteChannelBinding) return
  const deleted = await window.electronAPI.deleteChannelBinding(draftBinding.id)
  if (!deleted) {
    setStatus('删除 IM 绑定失败')
    return
  }
  resetBindingDraft()
  await loadBindings()
  setStatus('已删除 IM 绑定')
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

onMounted(() => {
  void loadAll()

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
})

onUnmounted(() => {
  providerChangeCleanup?.()
  skillsChangeCleanup?.()
  workspaceChangeCleanup?.()
})

watch(() => draftAgent.providerId, (nextProviderId, previousProviderId) => {
  if (!nextProviderId || nextProviderId === previousProviderId) return
  syncDraftAgentModel(true)
})

watch(activeTab, (nextTab, previousTab) => {
  if (nextTab !== 'memory' || nextTab === previousTab) return
  void loadMemory()
})
</script>

<template>
  <div class="workspace-panel">
    <div class="panel-header">
      <div>
        <h2>Agent 工作台</h2>
        <p>管理自定义 Agent、Agent 群组、IM 绑定以及长期记忆。</p>
      </div>
      <span v-if="statusMessage" class="status-chip">{{ statusMessage }}</span>
    </div>

    <div class="tab-strip">
      <button :class="['tab-btn', { active: activeTab === 'agents' }]" @click="activeTab = 'agents'">Agent</button>
      <button :class="['tab-btn', { active: activeTab === 'groups' }]" @click="activeTab = 'groups'">群组</button>
      <button :class="['tab-btn', { active: activeTab === 'bindings' }]" @click="activeTab = 'bindings'">IM 绑定</button>
      <button :class="['tab-btn', { active: activeTab === 'memory' }]" @click="activeTab = 'memory'">记忆</button>
    </div>

    <div v-if="activeTab === 'agents'" class="workspace-grid">
      <aside class="list-panel">
        <div class="list-toolbar">
          <button class="ghost-btn" @click="loadAgentIntoDraft(null)">新建 Agent</button>
          <button class="ghost-btn" @click="loadAgents">刷新</button>
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
              <span>{{ agent.description || '无描述' }}</span>
            </div>
          </div>
        </button>
      </aside>

      <section class="editor-panel">
        <div class="form-grid two-col">
          <label>
            <span>名称</span>
            <input v-model="draftAgent.name" class="input" placeholder="例如：前端实施 Agent">
          </label>
          <label>
            <span>图标</span>
            <input v-model="draftAgent.icon" class="input" maxlength="4" placeholder="例如：🤖">
          </label>
        </div>

        <div class="form-grid two-col">
          <label>
            <span>推理强度</span>
            <select v-model="draftAgent.reasoningStrength" class="input">
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
          </label>
          <label>
            <span>模型供应商</span>
            <select v-model="draftAgent.providerId" class="input">
              <option value="">请选择供应商</option>
              <option v-for="provider in providersConfig.providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
            </select>
          </label>
          <label>
            <span>模型</span>
            <select v-model="draftAgent.modelId" class="input" :disabled="!draftAgent.providerId">
              <option value="">请选择模型</option>
              <option v-for="model in availableModels" :key="model" :value="model">{{ model }}</option>
            </select>
          </label>
        </div>

        <label>
          <span>描述</span>
          <input v-model="draftAgent.description" class="input" placeholder="该 Agent 的职责与边界">
        </label>

        <label>
          <span>系统提示词</span>
          <textarea v-model="draftAgent.systemPrompt" class="textarea" rows="8" placeholder="这里写 Agent 专属提示词"></textarea>
        </label>

        <div class="form-grid three-col multi-select-grid">
          <MultiSelectDropdown
            v-model="draftAgent.skillIds"
            label="默认 Skills"
            placeholder="选择一个或多个 Skill"
            search-placeholder="搜索 Skill"
            empty-text="暂无已安装 Skill"
            :options="skillOptions"
          />
          <MultiSelectDropdown
            v-model="draftAgent.allowedTools"
            label="允许工具"
            placeholder="留空表示不限制"
            search-placeholder="搜索工具"
            empty-text="暂无可选工具"
            :options="toolOptions"
          />
          <MultiSelectDropdown
            v-model="draftAgent.deniedTools"
            label="拒绝工具"
            placeholder="选择要禁用的工具"
            search-placeholder="搜索工具"
            empty-text="暂无可选工具"
            :options="toolOptions"
          />
        </div>

        <div class="check-grid">
          <div>
            <h3>记忆作用域</h3>
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
            <h3>记忆写入策略</h3>
            <label class="check-row"><input v-model="draftAgent.allowUserTraits" type="checkbox"><span>保留用户特征</span></label>
            <label class="check-row"><input v-model="draftAgent.allowAgentSkills" type="checkbox"><span>保留 Agent 技能</span></label>
            <label class="check-row"><input v-model="draftAgent.allowSteps" type="checkbox"><span>保留重要步骤</span></label>
            <label class="check-row"><input v-model="draftAgent.allowKnowledge" type="checkbox"><span>保留知识点</span></label>
          </div>

          <div>
            <h3>自动回复</h3>
            <label class="check-row"><input v-model="draftAgent.autoReplyEnabled" type="checkbox"><span>启用自动回复</span></label>
            <label class="check-row"><input v-model="draftAgent.autoReplyRequireMention" type="checkbox"><span>需要 @ 才回复</span></label>
          </div>
        </div>

        <div class="action-row">
          <button class="primary-btn" @click="saveAgent">保存 Agent</button>
          <button class="ghost-btn" @click="removeAgent" :disabled="!draftAgent.id">删除 Agent</button>
        </div>
      </section>
    </div>

    <div v-else-if="activeTab === 'groups'" class="workspace-grid">
      <aside class="list-panel">
        <div class="list-toolbar">
          <button class="ghost-btn" @click="loadGroupIntoDraft(null)">新建群组</button>
          <button class="ghost-btn" @click="loadGroups">刷新</button>
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
              <span>{{ group.description || '无描述' }}</span>
            </div>
          </div>
        </button>
      </aside>

      <section class="editor-panel">
        <div class="form-grid two-col">
          <label>
            <span>群组名称</span>
            <input v-model="draftGroup.name" class="input" placeholder="例如：前端修复组">
          </label>
          <label>
            <span>图标</span>
            <input v-model="draftGroup.icon" class="input" maxlength="4" placeholder="例如：👥">
          </label>
        </div>

        <div class="form-grid two-col">
          <label>
            <span>协调 Agent</span>
            <select v-model="draftGroup.coordinatorAgentId" class="input">
              <option value="">请选择</option>
              <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
            </select>
          </label>
        </div>

        <label>
          <span>描述</span>
          <input v-model="draftGroup.description" class="input" placeholder="群组的目标与职责">
        </label>

        <div class="form-grid two-col">
          <label>
            <span>最大轮次</span>
            <input v-model.number="draftGroup.maxRounds" class="input" min="1" max="5" type="number">
          </label>
          <label>
            <span>最大并行成员</span>
            <input v-model.number="draftGroup.maxParallelWorkers" class="input" min="1" max="5" type="number">
          </label>
        </div>

        <div class="check-grid">
          <div>
            <h3>成员</h3>
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
            <h3>共享记忆作用域</h3>
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
            <h3>可见性</h3>
            <label class="check-row"><input v-model="draftGroup.visibility" type="radio" value="summary_only"><span>仅摘要</span></label>
            <label class="check-row"><input v-model="draftGroup.visibility" type="radio" value="expandable_internal_transcript"><span>可展开内部记录</span></label>
          </div>
        </div>

        <div class="action-row">
          <button class="primary-btn" @click="saveGroup">保存群组</button>
          <button class="ghost-btn" @click="removeGroup" :disabled="!draftGroup.id">删除群组</button>
        </div>
      </section>
    </div>

    <div v-else-if="activeTab === 'bindings'" class="workspace-grid">
      <aside class="list-panel">
        <div class="list-toolbar">
          <button class="ghost-btn" @click="loadBindingIntoDraft(null)">新建绑定</button>
          <button class="ghost-btn" @click="loadBindings">刷新</button>
        </div>
        <button
          v-for="binding in bindings"
          :key="binding.id"
          :class="['list-item', { active: draftBinding.id === binding.id }]"
          @click="loadBindingIntoDraft(binding)"
        >
          <strong>{{ binding.connectorType }} · {{ binding.externalChannelId }}</strong>
          <span>{{ binding.defaultAgentId || '未绑定默认 Agent' }}</span>
        </button>
      </aside>

      <section class="editor-panel">
        <div class="form-grid two-col">
          <label>
            <span>连接器</span>
            <select v-model="draftBinding.connectorType" class="input">
              <option v-for="connector in connectors" :key="connector.id" :value="connector.id">{{ connector.name }}</option>
            </select>
          </label>
          <label>
            <span>默认 Agent</span>
            <select v-model="draftBinding.defaultAgentId" class="input">
              <option value="">无</option>
              <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
            </select>
          </label>
        </div>

        <div class="form-grid two-col">
          <label>
            <span>外部频道 ID</span>
            <input v-model="draftBinding.externalChannelId" class="input" placeholder="必填">
          </label>
          <label>
            <span>外部线程 ID</span>
            <input v-model="draftBinding.externalThreadId" class="input" placeholder="可选">
          </label>
        </div>

        <div class="form-grid three-col">
          <label>
            <span>绑定会话 ID</span>
            <input v-model="draftBinding.boundConversationId" class="input" placeholder="可选">
          </label>
          <label>
            <span>绑定群组</span>
            <select v-model="draftBinding.boundGroupId" class="input">
              <option value="">无</option>
              <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
            </select>
          </label>
          <label>
            <span>目标项目 ID</span>
            <input v-model="draftBinding.targetProjectId" class="input" placeholder="可选">
          </label>
        </div>

        <div class="check-grid single-col">
          <label class="check-row"><input v-model="draftBinding.autoReply" type="checkbox"><span>自动回复</span></label>
          <label class="check-row"><input v-model="draftBinding.requireApprovalForRiskyTools" type="checkbox"><span>危险工具仍需审批</span></label>
        </div>

        <div class="action-row">
          <button class="primary-btn" @click="saveBinding">保存绑定</button>
          <button class="ghost-btn" @click="removeBinding" :disabled="!draftBinding.id">删除绑定</button>
        </div>
      </section>
    </div>

    <div v-else class="memory-panel">
      <div class="memory-toolbar">
        <input v-model="memoryQuery" class="input" placeholder="搜索记忆标题、摘要或详情">
        <select v-model="memoryScopeType" class="input narrow">
          <option value="user">user</option>
          <option value="agent">agent</option>
          <option value="project">project</option>
          <option value="group">group</option>
          <option value="channel">channel</option>
        </select>
        <input v-model="memoryScopeId" class="input" placeholder="留空查看全部，或输入 local-user / agent_xxx 等 scope id">
        <button class="primary-btn" @click="loadMemory">查询</button>
      </div>

      <div class="memory-list">
        <article v-for="entry in memoryEntries" :key="entry.id" class="memory-card">
          <div class="memory-card-head">
            <div>
              <strong>{{ entry.title }}</strong>
              <span>{{ entry.memoryType }} · {{ entry.scopeType }} / {{ entry.scopeId }}</span>
            </div>
            <div class="memory-actions">
              <button class="ghost-btn small" @click="toggleMemoryPinned(entry)">{{ entry.pinned ? '取消置顶' : '置顶' }}</button>
              <button class="ghost-btn small danger" @click="removeMemory(entry)">删除</button>
            </div>
          </div>
          <p>{{ entry.summary }}</p>
          <small>{{ entry.tags.join(', ') || '无标签' }}</small>
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

.memory-toolbar .narrow {
  width: 120px;
}

.memory-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
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

.memory-actions {
  display: flex;
  gap: 8px;
}
</style>