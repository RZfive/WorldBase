import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import os from 'node:os'
import type { AgentDefinition } from '../../shared/agent-workspace-types.js'
import type {
  LanDiscoverySnapshot,
  OnlineGroup,
  OnlineGroupAttachment,
  OnlineGroupAttachmentData,
  OnlineGroupBackground,
  OnlineGroupChangeEvent,
  OnlineGroupDelegation,
  OnlineGroupDelegationResult,
  OnlineGroupFileInput,
  OnlineGroupIdentity,
  OnlineGroupInboxItem,
  OnlineGroupMember,
  OnlineGroupMessage,
  OnlineGroupPublicSummary,
  OnlineGroupSendResult,
  OnlineGroupState
} from '../../shared/online-group-types.js'
import type { RustHarnessClient } from '../../../electron/main-process/rust-harness-client.js'
import { resolveRoomAddress, stripRedundantHandoffInstructions } from '../../shared/group-mentions.js'
import { OnlineGroupStore, type OnlineGroupRecord } from './online-group-store.js'
import {
  normalizeOnlineGroupAvatar,
  normalizeOnlineGroupBackground,
  normalizeOnlineGroupTags
} from './profile.js'

const ONLINE_GROUP_CAPABILITIES = [
  'worldbase.online-group/v1',
  'worldbase.file-transfer/v1',
  'worldbase.agent-delegation-consent/v1'
]
const MAX_FILE_BYTES = 6 * 1024 * 1024
const MAX_TOTAL_UPLOAD_BYTES = 7 * 1024 * 1024
const MAX_MESSAGE_CHARS = 20_000
const DEFAULT_SYNC_INTERVAL_MS = 20_000
const REMOTE_TIMEOUT_MS = 8_000

type AgentExecutor = (input: {
  agentId: string
  task: string
  context: string
  groupName: string
  groupId: string
}) => Promise<string>

interface OnlineGroupServiceOptions {
  userDataPath: string
  port: number
  /** Test/embedded-host override; production advertises the preferred LAN IP. */
  baseUrl?: string
  appVersion?: string
  resolveHarness: () => Promise<RustHarnessClient | null>
  getAgent: (id: string) => AgentDefinition | null
  onChanged?: (event: OnlineGroupChangeEvent) => void
}

interface PreparedAttachment {
  metadata: OnlineGroupAttachment
  dataBase64: string
}

function nowIso (): string {
  return new Date().toISOString()
}

function token (bytes = 24): string {
  return randomBytes(bytes).toString('hex')
}

function normalizeBaseUrl (value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function sanitizeText (value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function asRecord (value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isPrivateIpv4 (hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

function isPrivateIpv6 (hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isIP(normalized) !== 6) return false
  return normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
}

function assertLanUrl (raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP(S) LAN collaboration endpoints are supported.')
  }
  const hostname = url.hostname.toLowerCase()
  if (hostname.startsWith('169.254.') || hostname.replace(/^\[|\]$/g, '').startsWith('fe80:')) {
    throw new Error('Link-local cloud metadata addresses are not valid online-group peers.')
  }
  if (hostname !== 'localhost' && !isPrivateIpv4(hostname) && !isPrivateIpv6(hostname)) {
    throw new Error('Online groups can only connect to private LAN addresses.')
  }
  return url
}

function preferredLanIpv4Addresses (): string[] {
  const candidates: Array<{ address: string; score: number }> = []
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    const interfaceName = (name || '').toLowerCase()
    const virtual = /^(utun|tun|tap|lo|docker|veth|vmnet|bridge|awdl|llw|anpi)/i.test(interfaceName)
    for (const entry of entries || []) {
      const family = String(entry.family)
      if ((family !== 'IPv4' && family !== '4') || entry.internal || !entry.address || entry.address.startsWith('169.254.')) continue
      if (!isPrivateIpv4(entry.address)) continue
      let score = 0
      if (isPrivateIpv4(entry.address)) score += 100
      if (!virtual) score += 30
      if (interfaceName.includes('wi-fi') || interfaceName.includes('wlan') || interfaceName.includes('en0')) score += 12
      if (interfaceName.includes('ethernet')) score += 10
      if (virtual) score -= 50
      candidates.push({ address: entry.address, score })
    }
  }
  return candidates
    .sort((left, right) => right.score - left.score || left.address.localeCompare(right.address))
    .map(candidate => candidate.address)
    .filter((address, index, list) => list.indexOf(address) === index)
}

function memberHumanId (peerId: string): string {
  return `${peerId}:human`
}

function memberAgentId (peerId: string, agentId: string): string {
  return `${peerId}:agent:${agentId}`
}

function groupView (group: OnlineGroupRecord): OnlineGroup {
  const {
    accessToken: _accessToken,
    inviteToken: _inviteToken,
    ...view
  } = group
  return view
}

function mergeByUpdatedAt<T extends { id: string; updatedAt?: string }> (existing: T[], incoming: T[]): T[] {
  const byId = new Map(existing.map(item => [item.id, item]))
  for (const item of incoming) {
    const current = byId.get(item.id)
    if (!current || (item.updatedAt || '') >= (current.updatedAt || '')) {
      byId.set(item.id, item)
    }
  }
  return [...byId.values()]
}

function mergeMessages (existing: OnlineGroupMessage[], incoming: OnlineGroupMessage[]): OnlineGroupMessage[] {
  const byId = new Map(existing.map(message => [message.id, message]))
  for (const message of incoming) {
    if (!byId.has(message.id)) byId.set(message.id, message)
  }
  return [...byId.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-2000)
}

function resolveAgentMentions (
  content: string,
  group: OnlineGroupRecord
): { targets: OnlineGroupMember[]; task: string } {
  const agents = group.members.filter(member => member.kind === 'agent')
  if (!agents.length || !content.includes('@')) return { targets: [], task: '' }
  const address = resolveRoomAddress(
    content,
    agents.map(member => ({ id: member.id, name: member.agentName || member.role })),
    ''
  )
  if (!address.explicit || address.agentIds.length === 0) return { targets: [], task: '' }
  const targets = agents.filter(member => address.agentIds.includes(member.id))
  return {
    targets,
    task: stripRedundantHandoffInstructions(address.request.trim() || content.trim())
      || address.request.trim()
      || content.trim()
  }
}

export class OnlineGroupService {
  private readonly options: OnlineGroupServiceOptions
  private readonly store: OnlineGroupStore
  private identity: OnlineGroupIdentity
  private agentExecutor: AgentExecutor | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private discoveryTimer: ReturnType<typeof setInterval> | null = null
  private syncing = new Set<string>()
  private started = false

  constructor (options: OnlineGroupServiceOptions) {
    this.options = options
    this.store = new OnlineGroupStore(options.userDataPath)
    this.identity = this.store.loadIdentity()
    if (this.identity.displayName === 'WorldBase') {
      this.identity = this.store.saveIdentity({
        ...this.identity,
        displayName: `${os.hostname()} · WorldBase`,
        role: this.identity.role || '成员'
      })
    }
  }

  setAgentExecutor (executor: AgentExecutor): void {
    this.agentExecutor = executor
  }

  async start (): Promise<void> {
    if (this.started) return
    this.started = true
    this.recoverInterruptedDelegations()
    await this.refreshSelfMemberIdentity().catch(() => undefined)
    if (this.identity.discoveryEnabled) {
      await this.publishDiscovery().catch(error => {
        console.warn('[online-groups] Discovery startup failed:', error)
      })
    }
    this.syncTimer = setInterval(() => {
      void this.syncAllGroups()
    }, DEFAULT_SYNC_INTERVAL_MS)
    this.syncTimer.unref?.()
    this.discoveryTimer = setInterval(() => {
      void this.ensureDiscoveryRunning()
    }, 30_000)
    this.discoveryTimer.unref?.()
  }

  stop (): void {
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = null
    if (this.discoveryTimer) clearInterval(this.discoveryTimer)
    this.discoveryTimer = null
  }

  getIdentity (): OnlineGroupIdentity {
    return { ...this.identity }
  }

  async getState (): Promise<OnlineGroupState> {
    return {
      identity: this.getIdentity(),
      discovery: await this.getDiscoverySnapshot(),
      groups: this.store.listGroups().map(groupView),
      inbox: this.store.listInbox(),
      localAddresses: preferredLanIpv4Addresses(),
      serverPort: this.options.port
    }
  }

  getGroupView (groupId: string): { group: OnlineGroup; identity: OnlineGroupIdentity } {
    return {
      group: groupView(this.requireGroup(groupId)),
      identity: this.getIdentity()
    }
  }

  async saveIdentity (input: {
    displayName?: string
    role?: string
    avatar?: string
    background?: string
    tags?: string[]
    discoveryEnabled?: boolean
    advertiseGroups?: boolean
  }): Promise<OnlineGroupState> {
    const previousEnabled = this.identity.discoveryEnabled
    if (input.displayName !== undefined && !sanitizeText(input.displayName, 80)) {
      throw new Error('WorldBase 显示名不能为空。')
    }
    this.identity = this.store.saveIdentity({
      ...this.identity,
      displayName: input.displayName !== undefined ? sanitizeText(input.displayName, 80) : this.identity.displayName,
      role: input.role !== undefined ? sanitizeText(input.role, 80) : this.identity.role,
      avatar: input.avatar !== undefined ? normalizeOnlineGroupAvatar(input.avatar) : this.identity.avatar,
      background: input.background !== undefined
        ? normalizeOnlineGroupBackground(input.background)
        : this.identity.background,
      tags: input.tags !== undefined ? normalizeOnlineGroupTags(input.tags) : this.identity.tags,
      discoveryEnabled: input.discoveryEnabled !== undefined ? input.discoveryEnabled === true : this.identity.discoveryEnabled,
      advertiseGroups: input.advertiseGroups !== undefined ? input.advertiseGroups !== false : this.identity.advertiseGroups
    })
    if (!this.identity.displayName) throw new Error('WorldBase 显示名不能为空。')
    if (!this.identity.discoveryEnabled && previousEnabled) {
      await this.stopHarnessDiscovery()
    }
    await this.refreshSelfMemberIdentity().catch(() => undefined)
    if (this.identity.discoveryEnabled) {
      await this.publishDiscovery()
    }
    this.emitChanged('identity')
    return await this.getState()
  }

  async refreshDiscovery (): Promise<OnlineGroupState> {
    if (this.identity.discoveryEnabled) {
      const harness = await this.options.resolveHarness()
      if (harness) {
        const status = await harness.getLanDiscoveryStatus().catch(() => null)
        if (!status?.running) await this.publishDiscovery().catch(() => undefined)
        else await harness.refreshLanDiscovery().catch(() => undefined)
      }
    }
    return await this.getState()
  }

  async createGroup (input: {
    name: string
    icon?: string
    description?: string
    role?: string
    invitePeerIds?: string[]
  }): Promise<OnlineGroup> {
    const name = sanitizeText(input.name, 80)
    if (!name) throw new Error('群组名称不能为空。')
    const timestamp = nowIso()
    const groupId = `online_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
    const selfMember: OnlineGroupMember = {
      id: memberHumanId(this.identity.instanceId),
      peerId: this.identity.instanceId,
      peerName: this.identity.displayName,
      kind: 'human',
      role: sanitizeText(input.role || this.identity.role, 80) || '成员',
      avatar: this.identity.avatar,
      background: this.identity.background,
      tags: this.identity.tags,
      accessRole: 'owner',
      baseUrl: this.selfBaseUrl(),
      joinedAt: timestamp,
      updatedAt: timestamp
    }
    const group = this.store.saveGroup({
      id: groupId,
      name,
      icon: sanitizeText(input.icon, 16) || '🌐',
      description: sanitizeText(input.description, 1000),
      ownerPeerId: this.identity.instanceId,
      ownerName: this.identity.displayName,
      accessRole: 'owner',
      joinPolicy: 'request',
      createdAt: timestamp,
      updatedAt: timestamp,
      settingsUpdatedAt: timestamp,
      members: [selfMember],
      messages: [],
      delegations: [],
      accessToken: token(32),
      inviteToken: token(24)
    })
    await this.publishDiscovery().catch(() => undefined)
    this.emitChanged('group-created', group.id)
    if (Array.isArray(input.invitePeerIds) && input.invitePeerIds.length > 0) {
      void this.invitePeers(group.id, input.invitePeerIds).catch(error => {
        console.warn('[online-groups] Initial invitations failed:', error)
      })
    }
    return groupView(group)
  }

  async updateGroup (groupId: string, input: {
    name?: string
    icon?: string
    description?: string
  }): Promise<OnlineGroup> {
    const group = this.requireGroup(groupId)
    this.requireOwnerOrAdmin(group)
    const name = input.name !== undefined ? sanitizeText(input.name, 80) : group.name
    if (!name) throw new Error('群组名称不能为空。')
    group.name = name
    if (input.icon !== undefined) group.icon = sanitizeText(input.icon, 16) || '🌐'
    if (input.description !== undefined) group.description = sanitizeText(input.description, 1000)
    group.settingsUpdatedAt = nowIso()
    const saved = this.store.saveGroup(group)
    await this.broadcastGroupSettings(saved)
    await this.publishDiscovery().catch(() => undefined)
    this.emitChanged('group-updated', saved.id)
    return groupView(saved)
  }

  async invitePeers (groupId: string, peerIds: string[], role?: string): Promise<{ invited: number; errors: string[] }> {
    const group = this.requireGroup(groupId)
    this.requireOwnerOrAdmin(group)
    const peers = (await this.getDiscoverySnapshot()).peers
    const errors: string[] = []
    let invited = 0
    await Promise.all([...new Set(peerIds.map(id => id.trim()).filter(Boolean))].map(async peerId => {
      const peer = peers.find(item => item.instanceId === peerId)
      if (!peer) {
        errors.push(`未找到在线世界：${peerId}`)
        return
      }
      try {
        await this.postJson(peer.baseUrl, '/api/online-groups/invitations', null, {
          invitationId: randomUUID(),
          groupId: group.id,
          groupName: group.name,
          groupIcon: group.icon,
          groupDescription: group.description,
          inviterPeerId: this.identity.instanceId,
          inviterName: this.identity.displayName,
          inviterRole: this.identity.role,
          inviterAvatar: this.identity.avatar,
          inviterBackground: this.identity.background,
          inviterTags: this.identity.tags,
          role: sanitizeText(role || '成员', 80),
          inviteToken: group.inviteToken,
          baseUrl: this.selfBaseUrl(),
          createdAt: nowIso()
        })
        invited += 1
      } catch (error) {
        errors.push(`${peer.displayName}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))
    return { invited, errors }
  }

  async requestJoin (peerId: string, groupId: string, role?: string): Promise<OnlineGroupInboxItem> {
    const snapshot = await this.getDiscoverySnapshot()
    const peer = snapshot.peers.find(item => item.instanceId === peerId)
    if (!peer) throw new Error('该 WorldBase 已离线。')
    const summary = peer.groups.find(group => group.id === groupId)
    if (!summary) throw new Error('该在线群组已不再广播。')
    const timestamp = nowIso()
    const requestId = randomUUID()
    await this.postJson(peer.baseUrl, '/api/online-groups/join-requests', null, {
      requestId,
      groupId: summary.id,
      groupName: summary.name,
      groupIcon: summary.icon,
      requesterPeerId: this.identity.instanceId,
      requesterName: this.identity.displayName,
      requesterRole: this.identity.role,
      requesterAvatar: this.identity.avatar,
      requesterBackground: this.identity.background,
      requesterTags: this.identity.tags,
      requestedRole: sanitizeText(role || this.identity.role || '成员', 80),
      baseUrl: this.selfBaseUrl(),
      createdAt: timestamp
    })
    return this.store.saveInboxItem({
      id: requestId,
      type: 'join-request',
      direction: 'outgoing',
      groupId: summary.id,
      groupName: summary.name,
      groupIcon: summary.icon,
      groupDescription: '',
      fromPeerId: this.identity.instanceId,
      fromName: this.identity.displayName,
      fromRole: this.identity.role,
      fromAvatar: this.identity.avatar,
      fromBackground: this.identity.background,
      fromTags: this.identity.tags,
      baseUrl: peer.baseUrl,
      role: sanitizeText(role || this.identity.role, 80),
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp
    })
  }

  async acceptInvitation (invitationId: string, role?: string): Promise<OnlineGroup> {
    const item = this.store.getInboxItem(invitationId)
    if (!item || item.type !== 'invitation' || item.direction !== 'incoming' || item.status !== 'pending') {
      throw new Error('邀请不存在或已处理。')
    }
    const response = await this.postJson(
      item.baseUrl,
      `/api/online-groups/${encodeURIComponent(item.groupId)}/accept-invite`,
      null,
      {
        invitationId: item.id,
        inviteToken: item.inviteToken || '',
        peerId: this.identity.instanceId,
        displayName: this.identity.displayName,
        avatar: this.identity.avatar,
        background: this.identity.background,
        tags: this.identity.tags,
        role: sanitizeText(role || item.role || this.identity.role, 80),
        baseUrl: this.selfBaseUrl()
      }
    )
    const payload = asRecord(response)
    const groupPayload = asRecord(payload?.group)
    if (!groupPayload || typeof payload?.accessToken !== 'string') {
      throw new Error('对方没有返回有效的群组数据。')
    }
    const remoteGroup = groupPayload as unknown as OnlineGroup
    const now = nowIso()
    const group = this.store.saveGroup({
      ...remoteGroup,
      accessToken: payload.accessToken,
      inviteToken: '',
      accessRole: 'member',
      updatedAt: now
    })
    this.store.saveInboxItem({ ...item, status: 'accepted' })
    await this.publishDiscovery().catch(() => undefined)
    this.emitChanged('group-joined', group.id)
    return groupView(group)
  }

  async declineInvitation (invitationId: string): Promise<OnlineGroupState> {
    const item = this.store.getInboxItem(invitationId)
    if (!item || item.status !== 'pending') throw new Error('邀请不存在或已处理。')
    this.store.saveInboxItem({ ...item, status: 'declined' })
    this.emitChanged('invitation-declined')
    return await this.getState()
  }

  async decideJoinRequest (requestId: string, approved: boolean): Promise<OnlineGroupState> {
    const item = this.store.getInboxItem(requestId)
    if (!item || item.type !== 'join-request' || item.direction !== 'incoming' || item.status !== 'pending') {
      throw new Error('入群申请不存在或已处理。')
    }
    const group = this.requireGroup(item.groupId)
    this.requireOwnerOrAdmin(group)
    if (approved) {
      await this.postJson(item.baseUrl, '/api/online-groups/invitations', null, {
        invitationId: randomUUID(),
        groupId: group.id,
        groupName: group.name,
        groupIcon: group.icon,
        groupDescription: group.description,
        inviterPeerId: this.identity.instanceId,
        inviterName: this.identity.displayName,
        inviterRole: this.identity.role,
        inviterAvatar: this.identity.avatar,
        inviterBackground: this.identity.background,
        inviterTags: this.identity.tags,
        role: item.role || '成员',
        inviteToken: group.inviteToken,
        baseUrl: this.selfBaseUrl(),
        createdAt: nowIso()
      })
      this.store.saveInboxItem({ ...item, status: 'approved' })
    } else {
      this.store.saveInboxItem({ ...item, status: 'rejected' })
      await this.postJson(item.baseUrl, '/api/online-groups/join-responses', null, {
        requestId: item.id,
        status: 'rejected'
      }).catch(() => undefined)
    }
    this.emitChanged('join-request-decided', group.id)
    return await this.getState()
  }

  async addAgent (groupId: string, agentId: string, role?: string): Promise<OnlineGroup> {
    const group = this.requireGroup(groupId)
    const agent = this.options.getAgent(agentId)
    if (!agent) throw new Error('本机 Agent 不存在。')
    const now = nowIso()
    const member: OnlineGroupMember = {
      id: memberAgentId(this.identity.instanceId, agent.id),
      peerId: this.identity.instanceId,
      peerName: this.identity.displayName,
      kind: 'agent',
      role: sanitizeText(role || agent.name, 80),
      accessRole: 'member',
      baseUrl: this.selfBaseUrl(),
      agentId: agent.id,
      agentName: agent.name,
      agentIcon: agent.icon || '🤖',
      agentDescription: agent.description,
      joinedAt: now,
      updatedAt: now
    }
    group.members = mergeByUpdatedAt(group.members, [member])
    const saved = this.store.saveGroup(group)
    await this.broadcastMember(saved, member)
    void this.publishDiscovery().catch(() => undefined)
    this.emitChanged('member-added', saved.id)
    return groupView(saved)
  }

  async removeAgent (groupId: string, memberId: string): Promise<OnlineGroup> {
    const group = this.requireGroup(groupId)
    const member = group.members.find(item => item.id === memberId)
    if (!member || member.kind !== 'agent' || member.peerId !== this.identity.instanceId) {
      throw new Error('只能移除自己加入群组的 Agent。')
    }
    group.members = group.members.filter(item => item.id !== memberId)
    const saved = this.store.saveGroup(group)
    await this.broadcastMemberRemoval(saved, memberId)
    void this.publishDiscovery().catch(() => undefined)
    this.emitChanged('member-removed', saved.id)
    return groupView(saved)
  }

  async sendMessage (
    groupId: string,
    content: string,
    files: OnlineGroupFileInput[] = []
  ): Promise<OnlineGroupSendResult> {
    const group = this.requireGroup(groupId)
    const text = sanitizeText(content, MAX_MESSAGE_CHARS)
    if (!text && files.length === 0) throw new Error('消息内容不能为空。')
    const selfMember = group.members.find(member => member.peerId === this.identity.instanceId && member.kind === 'human')
    if (!selfMember) throw new Error('当前实例不是该群组的成员。')
    const prepared = this.prepareAttachments(group.id, files)
    const message: OnlineGroupMessage = {
      id: randomUUID(),
      groupId: group.id,
      senderPeerId: this.identity.instanceId,
      senderName: this.identity.displayName,
      senderRole: selfMember.role,
      senderAvatar: selfMember.avatar,
      senderBackground: selfMember.background,
      senderTags: selfMember.tags,
      kind: 'human',
      content: text,
      attachments: prepared.map(item => item.metadata),
      createdAt: nowIso()
    }
    group.messages = mergeMessages(group.messages, [message])
    const saved = this.store.saveGroup(group)
    this.emitChanged('message', saved.id)
    const deliveryErrors = await this.broadcastMessage(
      saved,
      message,
      prepared.map(item => ({
        id: item.metadata.id,
        name: item.metadata.name,
        mimeType: item.metadata.mimeType,
        dataBase64: item.dataBase64
      }))
    )
    void this.routeMentionDelegations(saved.id, message).catch(error => {
      console.warn('[online-groups] Mention delegation failed:', error)
    })
    return { group: groupView(saved), deliveryErrors }
  }

  async syncGroup (groupId: string): Promise<OnlineGroup> {
    const group = this.requireGroup(groupId)
    await this.syncOneGroup(group)
    return groupView(this.requireGroup(groupId))
  }

  async createDelegation (
    groupId: string,
    targetMemberId: string,
    task: string,
    sourceAgentId?: string
  ): Promise<OnlineGroupDelegationResult> {
    const group = this.requireGroup(groupId)
    const target = group.members.find(member => member.id === targetMemberId && member.kind === 'agent')
    if (!target?.agentId) throw new Error('目标 Agent 不在该群组中。')
    const text = sanitizeText(task, 5000)
    if (!text) throw new Error('委派任务不能为空。')
    if (group.delegations.filter(item => item.status === 'pending_owner_approval').length >= 25) {
      throw new Error('该群组待审批的 Agent 委派过多，请先处理现有请求。')
    }
    const from = group.members.find(member => member.peerId === this.identity.instanceId && member.kind === 'human')
    if (!from) throw new Error('当前实例不是该群组成员。')
    const sourceAgent = sourceAgentId
      ? group.members.find(member => (
          member.kind === 'agent'
          && member.peerId === this.identity.instanceId
          && member.agentId === sourceAgentId
        ))
      : undefined
    const now = nowIso()
    const delegation: OnlineGroupDelegation = {
      id: randomUUID(),
      groupId: group.id,
      fromPeerId: this.identity.instanceId,
      fromName: this.identity.displayName,
      ...(sourceAgent
        ? { fromAgentId: sourceAgent.agentId, fromAgentName: sourceAgent.agentName || sourceAgent.role }
        : {}),
      toAgentMemberId: target.id,
      toAgentName: target.agentName || target.role,
      toOwnerPeerId: target.peerId,
      task: text,
      status: target.peerId === this.identity.instanceId ? 'approved' : 'pending_owner_approval',
      createdAt: now,
      updatedAt: now
    }
    group.delegations = mergeByUpdatedAt(group.delegations, [delegation])
    const saved = this.store.saveGroup(group)
    await this.broadcastDelegation(saved, delegation)
    this.emitChanged('delegation-created', saved.id)
    if (delegation.status === 'approved') {
      void this.executeDelegation(saved.id, delegation.id)
    }
    return {
      group: groupView(saved),
      delegation,
      executed: delegation.status === 'approved'
    }
  }

  async decideDelegation (groupId: string, delegationId: string, approved: boolean): Promise<OnlineGroup> {
    const group = this.requireGroup(groupId)
    const delegation = group.delegations.find(item => item.id === delegationId)
    if (!delegation) throw new Error('委派记录不存在。')
    if (delegation.toOwnerPeerId !== this.identity.instanceId) {
      throw new Error('只有该 Agent 的所有者可以批准跨用户委派。')
    }
    if (delegation.status !== 'pending_owner_approval') {
      throw new Error('该委派已经处理。')
    }
    delegation.status = approved ? 'approved' : 'rejected'
    delegation.decidedAt = nowIso()
    delegation.updatedAt = delegation.decidedAt
    const saved = this.store.saveGroup(group)
    await this.broadcastDelegationDecision(saved, delegation)
    this.emitChanged('delegation-decided', saved.id)
    if (approved) {
      void this.executeDelegation(saved.id, delegation.id)
    }
    return groupView(saved)
  }

  async runOwnedAgentMessage (groupId: string, agentMemberId: string, prompt: string): Promise<OnlineGroupSendResult> {
    const group = this.requireGroup(groupId)
    const member = group.members.find(item => item.id === agentMemberId && item.kind === 'agent')
    if (!member?.agentId || member.peerId !== this.identity.instanceId) {
      throw new Error('只能让自己加入的 Agent 发言。')
    }
    const text = sanitizeText(prompt, 5000)
    if (!text) throw new Error('给 Agent 的说明不能为空。')
    if (!this.agentExecutor) throw new Error('Agent 执行器尚未就绪。')
    const reply = await this.agentExecutor({
      agentId: member.agentId,
      task: text,
      context: this.buildGroupContext(group),
      groupName: group.name,
      groupId: group.id
    })
    if (!reply.trim()) throw new Error('Online group Agent returned no visible result.')
    return await this.postAgentMessage(group, member, reply)
  }

  async readAttachment (groupId: string, attachmentId: string): Promise<OnlineGroupAttachmentData> {
    const group = this.requireGroup(groupId)
    const message = group.messages.find(item => item.attachments.some(attachment => attachment.id === attachmentId))
    const attachment = message?.attachments.find(item => item.id === attachmentId)
    if (!attachment) throw new Error('附件不存在。')
    let data = this.store.readAttachment(group.id, attachmentId)
    if (!data) {
      const source = group.members.find(member => member.peerId === attachment.sourcePeerId)
      if (!source?.baseUrl) throw new Error('附件来源当前不可用。')
      const response = await this.getJson(
        source.baseUrl,
        `/api/online-groups/${encodeURIComponent(group.id)}/files/${encodeURIComponent(attachmentId)}`,
        group.accessToken
      )
      const payload = asRecord(response)
      if (!payload || typeof payload.dataBase64 !== 'string') {
        throw new Error('附件下载失败。')
      }
      data = Buffer.from(payload.dataBase64, 'base64')
      if (data.length > MAX_FILE_BYTES) throw new Error('附件超过大小限制。')
      this.store.saveAttachment(group.id, attachment.id, data)
    }
    return {
      name: attachment.name,
      mimeType: attachment.mimeType,
      dataBase64: data.toString('base64')
    }
  }

  async leaveGroup (groupId: string): Promise<boolean> {
    const group = this.requireGroup(groupId)
    if (group.ownerPeerId === this.identity.instanceId) {
      throw new Error('群主不能直接退出，请先删除群组或转移群主。')
    }
    const ownMembers = group.members.filter(member => member.peerId === this.identity.instanceId)
    for (const member of ownMembers) {
      await this.broadcastMemberRemoval(group, member.id).catch(() => undefined)
    }
    const deleted = this.store.deleteGroup(group.id)
    if (deleted) {
      await this.publishDiscovery().catch(() => undefined)
      this.emitChanged('group-left', group.id)
    }
    return deleted
  }

  async deleteGroup (groupId: string): Promise<boolean> {
    const group = this.requireGroup(groupId)
    if (group.ownerPeerId !== this.identity.instanceId) {
      throw new Error('只有群主可以解散在线群组。')
    }
    const peers = [...new Map(group.members
      .filter(member => member.peerId !== this.identity.instanceId && member.baseUrl)
      .map(member => [member.peerId, member.baseUrl])).entries()]
    await Promise.allSettled(peers.map(([, baseUrl]) => this.postJson(
      baseUrl,
      `/api/online-groups/${encodeURIComponent(group.id)}/delete`,
      group.accessToken,
      { actorPeerId: this.identity.instanceId }
    )))
    const deleted = this.store.deleteGroup(group.id)
    if (deleted) {
      await this.publishDiscovery().catch(() => undefined)
      this.emitChanged('group-deleted', group.id)
    }
    return deleted
  }

  // ---- Host-side HTTP API -------------------------------------------------

  async handlePublicProfile (): Promise<Record<string, unknown>> {
    return {
      instanceId: this.identity.instanceId,
      displayName: this.identity.displayName,
      role: '',
      avatar: this.identity.avatar,
      background: this.identity.background,
      tags: this.identity.tags,
      groups: this.publicGroupSummaries()
    }
  }

  async handleIncomingInvitation (payload: unknown, actorPeerId = ''): Promise<{ accepted: boolean }> {
    const value = asRecord(payload)
    if (!value) throw new Error('Invalid invitation payload.')
    const groupId = sanitizeText(value.groupId, 120)
    const groupName = sanitizeText(value.groupName, 80)
    const inviteToken = sanitizeText(value.inviteToken, 200)
    const fromPeerId = sanitizeText(value.inviterPeerId, 120)
    const baseUrl = normalizeBaseUrl(sanitizeText(value.baseUrl, 500))
    if (!groupId || !groupName || !inviteToken || !fromPeerId || !baseUrl) {
      throw new Error('Invitation is missing group or inviter information.')
    }
    if (actorPeerId && fromPeerId !== actorPeerId) {
      throw new Error('Invitation sender identity does not match the requesting peer.')
    }
    assertLanUrl(baseUrl)
    const existing = this.store.getInboxItem(sanitizeText(value.invitationId, 120))
    if (existing) return { accepted: true }
    const timestamp = nowIso()
    this.store.saveInboxItem({
      id: sanitizeText(value.invitationId, 120) || randomUUID(),
      type: 'invitation',
      direction: 'incoming',
      groupId,
      groupName,
      groupIcon: sanitizeText(value.groupIcon, 16) || undefined,
      groupDescription: sanitizeText(value.groupDescription, 1000),
      fromPeerId,
      fromName: sanitizeText(value.inviterName, 80) || 'WorldBase',
      fromRole: sanitizeText(value.inviterRole, 80),
      fromAvatar: normalizeOnlineGroupAvatar(value.inviterAvatar),
      fromBackground: normalizeOnlineGroupBackground(value.inviterBackground),
      fromTags: normalizeOnlineGroupTags(value.inviterTags),
      baseUrl,
      role: sanitizeText(value.role, 80) || '成员',
      inviteToken,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp
    })
    for (const outgoing of this.store.listInbox()) {
      if (outgoing.type === 'join-request'
        && outgoing.direction === 'outgoing'
        && outgoing.groupId === groupId
        && outgoing.status === 'pending') {
        this.store.saveInboxItem({ ...outgoing, status: 'approved' })
      }
    }
    this.emitChanged('invitation-received')
    return { accepted: true }
  }

  async handleIncomingJoinRequest (payload: unknown, actorPeerId = ''): Promise<{ accepted: boolean }> {
    const value = asRecord(payload)
    if (!value) throw new Error('Invalid join request payload.')
    const group = this.requireGroup(sanitizeText(value.groupId, 120))
    const requesterPeerId = sanitizeText(value.requesterPeerId, 120)
    if (!requesterPeerId || (actorPeerId && requesterPeerId !== actorPeerId)) {
      throw new Error('Join request sender identity does not match the requesting peer.')
    }
    const requestId = sanitizeText(value.requestId, 120) || randomUUID()
    if (this.store.getInboxItem(requestId)) return { accepted: true }
    const baseUrl = normalizeBaseUrl(sanitizeText(value.baseUrl, 500))
    assertLanUrl(baseUrl)
    this.store.saveInboxItem({
      id: requestId,
      type: 'join-request',
      direction: 'incoming',
      groupId: group.id,
      groupName: group.name,
      groupIcon: group.icon,
      groupDescription: group.description,
      fromPeerId: requesterPeerId,
      fromName: sanitizeText(value.requesterName, 80) || 'WorldBase',
      fromRole: sanitizeText(value.requesterRole, 80),
      fromAvatar: normalizeOnlineGroupAvatar(value.requesterAvatar),
      fromBackground: normalizeOnlineGroupBackground(value.requesterBackground),
      fromTags: normalizeOnlineGroupTags(value.requesterTags),
      baseUrl,
      role: sanitizeText(value.requestedRole, 80) || '成员',
      status: 'pending',
      createdAt: sanitizeText(value.createdAt, 80) || nowIso(),
      updatedAt: nowIso()
    })
    this.emitChanged('join-request-received', group.id)
    return { accepted: true }
  }

  handleJoinResponse (payload: unknown): { accepted: boolean } {
    const value = asRecord(payload)
    if (!value) throw new Error('Invalid join response payload.')
    const item = this.store.getInboxItem(sanitizeText(value.requestId, 120))
    if (item?.direction === 'outgoing' && item.status === 'pending') {
      this.store.saveInboxItem({
        ...item,
        status: value.status === 'rejected' ? 'rejected' : 'failed'
      })
      this.emitChanged('join-response')
    }
    return { accepted: true }
  }

  async handleAcceptInvite (groupId: string, payload: unknown): Promise<Record<string, unknown>> {
    const value = asRecord(payload)
    if (!value) throw new Error('Invalid accept-invite payload.')
    const group = this.requireGroup(groupId)
    if (sanitizeText(value.inviteToken, 200) !== group.inviteToken) {
      throw new Error('邀请码无效。')
    }
    const peerId = sanitizeText(value.peerId, 120)
    if (!peerId) throw new Error('Missing peer id.')
    const now = nowIso()
    const member: OnlineGroupMember = {
      id: memberHumanId(peerId),
      peerId,
      peerName: sanitizeText(value.displayName, 80) || 'WorldBase',
      kind: 'human',
      role: sanitizeText(value.role, 80) || '成员',
      avatar: normalizeOnlineGroupAvatar(value.avatar),
      background: normalizeOnlineGroupBackground(value.background),
      tags: normalizeOnlineGroupTags(value.tags),
      accessRole: 'member',
      baseUrl: normalizeBaseUrl(sanitizeText(value.baseUrl, 500)),
      joinedAt: now,
      updatedAt: now
    }
    assertLanUrl(member.baseUrl)
    group.members = mergeByUpdatedAt(group.members, [member])
    const saved = this.store.saveGroup(group)
    void this.publishDiscovery().catch(() => undefined)
    this.emitChanged('member-joined', saved.id)
    return {
      group: groupView(saved),
      accessToken: saved.accessToken
    }
  }

  getGroupSnapshot (groupId: string, accessToken: string): Record<string, unknown> {
    const group = this.requireToken(groupId, accessToken)
    return {
      group: groupView(group),
      serverTime: nowIso()
    }
  }

  handleIncomingGroupSettings (
    groupId: string,
    accessToken: string,
    payload: unknown,
    actorPeerId = ''
  ): OnlineGroup {
    const group = this.requireToken(groupId, accessToken)
    const actor = group.members.find(member => member.peerId === actorPeerId && member.kind === 'human')
    if (!actorPeerId || (group.ownerPeerId !== actorPeerId && actor?.accessRole !== 'admin')) {
      throw new Error('只有群主或管理员可以修改群聊内容。')
    }
    const value = asRecord(payload)
    if (!value) throw new Error('Invalid group settings payload.')
    const name = sanitizeText(value.name, 80)
    if (!name) throw new Error('群组名称不能为空。')
    group.name = name
    group.icon = sanitizeText(value.icon, 16) || '🌐'
    group.description = sanitizeText(value.description, 1000)
    group.settingsUpdatedAt = sanitizeText(value.settingsUpdatedAt, 80) || nowIso()
    const saved = this.store.saveGroup(group)
    void this.publishDiscovery().catch(() => undefined)
    this.emitChanged('group-updated', saved.id)
    return groupView(saved)
  }

  async handleIncomingMessage (groupId: string, accessToken: string, payload: unknown, actorPeerId = ''): Promise<{ accepted: boolean }> {
    const group = this.requireToken(groupId, accessToken)
    const value = asRecord(payload)
    const messageValue = asRecord(value?.message)
    if (!value || !messageValue) throw new Error('Invalid online-group message payload.')
    const message = messageValue as unknown as OnlineGroupMessage
    if (message.groupId !== group.id || !message.id || !message.senderPeerId) {
      throw new Error('Message does not match this group.')
    }
    if (!actorPeerId || message.senderPeerId !== actorPeerId) {
      throw new Error('Message sender identity does not match the requesting peer.')
    }
    if (!group.members.some(member => member.peerId === message.senderPeerId && member.kind === 'human')) {
      throw new Error('Message sender is not a group member.')
    }
    const actorHuman = group.members.find(member => member.peerId === actorPeerId && member.kind === 'human')!
    const kind = message.kind === 'agent' ? 'agent' : 'human'
    let senderName = actorHuman.peerName
    let senderRole = actorHuman.role
    let senderAvatar = normalizeOnlineGroupAvatar(actorHuman.avatar)
    let senderBackground = normalizeOnlineGroupBackground(actorHuman.background)
    let senderTags = normalizeOnlineGroupTags(actorHuman.tags)
    if (kind === 'agent') {
      const delegation = message.delegationId
        ? group.delegations.find(item => item.id === message.delegationId && item.toOwnerPeerId === actorPeerId)
        : undefined
      const agent = delegation
        ? group.members.find(member => member.id === delegation.toAgentMemberId && member.kind === 'agent')
        : group.members.find(member => (
            member.kind === 'agent'
            && member.peerId === actorPeerId
            && member.agentName === sanitizeText(message.senderName, 80)
          ))
      if (!agent) {
        throw new Error('Agent messages must come from an Agent owned by the sending peer.')
      }
      senderName = agent?.agentName || agent?.role || sanitizeText(message.senderName, 80)
      senderRole = agent?.role || sanitizeText(message.senderRole, 80)
      senderAvatar = normalizeOnlineGroupAvatar(agent?.agentIcon)
    }
    const attachments: OnlineGroupAttachment[] = (Array.isArray(message.attachments) ? message.attachments : [])
      .slice(0, 5)
      .flatMap(raw => {
        const attachment = asRecord(raw)
        if (!attachment) return []
        const id = sanitizeText(attachment.id, 120)
        const sha256 = sanitizeText(attachment.sha256, 128)
        const size = typeof attachment.size === 'number' && Number.isFinite(attachment.size)
          ? Math.max(0, Math.floor(attachment.size))
          : 0
        if (!id || !sha256) return []
        return [{
          id,
          name: sanitizeText(attachment.name, 200) || 'attachment',
          mimeType: sanitizeText(attachment.mimeType, 160) || 'application/octet-stream',
          size,
          sha256,
          sourcePeerId: actorPeerId
        }]
      })
    const files = Array.isArray(value.files) ? value.files : []
    const attachmentMeta = new Map(
      attachments.map(attachment => [attachment.id, attachment])
    )
    let totalUpload = 0
    const validatedFiles: Array<{ id: string; data: Buffer }> = []
    for (const rawFile of files) {
      const file = asRecord(rawFile)
      if (!file || typeof file.id !== 'string' || typeof file.dataBase64 !== 'string') continue
      if (!attachmentMeta.has(file.id)) {
        throw new Error('Uploaded file is not referenced by the message.')
      }
      const data = Buffer.from(file.dataBase64, 'base64')
      if (data.length > MAX_FILE_BYTES) throw new Error('Attachment exceeds the LAN file limit.')
      totalUpload += data.length
      if (totalUpload > MAX_TOTAL_UPLOAD_BYTES) throw new Error('Message attachments exceed the LAN upload budget.')
      const metadata = attachmentMeta.get(file.id)
      if (metadata) {
        const digest = createHash('sha256').update(data).digest('hex')
        if (metadata.size !== data.length || metadata.sha256 !== digest) {
          throw new Error(`Attachment ${metadata.name} failed integrity verification.`)
        }
      }
      validatedFiles.push({ id: file.id, data })
    }
    for (const file of validatedFiles) {
      this.store.saveAttachment(group.id, file.id, file.data)
    }
    group.messages = mergeMessages(group.messages, [{
      ...message,
      kind,
      senderName,
      senderRole,
      senderAvatar,
      senderBackground,
      senderTags,
      content: sanitizeText(message.content, MAX_MESSAGE_CHARS),
      attachments,
      createdAt: message.createdAt || nowIso()
    }])
    this.store.saveGroup(group)
    this.emitChanged('message-received', group.id)
    return { accepted: true }
  }

  handleIncomingMember (groupId: string, accessToken: string, payload: unknown, actorPeerId = ''): OnlineGroup {
    const group = this.requireToken(groupId, accessToken)
    const memberValue = asRecord(payload)
    if (!memberValue || typeof memberValue.id !== 'string' || typeof memberValue.peerId !== 'string') {
      throw new Error('Invalid member payload.')
    }
    if (!actorPeerId || memberValue.peerId !== actorPeerId) {
      throw new Error('Members can only update their own roster entry.')
    }
    if (!group.members.some(existing => existing.peerId === actorPeerId && existing.kind === 'human')) {
      throw new Error('Only existing group members can update their roster entry.')
    }
    let member: OnlineGroupMember
    if (memberValue.kind === 'human') {
      const existing = group.members.find(item => item.peerId === actorPeerId && item.kind === 'human')
      if (!existing) throw new Error('Human membership can only change through the invitation flow.')
      const baseUrl = normalizeBaseUrl(sanitizeText(memberValue.baseUrl, 500))
      if (baseUrl) assertLanUrl(baseUrl)
      member = {
        ...existing,
        peerName: sanitizeText(memberValue.peerName, 80) || existing.peerName,
        avatar: normalizeOnlineGroupAvatar(memberValue.avatar),
        background: normalizeOnlineGroupBackground(memberValue.background),
        tags: normalizeOnlineGroupTags(memberValue.tags),
        ...(baseUrl ? { baseUrl } : {}),
        updatedAt: sanitizeText(memberValue.updatedAt, 80) || nowIso()
      }
    } else if (memberValue.kind === 'agent') {
      member = memberValue as unknown as OnlineGroupMember
    } else {
      throw new Error('Invalid member kind.')
    }
    group.members = mergeByUpdatedAt(group.members, [member])
    if (group.ownerPeerId === member.peerId && member.kind === 'human') {
      group.ownerName = member.peerName
    }
    const saved = this.store.saveGroup(group)
    void this.publishDiscovery().catch(() => undefined)
    this.emitChanged('member-updated', saved.id)
    return groupView(saved)
  }

  handleMemberRemoval (groupId: string, accessToken: string, payload: unknown, actorPeerId = ''): OnlineGroup {
    const group = this.requireToken(groupId, accessToken)
    const value = asRecord(payload)
    const memberId = sanitizeText(value?.memberId, 200)
    if (!memberId) throw new Error('Missing member id.')
    const member = group.members.find(item => item.id === memberId)
    if (member && member.accessRole === 'owner') throw new Error('The group owner cannot be removed remotely.')
    if (member && member.peerId !== actorPeerId) {
      throw new Error('Members can only remove their own group agents.')
    }
    group.members = group.members.filter(item => item.id !== memberId)
    const saved = this.store.saveGroup(group)
    void this.publishDiscovery().catch(() => undefined)
    this.emitChanged('member-removed', saved.id)
    return groupView(saved)
  }

  handleRemoteGroupDelete (
    groupId: string,
    accessToken: string,
    payload: unknown,
    actorPeerId = ''
  ): { deleted: boolean } {
    const group = this.requireToken(groupId, accessToken)
    const value = asRecord(payload)
    const claimedOwner = sanitizeText(value?.actorPeerId, 120)
    if (!actorPeerId || claimedOwner !== actorPeerId || actorPeerId !== group.ownerPeerId) {
      throw new Error('Only the group owner can delete this online group.')
    }
    const deleted = this.store.deleteGroup(group.id)
    if (deleted) {
      void this.publishDiscovery().catch(() => undefined)
      this.emitChanged('group-deleted', group.id)
    }
    return { deleted }
  }

  handleIncomingDelegation (groupId: string, accessToken: string, payload: unknown, actorPeerId = ''): OnlineGroupDelegation {
    const group = this.requireToken(groupId, accessToken)
    const value = asRecord(payload)
    const delegation = value as unknown as OnlineGroupDelegation
    if (!delegation || delegation.groupId !== group.id || !delegation.id) {
      throw new Error('Invalid delegation payload.')
    }
    if (!actorPeerId || delegation.fromPeerId !== actorPeerId) {
      throw new Error('Delegation sender identity does not match the requesting peer.')
    }
    if (!group.members.some(member => member.peerId === delegation.fromPeerId && member.kind === 'human')) {
      throw new Error('Delegation sender is not a group member.')
    }
    if (delegation.fromAgentId && !group.members.some(member => (
      member.kind === 'agent'
      && member.peerId === delegation.fromPeerId
      && member.agentId === delegation.fromAgentId
    ))) {
      throw new Error('Delegation source Agent does not belong to the sending peer.')
    }
    const target = group.members.find(member => member.id === delegation.toAgentMemberId && member.kind === 'agent')
    if (!target || target.peerId !== delegation.toOwnerPeerId) {
      throw new Error('Delegation target is not a group agent.')
    }
    group.delegations = mergeByUpdatedAt(group.delegations, [{
      ...delegation,
      fromName: sanitizeText(delegation.fromName, 80) || 'WorldBase',
      fromAgentId: delegation.fromAgentId ? sanitizeText(delegation.fromAgentId, 120) : undefined,
      fromAgentName: delegation.fromAgentName ? sanitizeText(delegation.fromAgentName, 80) : undefined,
      toAgentName: sanitizeText(delegation.toAgentName, 80) || target.agentName || target.role,
      task: sanitizeText(delegation.task, 5000),
      context: delegation.context ? sanitizeText(delegation.context, 4000) : undefined,
      // A remote delegation always starts pending. Only the target owner's
      // local approval may move it into the approved/running state.
      status: 'pending_owner_approval',
      createdAt: sanitizeText(delegation.createdAt, 80) || nowIso(),
      updatedAt: sanitizeText(delegation.updatedAt, 80) || nowIso()
    }])
    const saved = this.store.saveGroup(group)
    this.emitChanged('delegation-received', saved.id)
    return delegation
  }

  handleIncomingDelegationDecision (groupId: string, accessToken: string, payload: unknown, actorPeerId = ''): OnlineGroup {
    const group = this.requireToken(groupId, accessToken)
    const value = asRecord(payload)
    const delegationId = sanitizeText(value?.delegationId, 120)
    const decidedByPeerId = sanitizeText(value?.decidedByPeerId, 120)
    if (!delegationId || !decidedByPeerId) throw new Error('Invalid delegation decision payload.')
    if (!actorPeerId || decidedByPeerId !== actorPeerId) {
      throw new Error('Delegation decision identity does not match the requesting peer.')
    }
    const delegation = group.delegations.find(item => item.id === delegationId)
    if (!delegation) throw new Error('Delegation not found.')
    if (delegation.toOwnerPeerId !== decidedByPeerId) {
      throw new Error('Only the agent owner can decide this delegation.')
    }
    const requestedStatus = sanitizeText(value?.status, 40)
    if (requestedStatus === 'running' || requestedStatus === 'completed' || requestedStatus === 'failed') {
      delegation.status = requestedStatus
    } else {
      delegation.status = value?.approved === true ? 'approved' : 'rejected'
    }
    delegation.decidedAt = sanitizeText(value?.decidedAt, 80) || nowIso()
    delegation.updatedAt = delegation.decidedAt
    if (typeof value?.result === 'string') delegation.result = value.result.slice(0, 20_000)
    if (typeof value?.error === 'string') delegation.error = value.error.slice(0, 4_000)
    const saved = this.store.saveGroup(group)
    this.emitChanged('delegation-decided', saved.id)
    return groupView(saved)
  }

  handleAttachmentDownload (groupId: string, accessToken: string, attachmentId: string): OnlineGroupAttachmentData {
    const group = this.requireToken(groupId, accessToken)
    const attachment = group.messages
      .flatMap(message => message.attachments)
      .find(item => item.id === attachmentId)
    if (!attachment) throw new Error('Attachment not found.')
    const data = this.store.readAttachment(group.id, attachmentId)
    if (!data) throw new Error('Attachment is not cached on this peer.')
    return {
      name: attachment.name,
      mimeType: attachment.mimeType,
      dataBase64: data.toString('base64')
    }
  }

  // ---- Internals ----------------------------------------------------------

  private selfBaseUrl (): string {
    if (this.options.baseUrl) return normalizeBaseUrl(this.options.baseUrl)
    const address = preferredLanIpv4Addresses()[0]
    return address ? `http://${address}:${this.options.port}` : ''
  }

  private async refreshSelfMemberIdentity (): Promise<void> {
    const nextBaseUrl = this.selfBaseUrl()
    for (const group of this.store.listGroups()) {
      let changed = false
      const selfMembers = group.members.filter(member => member.peerId === this.identity.instanceId)
      if (selfMembers.length === 0) continue
      for (const member of selfMembers) {
        if (member.peerName !== this.identity.displayName
          || member.avatar !== this.identity.avatar
          || member.background !== this.identity.background
          || JSON.stringify(member.tags || []) !== JSON.stringify(this.identity.tags || [])
          || (nextBaseUrl && member.baseUrl !== nextBaseUrl)) {
          member.peerName = this.identity.displayName
          member.avatar = this.identity.avatar
          member.background = this.identity.background
          member.tags = this.identity.tags
          if (nextBaseUrl) member.baseUrl = nextBaseUrl
          member.updatedAt = nowIso()
          changed = true
        }
      }
      if (group.ownerPeerId === this.identity.instanceId && group.ownerName !== this.identity.displayName) {
        group.ownerName = this.identity.displayName
        changed = true
      }
      if (!changed) continue
      const saved = this.store.saveGroup(group)
      for (const member of saved.members.filter(item => item.peerId === this.identity.instanceId)) {
        void this.broadcastMember(saved, member)
      }
    }
  }

  private recoverInterruptedDelegations (): void {
    for (const group of this.store.listGroups()) {
      let changed = false
      for (const delegation of group.delegations) {
        if (delegation.toOwnerPeerId !== this.identity.instanceId) continue
        if (delegation.status !== 'running' && delegation.status !== 'approved') continue
        delegation.status = 'failed'
        delegation.error = 'The owner WorldBase restarted before this Agent task completed.'
        delegation.updatedAt = nowIso()
        changed = true
      }
      if (changed) this.store.saveGroup(group)
    }
  }

  private publicGroupSummaries (): OnlineGroupPublicSummary[] {
    if (!this.identity.advertiseGroups) return []
    return this.store.listGroups().slice(0, 30).map(group => ({
      id: group.id,
      name: group.name,
      icon: group.icon,
      memberCount: group.members.length,
      ownerName: group.ownerName,
      joinPolicy: 'request'
    }))
  }

  private buildDiscoveryIdentity (): {
    instanceId: string
    displayName: string
    role: string
    avatar: string
    background: OnlineGroupBackground
    tags: string[]
    baseUrl: string
    appVersion: string
    hostname: string
    capabilities: string[]
    groups: OnlineGroupPublicSummary[]
  } {
    return {
      instanceId: this.identity.instanceId,
      displayName: this.identity.displayName,
      role: '',
      avatar: this.identity.avatar || '',
      background: normalizeOnlineGroupBackground(this.identity.background),
      tags: this.identity.tags || [],
      baseUrl: this.selfBaseUrl(),
      appVersion: this.options.appVersion || '1.7.6',
      hostname: os.hostname(),
      capabilities: ONLINE_GROUP_CAPABILITIES,
      groups: this.publicGroupSummaries()
    }
  }

  private async publishDiscovery (): Promise<void> {
    if (!this.identity.discoveryEnabled) return
    const harness = await this.options.resolveHarness()
    if (!harness) throw new Error('Rust harness 不可用，无法启动局域网发现。')
    const identity = this.buildDiscoveryIdentity()
    if (!identity.baseUrl) throw new Error('未检测到局域网 IPv4 地址，无法开始发现。')
    const current = await harness.getLanDiscoveryStatus().catch(() => null)
    const status = current?.running
      ? await harness.updateLanDiscovery(identity)
      : await harness.startLanDiscovery(identity)
    if (status.error) throw new Error(status.error)
  }

  private async stopHarnessDiscovery (): Promise<void> {
    const harness = await this.options.resolveHarness()
    await harness?.stopLanDiscovery().catch(() => undefined)
  }

  private async ensureDiscoveryRunning (): Promise<void> {
    if (!this.identity.discoveryEnabled) return
    const snapshot = await this.getDiscoverySnapshot()
    if (snapshot.running) return
    await this.publishDiscovery().catch(() => undefined)
  }

  private async getDiscoverySnapshot (): Promise<LanDiscoverySnapshot> {
    try {
      const harness = await this.options.resolveHarness()
      if (!harness) throw new Error('Rust harness 不可用。')
      const status = await harness.getLanDiscoveryStatus()
      return status
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        running: false,
        enabled: this.identity.discoveryEnabled,
        local: this.buildDiscoveryIdentity(),
        peers: [],
        multicastAddress: '239.255.76.87',
        port: 19528,
        error: detail
      }
    }
  }

  private requireGroup (groupId: string): OnlineGroupRecord {
    const group = this.store.getGroup(groupId)
    if (!group) throw new Error('在线群组不存在。')
    return group
  }

  private requireToken (groupId: string, accessToken: string): OnlineGroupRecord {
    const group = this.requireGroup(groupId)
    if (!group.accessToken || group.accessToken !== accessToken) {
      throw new Error('在线群组访问令牌无效。')
    }
    return group
  }

  private requireOwnerOrAdmin (group: OnlineGroupRecord): void {
    if (group.ownerPeerId === this.identity.instanceId) return
    const self = group.members.find(member => member.peerId === this.identity.instanceId && member.kind === 'human')
    if (self?.accessRole === 'admin') return
    throw new Error('只有群主或管理员可以执行此操作。')
  }

  private prepareAttachments (groupId: string, files: OnlineGroupFileInput[]): PreparedAttachment[] {
    if (files.length > 5) throw new Error('一次最多发送 5 个附件。')
    let total = 0
    const prepared = files.map(file => {
      const name = sanitizeText(file.name, 200) || 'attachment'
      const mimeType = sanitizeText(file.mimeType, 160) || 'application/octet-stream'
      const dataBase64 = typeof file.dataBase64 === 'string' ? file.dataBase64 : ''
      const data = Buffer.from(dataBase64, 'base64')
      if (data.length === 0) throw new Error(`附件 ${name} 为空。`)
      if (data.length > MAX_FILE_BYTES) throw new Error(`附件 ${name} 超过 6MB。`)
      total += data.length
      if (total > MAX_TOTAL_UPLOAD_BYTES) throw new Error('单条消息附件总大小超过 7MB。')
      const metadata: OnlineGroupAttachment = {
        id: randomUUID(),
        name,
        mimeType,
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
        sourcePeerId: this.identity.instanceId
      }
      return { metadata, data, dataBase64: data.toString('base64') }
    })
    for (const item of prepared) {
      this.store.saveAttachment(groupId, item.metadata.id, item.data)
    }
    return prepared.map(({ metadata, dataBase64 }) => ({ metadata, dataBase64 }))
  }

  private async syncAllGroups (): Promise<void> {
    await Promise.allSettled(this.store
      .listGroups()
      .filter(group => group.members.length >= 2)
      .map(group => this.syncOneGroup(group)))
  }

  private async syncOneGroup (group: OnlineGroupRecord): Promise<void> {
    if (this.syncing.has(group.id)) return
    this.syncing.add(group.id)
    try {
      const peers = [...new Map(group.members
        .filter(member => member.peerId !== this.identity.instanceId && member.baseUrl)
        .map(member => [member.peerId, member.baseUrl])).entries()]
      const remoteGroups: OnlineGroup[] = []
      await Promise.all(peers.map(async ([, baseUrl]) => {
        try {
          const response = await this.getJson(
            baseUrl,
            `/api/online-groups/${encodeURIComponent(group.id)}/snapshot`,
            group.accessToken,
            3500
          )
          const remote = asRecord(response)?.group as unknown as OnlineGroup | undefined
          if (remote && remote.id === group.id) remoteGroups.push(remote)
        } catch {
          // A sleeping/offline peer is expected; the next cycle retries.
        }
      }))
      if (remoteGroups.length === 0) return

      // Fetching happens off the event loop. Reload before merging so a
      // message or delegation saved while requests were in flight cannot be
      // overwritten by this sync's stale snapshot.
      const latest = this.store.getGroup(group.id)
      if (!latest) return
      let changed = false
      for (const remote of remoteGroups) {
        const beforeOwnerName = latest.ownerName
        const beforeMessages = latest.messages.length
        const beforeMembers = JSON.stringify(latest.members)
        const beforeDelegations = JSON.stringify(latest.delegations)
        latest.members = mergeByUpdatedAt(latest.members, remote.members || [])
        latest.messages = mergeMessages(latest.messages, remote.messages || [])
        latest.delegations = mergeByUpdatedAt(latest.delegations, remote.delegations || [])
        const remoteSettingsAt = Date.parse(remote.settingsUpdatedAt || remote.createdAt) || 0
        const localSettingsAt = Date.parse(latest.settingsUpdatedAt || latest.createdAt) || 0
        if (remoteSettingsAt > localSettingsAt) {
          latest.name = remote.name || latest.name
          latest.icon = remote.icon
          latest.description = remote.description || ''
          latest.settingsUpdatedAt = remote.settingsUpdatedAt || remote.updatedAt
          changed = true
        }
        const owner = latest.members.find(member => (
          member.kind === 'human' && member.peerId === latest.ownerPeerId
        ))
        if (owner && latest.ownerName !== owner.peerName) {
          latest.ownerName = owner.peerName
        }
        if (latest.messages.length !== beforeMessages
          || JSON.stringify(latest.members) !== beforeMembers
          || JSON.stringify(latest.delegations) !== beforeDelegations
          || latest.ownerName !== beforeOwnerName) {
          changed = true
        }
      }
      if (changed) {
        this.store.saveGroup(latest)
        this.emitChanged('group-synced', latest.id)
      }
    } finally {
      this.syncing.delete(group.id)
    }
  }

  private async broadcastMessage (
    group: OnlineGroupRecord,
    message: OnlineGroupMessage,
    files: Array<{ id: string; name: string; mimeType: string; dataBase64: string }>
  ): Promise<string[]> {
    const errors: string[] = []
    const peers = [...new Map(group.members
      .filter(member => member.peerId !== this.identity.instanceId && member.baseUrl)
      .map(member => [member.peerId, member.baseUrl])).entries()]
    await Promise.all(peers.map(async ([peerId, baseUrl]) => {
      try {
        await this.postJson(
          baseUrl,
          `/api/online-groups/${encodeURIComponent(group.id)}/messages`,
          group.accessToken,
          { message, files }
        )
      } catch (error) {
        errors.push(`${peerId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))
    return errors
  }

  private async broadcastMember (group: OnlineGroupRecord, member: OnlineGroupMember): Promise<void> {
    await Promise.all(group.members
      .filter(existing => existing.peerId !== this.identity.instanceId && existing.baseUrl)
      .map(existing => this.postJson(
        existing.baseUrl,
        `/api/online-groups/${encodeURIComponent(group.id)}/members`,
        group.accessToken,
        member
      ).catch(() => undefined)))
  }

  private async broadcastGroupSettings (group: OnlineGroupRecord): Promise<void> {
    const peers = [...new Map(group.members
      .filter(member => member.peerId !== this.identity.instanceId && member.baseUrl)
      .map(member => [member.peerId, member.baseUrl])).entries()]
    await Promise.all(peers.map(([, baseUrl]) => this.postJson(
      baseUrl,
      `/api/online-groups/${encodeURIComponent(group.id)}/settings`,
      group.accessToken,
      {
        name: group.name,
        icon: group.icon,
        description: group.description,
        settingsUpdatedAt: group.settingsUpdatedAt
      }
    ).catch(() => undefined)))
  }

  private async broadcastMemberRemoval (group: OnlineGroupRecord, memberId: string): Promise<void> {
    await Promise.all(group.members
      .filter(existing => existing.peerId !== this.identity.instanceId && existing.baseUrl)
      .map(existing => this.postJson(
        existing.baseUrl,
        `/api/online-groups/${encodeURIComponent(group.id)}/members/remove`,
        group.accessToken,
        { memberId }
      ).catch(() => undefined)))
  }

  private async broadcastDelegation (group: OnlineGroupRecord, delegation: OnlineGroupDelegation): Promise<void> {
    await Promise.all(group.members
      .filter(existing => existing.peerId !== this.identity.instanceId && existing.baseUrl)
      .map(existing => this.postJson(
        existing.baseUrl,
        `/api/online-groups/${encodeURIComponent(group.id)}/delegations`,
        group.accessToken,
        delegation
      ).catch(() => undefined)))
  }

  private async broadcastDelegationDecision (
    group: OnlineGroupRecord,
    delegation: OnlineGroupDelegation
  ): Promise<void> {
    await Promise.all(group.members
      .filter(existing => existing.peerId !== this.identity.instanceId && existing.baseUrl)
      .map(existing => this.postJson(
        existing.baseUrl,
        `/api/online-groups/${encodeURIComponent(group.id)}/delegations/${encodeURIComponent(delegation.id)}/decision`,
        group.accessToken,
        {
          delegationId: delegation.id,
          decidedByPeerId: this.identity.instanceId,
          approved: delegation.status === 'approved',
          status: delegation.status,
          decidedAt: delegation.decidedAt,
          result: delegation.result,
          error: delegation.error
        }
      ).catch(() => undefined)))
  }

  private async executeDelegation (groupId: string, delegationId: string): Promise<void> {
    const group = this.store.getGroup(groupId)
    if (!group) return
    const delegation = group.delegations.find(item => item.id === delegationId)
    if (!delegation || delegation.status !== 'approved') return
    if (delegation.toOwnerPeerId !== this.identity.instanceId) return
    const agent = group.members.find(member => member.id === delegation.toAgentMemberId && member.kind === 'agent')
    if (!agent?.agentId || !this.agentExecutor) {
      delegation.status = 'failed'
      delegation.error = 'Agent executor is unavailable.'
      delegation.updatedAt = nowIso()
      this.store.saveGroup(group)
      await this.broadcastDelegationDecision(group, delegation)
      this.emitChanged('delegation-failed', group.id)
      return
    }
    delegation.status = 'running'
    delegation.updatedAt = nowIso()
    this.store.saveGroup(group)
    await this.broadcastDelegationDecision(group, delegation)
    this.emitChanged('delegation-running', group.id)
    try {
      const reply = sanitizeText(await this.agentExecutor({
        agentId: agent.agentId,
        task: delegation.task,
        context: this.buildGroupContext(group),
        groupName: group.name,
        groupId: group.id
      }), MAX_MESSAGE_CHARS)
      if (!reply) throw new Error('Online group Agent returned no visible result.')
      const latest = this.store.getGroup(groupId)
      if (!latest) return
      const latestDelegation = latest.delegations.find(item => item.id === delegationId)
      if (!latestDelegation) return
      latestDelegation.status = 'completed'
      latestDelegation.result = reply
      latestDelegation.decidedAt = latestDelegation.decidedAt || nowIso()
      latestDelegation.updatedAt = nowIso()
      const message: OnlineGroupMessage = {
        id: randomUUID(),
        groupId: latest.id,
        senderPeerId: this.identity.instanceId,
        senderName: agent.agentName || agent.role,
        senderRole: agent.role,
        senderAvatar: agent.agentIcon,
        senderBackground: this.identity.background,
        senderTags: this.identity.tags,
        kind: 'agent',
        content: reply,
        attachments: [],
        createdAt: nowIso(),
        delegationId
      }
      latest.messages = mergeMessages(latest.messages, [message])
      this.store.saveGroup(latest)
      await this.broadcastDelegationDecision(latest, latestDelegation)
      await this.broadcastMessage(latest, message, [])
      this.emitChanged('delegation-completed', latest.id)
      void this.routeMentionDelegations(latest.id, message, agent).catch(error => {
        console.warn('[online-groups] Mention delegation from delegated Agent failed:', error)
      })
    } catch (error) {
      const latest = this.store.getGroup(groupId)
      if (!latest) return
      const latestDelegation = latest.delegations.find(item => item.id === delegationId)
      if (!latestDelegation) return
      latestDelegation.status = 'failed'
      latestDelegation.error = error instanceof Error ? error.message : String(error)
      latestDelegation.updatedAt = nowIso()
      this.store.saveGroup(latest)
      await this.broadcastDelegationDecision(latest, latestDelegation)
      this.emitChanged('delegation-failed', latest.id)
    }
  }

  private async postAgentMessage (
    group: OnlineGroupRecord,
    member: OnlineGroupMember,
    reply: string
  ): Promise<OnlineGroupSendResult> {
    const message: OnlineGroupMessage = {
      id: randomUUID(),
      groupId: group.id,
      senderPeerId: this.identity.instanceId,
      senderName: member.agentName || member.role,
      senderRole: member.role,
      senderAvatar: member.agentIcon,
      senderBackground: this.identity.background,
      senderTags: this.identity.tags,
      kind: 'agent',
      content: sanitizeText(reply, MAX_MESSAGE_CHARS),
      attachments: [],
      createdAt: nowIso()
    }
    group.messages = mergeMessages(group.messages, [message])
    const saved = this.store.saveGroup(group)
    const deliveryErrors = await this.broadcastMessage(saved, message, [])
    this.emitChanged('agent-message', saved.id)
    void this.routeMentionDelegations(saved.id, message, member).catch(error => {
      console.warn('[online-groups] Mention delegation from Agent failed:', error)
    })
    return { group: groupView(saved), deliveryErrors }
  }

  private async routeMentionDelegations (
    groupId: string,
    message: OnlineGroupMessage,
    sourceAgent?: OnlineGroupMember
  ): Promise<void> {
    const group = this.store.getGroup(groupId)
    if (!group) return
    const { targets, task } = resolveAgentMentions(message.content, group)
    if (targets.length === 0) return
    const messageAt = Date.parse(message.createdAt) || Date.now()
    for (const target of targets) {
      if (sourceAgent?.id === target.id) continue
      const recent = group.delegations.find(delegation => {
        if (delegation.toAgentMemberId !== target.id) return false
        if (delegation.fromPeerId !== message.senderPeerId) return false
        if (delegation.status === 'failed' || delegation.status === 'rejected') return false
        if (sourceAgent) {
          if (delegation.fromAgentId !== sourceAgent.agentId) return false
        } else if (delegation.fromAgentId) {
          return false
        }
        const created = Date.parse(delegation.createdAt) || messageAt
        if (Math.abs(messageAt - created) > 120_000) return false
        if (sourceAgent) return true
        return delegation.task === task
          || delegation.task.includes(task)
          || task.includes(delegation.task)
      })
      if (recent) continue
      await this.createDelegation(group.id, target.id, task, sourceAgent?.agentId)
    }
  }

  private buildGroupContext (group: OnlineGroupRecord): string {
    const agentRoster = group.members
      .filter(member => member.kind === 'agent')
      .map(member => (
        `- @${member.agentName || member.role}（agentMemberId: ${member.id}，所有者：${member.peerName}，角色说明：${member.agentDescription?.trim() || '未提供'}）`
      ))
      .join('\n')
    const recent = group.messages.slice(-16).map(message => {
      const who = `${message.senderName}${message.senderRole ? ` / ${message.senderRole}` : ''}`
      return `[${message.createdAt}] ${who}: ${message.content}`
    }).join('\n')
    return [
      `你正在参与局域网在线群组「${group.name}」。`,
      '你必须把其他成员的 Agent 视为有独立所有者的协作者。',
      '用户消息是整体目标，不是要转发的原文。被用户点名时，先理解并拆解目标、完成自己适合承担的部分；需要其他 Agent 协作时，用 @Agent名称 分配具体子任务，并写清对方负责的范围、必要上下文、限制和真实交付物。不要把用户原文或轻微改写后的原文直接转交给另一个 Agent。',
      '每个 Agent 的名称、角色说明和系统人设已由运行环境提供。交接或 @ 委派正文只写具体任务、上下文与证据，不要要求对方扮演某种身份、问候、自我介绍、采用某种语气或输出格式，也不要写只验收问候/身份表演的验收标准。',
      '不要声称自己代表其他人类成员；跨用户委派只能提出请求，必须由对方 Agent 的所有者批准后执行。',
      '需要其他 Agent 接手时，直接在回复中用 @Agent名称 写明要对方完成的具体任务；系统会自动创建委派。若目标属于同一所有者会立即执行；跨用户委派仍需对方所有者批准。也可以调用 delegate_group_agent，并传入目标 agentMemberId。',
      '这是已获所有者批准的后台任务：缺少非阻塞信息时说明假设并继续；确实无法继续时直接返回具体阻塞项，不要等待交互式追问。',
      agentRoster ? `群内 Agent：\n${agentRoster}` : '',
      recent ? `最近的群聊：\n${recent}` : ''
    ].filter(Boolean).join('\n\n')
  }

  private emitChanged (action: string, groupId?: string): void {
    this.options.onChanged?.({ action, groupId })
  }

  private async postJson (
    baseUrl: string,
    requestPath: string,
    accessToken: string | null,
    body: unknown,
    timeoutMs = REMOTE_TIMEOUT_MS
  ): Promise<unknown> {
    const url = new URL(requestPath, `${assertLanUrl(normalizeBaseUrl(baseUrl)).origin}/`)
    assertLanUrl(url.toString())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-worldbase-peer-id': this.identity.instanceId,
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
      }
      return await response.json().catch(() => ({}))
    } finally {
      clearTimeout(timer)
    }
  }

  private async getJson (
    baseUrl: string,
    requestPath: string,
    accessToken: string,
    timeoutMs = REMOTE_TIMEOUT_MS
  ): Promise<unknown> {
    const url = new URL(requestPath, `${assertLanUrl(normalizeBaseUrl(baseUrl)).origin}/`)
    assertLanUrl(url.toString())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }
}

export type { AgentExecutor }
