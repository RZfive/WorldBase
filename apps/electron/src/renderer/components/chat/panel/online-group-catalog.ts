import { ref } from 'vue'
import type { OnlineGroup, OnlineGroupState } from '../../../../shared/online-group-types.js'
import type { AgentGroupDefinition } from './types'

export const ONLINE_GROUP_CONVERSATION_PREFIX = 'online:'

export const onlineGroupCatalog = {
  /** Durable local agent groups, kept separate so online refreshes never erase them. */
  localGroups: ref<AgentGroupDefinition[]>([]),
  state: ref<OnlineGroupState | null>(null)
}

export function onlineGroupConversationId (groupId: string): string {
  return `${ONLINE_GROUP_CONVERSATION_PREFIX}${groupId}`
}

export function rawOnlineGroupId (conversationGroupId: string): string {
  return conversationGroupId.startsWith(ONLINE_GROUP_CONVERSATION_PREFIX)
    ? conversationGroupId.slice(ONLINE_GROUP_CONVERSATION_PREFIX.length)
    : ''
}

export function buildOnlineGroupDefinition (
  group: OnlineGroup,
  state: OnlineGroupState
): AgentGroupDefinition {
  return {
    id: onlineGroupConversationId(group.id),
    name: group.name,
    icon: group.icon || '🌐',
    description: group.description,
    coordinatorAgentId: '',
    memberAgentIds: [],
    maxRounds: 1,
    maxParallelWorkers: 1,
    sharedMemoryScopes: [],
    visibility: 'summary_only',
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    online: {
      groupId: group.id,
      ownerPeerId: group.ownerPeerId,
      ownerName: group.ownerName,
      accessRole: group.accessRole,
      selfPeerId: state.identity.instanceId,
      members: group.members,
      delegations: group.delegations,
      updatedAt: group.updatedAt
    }
  }
}

export function mergeAgentGroupCatalog (
  localGroups: AgentGroupDefinition[],
  state: OnlineGroupState | null
): AgentGroupDefinition[] {
  if (!state) return localGroups.slice()
  return [
    ...localGroups,
    ...state.groups.map(group => buildOnlineGroupDefinition(group, state))
  ]
}

export function applyOnlineGroupCatalogState (
  state: OnlineGroupState | null,
  availableAgentGroups: { value: AgentGroupDefinition[] }
): void {
  onlineGroupCatalog.state.value = state
  availableAgentGroups.value = mergeAgentGroupCatalog(onlineGroupCatalog.localGroups.value, state)
}

export function replaceOnlineGroupInCatalog (
  group: OnlineGroup,
  identity: OnlineGroupState['identity'],
  availableAgentGroups: { value: AgentGroupDefinition[] }
): boolean {
  const current = onlineGroupCatalog.state.value
  if (!current) return false
  const groups = current.groups.filter(item => item.id !== group.id)
  groups.push(group)
  applyOnlineGroupCatalogState({ ...current, identity, groups }, availableAgentGroups)
  return true
}
