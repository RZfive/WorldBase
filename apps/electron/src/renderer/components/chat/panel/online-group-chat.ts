import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { ComposerTranslation } from 'vue-i18n'
import type {
  OnlineGroup,
  OnlineGroupDelegation,
  OnlineGroupFileInput,
  OnlineGroupState
} from '../../../../shared/online-group-types.js'
import { createContentBlock } from './message-blocks'
import {
  applyOnlineGroupCatalogState,
  onlineGroupCatalog,
  rawOnlineGroupId
} from './online-group-catalog'
import type {
  AgentDefinition,
  AgentGroupDefinition,
  ChatMessage,
  PendingAttachment,
  PendingImage
} from './types'

interface OnlineGroupChatOptions {
  t: ComposerTranslation
  messages: Ref<ChatMessage[]>
  inputText: Ref<string>
  pendingImages: Ref<PendingImage[]>
  pendingFiles: Ref<PendingAttachment[]>
  uploadFeedback: Ref<string>
  currentConversationId: Ref<string | null>
  selectedGroupId: Ref<string>
  currentGroupDefinition: ComputedRef<AgentGroupDefinition | null>
  availableAgents: Ref<AgentDefinition[]>
  availableAgentGroups: Ref<AgentGroupDefinition[]>
}

const ONLINE_GROUP_CATALOG_ACTIONS = new Set([
  'identity',
  'group-created',
  'group-updated',
  'group-joined',
  'group-left',
  'group-deleted',
  'invitation-received',
  'join-request-received',
  'join-request-decided',
  'member-added',
  'member-updated',
  'member-removed',
  'delegation-created',
  'delegation-received',
  'delegation-decided',
  'delegation-running',
  'delegation-completed',
  'delegation-failed',
  'group-synced'
])

function dataUrlBase64 (dataUrl: string): string {
  const index = dataUrl.indexOf(',')
  return index >= 0 ? dataUrl.slice(index + 1) : dataUrl
}

function textBase64 (value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function imageExtension (mimeType: string): string {
  if (mimeType.includes('jpeg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  if (mimeType.includes('gif')) return 'gif'
  if (mimeType.includes('svg')) return 'svg'
  return 'png'
}

function isAbsolutePath (value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/)/.test(value)
}

function mapOnlineMessages (
  group: OnlineGroup,
  state: OnlineGroupState,
  t: ComposerTranslation
): ChatMessage[] {
  const selfPeerId = state.identity.instanceId
  const representedDelegations = new Set(group.messages.flatMap(message => (
    message.delegationId ? [message.delegationId] : []
  )))
  const messageEntries = group.messages.map(message => {
    const human = group.members.find(member => member.kind === 'human' && member.peerId === message.senderPeerId)
    const agent = message.kind === 'agent'
      ? group.members.find(member => (
          member.kind === 'agent'
          && member.peerId === message.senderPeerId
          && (member.agentName || member.role) === message.senderName
        ))
      : undefined
    const isSelfHuman = message.kind === 'human' && message.senderPeerId === selfPeerId
    const blocks = []
    if (message.content.trim()) blocks.push(createContentBlock(message.content))
    for (const attachment of message.attachments) {
      blocks.push({
        id: `online-attachment:${message.id}:${attachment.id}`,
        kind: 'online_group_attachment' as const,
        groupId: group.id,
        attachment
      })
    }
    return {
      at: message.createdAt,
      message: {
        role: isSelfHuman ? 'user' : 'assistant',
        id: `online:${message.id}`,
        content: message.content,
        speakerName: message.kind === 'agent'
          ? (agent?.agentName || message.senderName)
          : (human?.peerName || message.senderName),
        speakerIcon: message.kind === 'agent'
          ? (agent?.agentIcon || message.senderAvatar || '🤖')
          : (human?.avatar || message.senderAvatar || '👤'),
        modelLabel: message.kind === 'agent'
          ? [t('onlineGroups.agentBadge'), human?.peerName].filter(Boolean).join(' · ')
          : t('onlineGroups.humanMemberBadge'),
        blocks
      } satisfies ChatMessage
    }
  })
  const delegationEntries = group.delegations.flatMap(delegation => {
    if (delegation.status === 'completed' && representedDelegations.has(delegation.id)) return []
    const target = group.members.find(member => member.id === delegation.toAgentMemberId)
    const owner = group.members.find(member => (
      member.kind === 'human' && member.peerId === delegation.toOwnerPeerId
    ))
    return [{
      at: delegation.createdAt,
      message: {
        role: 'assistant',
        id: `online-delegation:${delegation.id}`,
        content: '',
        speakerName: target?.agentName || delegation.toAgentName,
        speakerIcon: target?.agentIcon || '🤖',
        modelLabel: [t('onlineGroups.agentBadge'), owner?.peerName].filter(Boolean).join(' · '),
        blocks: [{
          id: `online-delegation-status:${delegation.id}`,
          kind: 'online_group_delegation' as const,
          delegation,
          ownerName: owner?.peerName,
          targetIcon: target?.agentIcon || '🤖'
        }]
      } satisfies ChatMessage
    }]
  })

  return [...messageEntries, ...delegationEntries]
    .sort((left, right) => (
      left.at.localeCompare(right.at)
      || (left.message.id || '').localeCompare(right.message.id || '')
    ))
    .map(entry => entry.message)
}

function blockSignature (block: NonNullable<ChatMessage['blocks']>[number]): string {
  if (block.kind === 'online_group_delegation') {
    return `${block.kind}:${block.delegation.id}:${block.delegation.status}:${block.delegation.updatedAt}`
  }
  if (block.kind === 'online_group_attachment') {
    return `${block.kind}:${block.attachment.id}`
  }
  return block.kind
}

function messageSignature (messages: ChatMessage[]): string {
  return messages.map(message => {
    const text = typeof message.content === 'string'
      ? message.content
      : message.content.map(part => part.text || '').join('')
    const blockKinds = (message.blocks || []).map(blockSignature).join(',')
    return `${message.id || ''}:${text.length}:${blockKinds}:${message.modelLabel || ''}:${message.speakerName || ''}:${message.speakerIcon || ''}`
  }).join('|')
}

export function createOnlineGroupChatState (options: OnlineGroupChatOptions) {
  const {
    t,
    messages,
    inputText,
    pendingImages,
    pendingFiles,
    uploadFeedback,
    currentConversationId,
    selectedGroupId,
    currentGroupDefinition,
    availableAgents,
    availableAgentGroups
  } = options
  const api = window.electronAPI!

  const sending = ref(false)
  const busy = ref(false)
  const refreshing = ref(false)
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let changeCleanup: (() => void) | null = null
  let refreshScheduled: ReturnType<typeof setTimeout> | null = null
  let lastMessageSignature = ''
  let lastAppliedGroupId = ''

  const activeOnlineGroupId = computed(() => (
    currentGroupDefinition.value?.online?.groupId
    || rawOnlineGroupId(selectedGroupId.value)
  ))
  const isOnlineGroupConversation = computed(() => Boolean(activeOnlineGroupId.value))
  const activeOnlineGroup = computed<OnlineGroup | null>(() => {
    if (!activeOnlineGroupId.value) return null
    return onlineGroupCatalog.state.value?.groups.find(group => group.id === activeOnlineGroupId.value) || null
  })
  const onlineGroupIdentity = computed(() => onlineGroupCatalog.state.value?.identity || null)
  const pendingApprovals = computed<OnlineGroupDelegation[]>(() => {
    const group = activeOnlineGroup.value
    const selfPeerId = onlineGroupIdentity.value?.instanceId
    if (!group || !selfPeerId) return []
    return group.delegations.filter(delegation => (
      delegation.status === 'pending_owner_approval'
      && delegation.toOwnerPeerId === selfPeerId
    ))
  })

  function applyState (state: OnlineGroupState): void {
    applyOnlineGroupCatalogState(state, availableAgentGroups)
  }

  async function refreshActiveOnlineGroup (): Promise<void> {
    if (refreshing.value || !isOnlineGroupConversation.value) return
    const conversationId = currentConversationId.value
    const groupId = activeOnlineGroupId.value
    if (!conversationId || !groupId) return
    refreshing.value = true
    try {
      // Refresh the whole LAN snapshot so member presence and discovery state
      // stay live together with the active group timeline.
      const state = await api.getOnlineGroupState()
      applyState(state)
      const group = state.groups.find(item => item.id === groupId)
      if (currentConversationId.value !== conversationId || activeOnlineGroupId.value !== groupId) return
      if (!group) return
      const mapped = mapOnlineMessages(group, state, t)
      const signature = `${groupId}:${messageSignature(mapped)}`
      if (signature !== lastMessageSignature || lastAppliedGroupId !== groupId) {
        messages.value = mapped
        lastMessageSignature = signature
        lastAppliedGroupId = groupId
      }
    } catch {
      // Keep the last rendered group snapshot while the harness reconnects.
    } finally {
      refreshing.value = false
    }
  }

  function scheduleRefresh (): void {
    if (refreshScheduled) return
    refreshScheduled = setTimeout(() => {
      refreshScheduled = null
      void refreshActiveOnlineGroup()
    }, 120)
  }

  async function refreshCatalog (): Promise<void> {
    try {
      const state = await api.getOnlineGroupState()
      applyState(state)
    } catch {
      /* retain the last known catalog */
    }
  }

  function stopPolling (): void {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  function startPolling (): void {
    stopPolling()
    if (!isOnlineGroupConversation.value) return
    pollTimer = setInterval(() => {
      void refreshActiveOnlineGroup()
    }, 3500)
  }

  watch(
    [activeOnlineGroupId, currentConversationId],
    ([groupId, conversationId], [previousGroupId]) => {
      if (!groupId || !conversationId) {
        stopPolling()
        lastMessageSignature = ''
        lastAppliedGroupId = ''
        return
      }
      if (groupId !== previousGroupId) {
        lastMessageSignature = ''
        lastAppliedGroupId = ''
        messages.value = []
      }
      void refreshActiveOnlineGroup()
      startPolling()
    },
    { immediate: true }
  )

  changeCleanup = api.onOnlineGroupsChanged?.((event) => {
    if (ONLINE_GROUP_CATALOG_ACTIONS.has(event.action)) void refreshCatalog()
    if (!isOnlineGroupConversation.value) return
    if (!event.groupId || event.groupId === activeOnlineGroupId.value) scheduleRefresh()
  }) || null

  onBeforeUnmount(() => {
    stopPolling()
    if (refreshScheduled) clearTimeout(refreshScheduled)
    changeCleanup?.()
    changeCleanup = null
  })

  async function buildFiles (): Promise<OnlineGroupFileInput[]> {
    const files: OnlineGroupFileInput[] = []
    pendingImages.value.forEach((image, index) => {
      files.push({
        name: `image-${index + 1}.${imageExtension(image.mimeType)}`,
        mimeType: image.mimeType || 'image/png',
        dataBase64: dataUrlBase64(image.base64)
      })
    })
    for (const file of pendingFiles.value) {
      if (files.length >= 5) break
      if (isAbsolutePath(file.filePath) && api.readOnlineGroupFile) {
        const read = await api.readOnlineGroupFile(file.filePath, file.name, file.fileType)
        files.push({
          name: read.name || file.name,
          mimeType: read.mimeType || 'application/octet-stream',
          dataBase64: read.dataBase64
        })
      } else if (file.promptContent) {
        files.push({
          name: file.name || 'attachment.txt',
          mimeType: 'text/plain',
          dataBase64: textBase64(file.promptContent)
        })
      }
    }
    return files.slice(0, 5)
  }

  async function sendOnlineGroupMessage (): Promise<boolean> {
    const group = activeOnlineGroup.value
    if (!group || sending.value || busy.value) return false
    const text = inputText.value.trim()
    if (!text && pendingImages.value.length === 0 && pendingFiles.value.length === 0) return false
    sending.value = true
    uploadFeedback.value = ''
    try {
      const files = await buildFiles()
      const result = await api.sendOnlineGroupMessage(group.id, text, files)
      if (result.deliveryErrors.length > 0) {
        uploadFeedback.value = t('onlineGroups.deliveryPartial', { count: result.deliveryErrors.length })
      }
      inputText.value = ''
      pendingImages.value = []
      pendingFiles.value = []
      await refreshActiveOnlineGroup()
      return true
    } catch (error) {
      uploadFeedback.value = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      sending.value = false
    }
  }

  async function decideDelegation (groupId: string, delegationId: string, approved: boolean): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      await api.decideOnlineGroupDelegation(groupId, delegationId, approved)
      await refreshActiveOnlineGroup()
    } catch (error) {
      uploadFeedback.value = error instanceof Error ? error.message : String(error)
    } finally {
      busy.value = false
    }
  }

  async function addAgent (groupId: string, agentId: string): Promise<void> {
    if (busy.value || !agentId) return
    busy.value = true
    try {
      await api.addOnlineGroupAgent(groupId, agentId)
      await refreshActiveOnlineGroup()
    } catch (error) {
      uploadFeedback.value = error instanceof Error ? error.message : String(error)
    } finally {
      busy.value = false
    }
  }

  async function removeAgent (groupId: string, memberId: string): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      await api.removeOnlineGroupAgent(groupId, memberId)
      await refreshActiveOnlineGroup()
    } catch (error) {
      uploadFeedback.value = error instanceof Error ? error.message : String(error)
    } finally {
      busy.value = false
    }
  }

  async function deleteGroup (groupId: string): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      await api.deleteOnlineGroup(groupId)
      await refreshCatalog()
    } catch (error) {
      uploadFeedback.value = error instanceof Error ? error.message : String(error)
    } finally {
      busy.value = false
    }
  }

  async function leaveGroup (groupId: string): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      await api.leaveOnlineGroup(groupId)
      await refreshCatalog()
    } catch (error) {
      uploadFeedback.value = error instanceof Error ? error.message : String(error)
    } finally {
      busy.value = false
    }
  }

  function availableAgentsForGroup (): AgentDefinition[] {
    const group = activeOnlineGroup.value
    const selfPeerId = onlineGroupIdentity.value?.instanceId
    if (!group || !selfPeerId) return availableAgents.value
    const present = new Set(group.members
      .filter(member => member.kind === 'agent' && member.peerId === selfPeerId)
      .map(member => member.agentId))
    return availableAgents.value.filter(agent => !present.has(agent.id))
  }

  return {
    activeOnlineGroup,
    activeOnlineGroupId,
    availableAgentsForGroup,
    busy,
    decideDelegation,
    deleteGroup,
    isOnlineGroupConversation,
    leaveGroup,
    onlineGroupIdentity,
    pendingApprovals,
    refreshActiveOnlineGroup,
    removeAgent,
    sendOnlineGroupMessage,
    sending,
    addAgent
  }
}

export { mapOnlineMessages }
