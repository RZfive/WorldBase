/**
 * LAN-first collaboration model shared by the Electron main process,
 * preload bridge, and renderer.
 *
 * A group is replicated peer-to-peer: every member stores the same message
 * history and forwards new messages to the other online members. This keeps
 * the feature usable on a local network without a central WorldBase service.
 */

export type OnlineGroupAccessRole = 'owner' | 'admin' | 'member' | 'observer'

export type OnlineGroupMemberKind = 'human' | 'agent'

export type OnlineGroupMessageKind = 'human' | 'agent' | 'system'

export type OnlineGroupBackground =
  | 'aurora'
  | 'ocean'
  | 'sunset'
  | 'forest'
  | 'graphite'
  | 'rose'

export type OnlineGroupDelegationStatus =
  | 'pending_owner_approval'
  | 'approved'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'

export interface OnlineGroupIdentity {
  instanceId: string
  displayName: string
  role: string
  avatar?: string
  background?: OnlineGroupBackground
  tags?: string[]
  discoveryEnabled: boolean
  advertiseGroups: boolean
  createdAt: string
  updatedAt: string
}

export interface OnlineGroupPublicSummary {
  id: string
  name: string
  icon?: string
  memberCount: number
  ownerName: string
  joinPolicy: 'request'
}

/** Shape emitted by harness-rs `lan.discovery.status`. */
export interface LanDiscoveredPeer {
  instanceId: string
  displayName: string
  role: string
  avatar?: string
  background?: OnlineGroupBackground
  tags?: string[]
  baseUrl: string
  appVersion: string
  hostname: string
  capabilities: string[]
  groups: OnlineGroupPublicSummary[]
  address: string
  lastSeenAt: string
  online: boolean
}

export interface LanDiscoverySnapshot {
  running: boolean
  enabled: boolean
  local: {
    instanceId: string
    displayName: string
    role: string
    avatar?: string
    background?: OnlineGroupBackground
    tags?: string[]
    baseUrl: string
    appVersion: string
    hostname: string
    capabilities: string[]
    groups: OnlineGroupPublicSummary[]
  } | null
  peers: LanDiscoveredPeer[]
  multicastAddress: string
  port: number
  error?: string
}

export interface OnlineGroupAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  sha256: string
  sourcePeerId: string
}

export interface OnlineGroupMessage {
  id: string
  groupId: string
  senderPeerId: string
  senderName: string
  senderRole: string
  senderAvatar?: string
  senderBackground?: OnlineGroupBackground
  senderTags?: string[]
  kind: OnlineGroupMessageKind
  content: string
  attachments: OnlineGroupAttachment[]
  createdAt: string
  delegationId?: string
}

export interface OnlineGroupMember {
  id: string
  peerId: string
  peerName: string
  kind: OnlineGroupMemberKind
  role: string
  avatar?: string
  background?: OnlineGroupBackground
  tags?: string[]
  accessRole: OnlineGroupAccessRole
  baseUrl: string
  agentId?: string
  agentName?: string
  agentIcon?: string
  agentDescription?: string
  joinedAt: string
  updatedAt: string
}

export interface OnlineGroupDelegation {
  id: string
  groupId: string
  fromPeerId: string
  fromName: string
  fromAgentId?: string
  fromAgentName?: string
  toAgentMemberId: string
  toAgentName: string
  toOwnerPeerId: string
  task: string
  context?: string
  status: OnlineGroupDelegationStatus
  createdAt: string
  updatedAt: string
  decidedAt?: string
  result?: string
  error?: string
}

export interface OnlineGroup {
  id: string
  name: string
  icon?: string
  description: string
  ownerPeerId: string
  ownerName: string
  accessRole: OnlineGroupAccessRole
  joinPolicy: 'request'
  createdAt: string
  updatedAt: string
  /** Last owner/admin edit of group name, icon or description. */
  settingsUpdatedAt?: string
  members: OnlineGroupMember[]
  messages: OnlineGroupMessage[]
  delegations: OnlineGroupDelegation[]
}

export interface OnlineGroupInboxItem {
  id: string
  type: 'invitation' | 'join-request'
  direction: 'incoming' | 'outgoing'
  groupId: string
  groupName: string
  groupIcon?: string
  groupDescription?: string
  fromPeerId: string
  fromName: string
  fromRole: string
  fromAvatar?: string
  fromBackground?: OnlineGroupBackground
  fromTags?: string[]
  baseUrl: string
  role: string
  inviteToken?: string
  note?: string
  status: 'pending' | 'accepted' | 'declined' | 'approved' | 'rejected' | 'failed'
  createdAt: string
  updatedAt: string
  error?: string
}

export interface OnlineGroupState {
  identity: OnlineGroupIdentity
  discovery: LanDiscoverySnapshot
  groups: OnlineGroup[]
  inbox: OnlineGroupInboxItem[]
  localAddresses: string[]
  serverPort: number
}

export interface OnlineGroupFileInput {
  name: string
  mimeType: string
  dataBase64: string
}

export interface OnlineGroupAttachmentData {
  name: string
  mimeType: string
  dataBase64: string
}

export interface OnlineGroupSendResult {
  group: OnlineGroup
  deliveryErrors: string[]
}

export interface OnlineGroupDelegationResult {
  group: OnlineGroup
  delegation: OnlineGroupDelegation
  executed: boolean
}

export interface OnlineGroupChangeEvent {
  action: string
  groupId?: string
}
