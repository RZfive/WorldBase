import type { Ref } from 'vue'
import type {
  AgentDefinition,
  AgentGroupDefinition,
  ChannelBinding,
  SkillItem
} from './types'

interface ChatWorkspaceOptionsStateOptions {
  availableSkills: Ref<SkillItem[]>
  activeSkillIds: Ref<Set<string>>
  availableAgents: Ref<AgentDefinition[]>
  availableAgentGroups: Ref<AgentGroupDefinition[]>
  availableChannelBindings: Ref<ChannelBinding[]>
  selectedAgentId: Ref<string>
  selectedGroupId: Ref<string>
  selectedChannelBindingId: Ref<string>
  currentConversationId: Ref<string | null>
  getDefaultAgentId: () => string
  syncProviderSelectionForAgent: (agentId: string) => void
}

export function createChatWorkspaceOptionsState (options: ChatWorkspaceOptionsStateOptions) {
  const {
    availableSkills,
    activeSkillIds,
    availableAgents,
    availableAgentGroups,
    availableChannelBindings,
    selectedAgentId,
    selectedGroupId,
    selectedChannelBindingId,
    currentConversationId,
    getDefaultAgentId,
    syncProviderSelectionForAgent
  } = options

  async function syncActiveSkills (): Promise<void> {
    if (!window.electronAPI?.setActiveSkills) return
    try {
      await window.electronAPI.setActiveSkills(Array.from(activeSkillIds.value))
    } catch {
      /* ignore */
    }
  }

  async function loadSkills (): Promise<void> {
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
    } catch {
      /* ignore */
    }
  }

  async function loadAgentWorkspaceOptions (): Promise<void> {
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

      if (!currentConversationId.value && !selectedGroupId.value && !selectedChannelBindingId.value && selectedAgentId.value) {
        syncProviderSelectionForAgent(selectedAgentId.value)
      }
    } catch {
      /* ignore */
    }
  }

  function toggleSkill (id: string): void {
    if (activeSkillIds.value.has(id)) {
      activeSkillIds.value.delete(id)
    } else {
      activeSkillIds.value.add(id)
    }
    void syncActiveSkills()
  }

  function selectAllSkills (): void {
    activeSkillIds.value = new Set(availableSkills.value.map(skill => skill.id))
    void syncActiveSkills()
  }

  function clearSkills (): void {
    activeSkillIds.value = new Set()
    void syncActiveSkills()
  }

  return {
    clearSkills,
    loadAgentWorkspaceOptions,
    loadSkills,
    selectAllSkills,
    toggleSkill
  }
}
