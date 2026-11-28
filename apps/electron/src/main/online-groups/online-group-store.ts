import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  OnlineGroup,
  OnlineGroupIdentity,
  OnlineGroupInboxItem,
  OnlineGroupMember
} from '../../shared/online-group-types.js'
import {
  normalizeOnlineGroupAvatar,
  normalizeOnlineGroupBackground,
  normalizeOnlineGroupTags
} from './profile.js'

export interface OnlineGroupRecord extends OnlineGroup {
  accessToken: string
  inviteToken: string
  updatedAt: string
}

const MAX_MESSAGES_PER_GROUP = 2000

function sanitizeId (value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 160)
}

function sanitizeMemberId (value: string): string {
  return value.replace(/[^a-zA-Z0-9_:-]/g, '').slice(0, 220)
}

function nowIso (): string {
  return new Date().toISOString()
}

function normalizeIdentity (value: Partial<OnlineGroupIdentity> | null | undefined): OnlineGroupIdentity {
  const timestamp = nowIso()
  const instanceId = typeof value?.instanceId === 'string' && value.instanceId.trim()
    ? sanitizeId(value.instanceId.trim())
    : `worldbase-${randomUUID().replace(/-/g, '')}`
  return {
    instanceId,
    displayName: typeof value?.displayName === 'string' && value.displayName.trim()
      ? value.displayName.trim().slice(0, 80)
      : 'WorldBase',
    role: typeof value?.role === 'string' ? value.role.trim().slice(0, 80) : '',
    avatar: normalizeOnlineGroupAvatar(value?.avatar),
    background: normalizeOnlineGroupBackground(value?.background),
    tags: normalizeOnlineGroupTags(value?.tags),
    discoveryEnabled: value?.discoveryEnabled === true,
    advertiseGroups: value?.advertiseGroups !== false,
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : timestamp,
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : timestamp
  }
}

function normalizeMember (value: Partial<OnlineGroupMember> | null | undefined): OnlineGroupMember | null {
  if (!value || typeof value.peerId !== 'string' || !value.peerId.trim()) return null
  const timestamp = nowIso()
  const peerId = sanitizeId(value.peerId)
  const kind = value.kind === 'agent' ? 'agent' : 'human'
  const agentId = kind === 'agent' && typeof value.agentId === 'string' ? sanitizeId(value.agentId) : undefined
  const id = `${peerId}:${kind === 'agent' ? `agent:${agentId || 'unknown'}` : 'human'}`
  return {
    // IDs are derived from the authenticated peer and agent identity. Never
    // trust a remote payload's id: otherwise a member could overwrite another
    // member's roster row by reusing its id.
    id: sanitizeMemberId(id),
    peerId,
    peerName: typeof value.peerName === 'string' ? value.peerName.trim().slice(0, 80) : 'WorldBase',
    kind,
    role: typeof value.role === 'string' ? value.role.trim().slice(0, 80) : '',
    avatar: normalizeOnlineGroupAvatar(value.avatar),
    background: normalizeOnlineGroupBackground(value.background),
    tags: normalizeOnlineGroupTags(value.tags),
    accessRole: kind === 'agent'
      ? 'member'
      : value.accessRole === 'owner' || value.accessRole === 'admin' || value.accessRole === 'observer'
        ? value.accessRole
        : 'member',
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl.trim().replace(/\/+$/, '') : '',
    ...(agentId ? { agentId } : {}),
    ...(typeof value.agentName === 'string' ? { agentName: value.agentName.trim().slice(0, 80) } : {}),
    ...(typeof value.agentIcon === 'string' ? { agentIcon: value.agentIcon.slice(0, 16) } : {}),
    ...(typeof value.agentDescription === 'string' ? { agentDescription: value.agentDescription.trim().slice(0, 500) } : {}),
    joinedAt: typeof value.joinedAt === 'string' ? value.joinedAt : timestamp,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : timestamp
  }
}

function normalizeGroup (value: Partial<OnlineGroupRecord>): OnlineGroupRecord | null {
  if (!value || typeof value.id !== 'string' || !value.id.trim()) return null
  const timestamp = nowIso()
  const members = Array.isArray(value.members)
    ? value.members.map(normalizeMember).filter((member): member is OnlineGroupMember => Boolean(member))
    : []
  const messages = Array.isArray(value.messages)
    ? value.messages
      .filter(message => Boolean(message && typeof message.id === 'string' && message.groupId === value.id))
      .slice(-MAX_MESSAGES_PER_GROUP)
    : []
  const delegations = Array.isArray(value.delegations)
    ? value.delegations.filter(item => Boolean(item && typeof item.id === 'string' && item.groupId === value.id))
    : []
  return {
    id: sanitizeId(value.id),
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 80) : '在线群组',
    icon: typeof value.icon === 'string' ? value.icon.slice(0, 16) : undefined,
    description: typeof value.description === 'string' ? value.description.trim().slice(0, 1000) : '',
    ownerPeerId: typeof value.ownerPeerId === 'string' ? sanitizeId(value.ownerPeerId) : '',
    ownerName: typeof value.ownerName === 'string' ? value.ownerName.trim().slice(0, 80) : '',
    accessRole: value.accessRole === 'owner' || value.accessRole === 'admin' || value.accessRole === 'observer'
      ? value.accessRole
      : 'member',
    joinPolicy: 'request',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : timestamp,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : timestamp,
    settingsUpdatedAt: typeof value.settingsUpdatedAt === 'string'
      ? value.settingsUpdatedAt
      : typeof value.createdAt === 'string'
        ? value.createdAt
        : timestamp,
    members,
    messages,
    delegations,
    accessToken: typeof value.accessToken === 'string' ? value.accessToken : '',
    inviteToken: typeof value.inviteToken === 'string' ? value.inviteToken : ''
  }
}

function normalizeInboxItem (value: Partial<OnlineGroupInboxItem>): OnlineGroupInboxItem | null {
  if (!value || typeof value.id !== 'string' || !value.id.trim()) return null
  if (!value.groupId || !value.groupName) return null
  const timestamp = nowIso()
  const status = value.status === 'accepted'
    || value.status === 'declined'
    || value.status === 'approved'
    || value.status === 'rejected'
    || value.status === 'failed'
    ? value.status
    : 'pending'
  return {
    id: sanitizeId(value.id),
    type: value.type === 'join-request' ? 'join-request' : 'invitation',
    direction: value.direction === 'outgoing' ? 'outgoing' : 'incoming',
    groupId: sanitizeId(value.groupId),
    groupName: value.groupName.trim().slice(0, 80),
    groupIcon: typeof value.groupIcon === 'string' ? value.groupIcon.slice(0, 16) : undefined,
    groupDescription: typeof value.groupDescription === 'string' ? value.groupDescription.trim().slice(0, 1000) : '',
    fromPeerId: typeof value.fromPeerId === 'string' ? sanitizeId(value.fromPeerId) : '',
    fromName: typeof value.fromName === 'string' ? value.fromName.trim().slice(0, 80) : 'WorldBase',
    fromRole: typeof value.fromRole === 'string' ? value.fromRole.trim().slice(0, 80) : '',
    fromAvatar: normalizeOnlineGroupAvatar(value.fromAvatar),
    fromBackground: normalizeOnlineGroupBackground(value.fromBackground),
    fromTags: normalizeOnlineGroupTags(value.fromTags),
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl.trim().replace(/\/+$/, '') : '',
    role: typeof value.role === 'string' ? value.role.trim().slice(0, 80) : '',
    inviteToken: typeof value.inviteToken === 'string' ? value.inviteToken : undefined,
    note: typeof value.note === 'string' ? value.note.trim().slice(0, 500) : undefined,
    status,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : timestamp,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : timestamp,
    error: typeof value.error === 'string' ? value.error.slice(0, 1000) : undefined
  }
}

function writeJsonAtomic (filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf-8')
  fs.renameSync(tempPath, filePath)
}

export class OnlineGroupStore {
  private readonly rootDir: string
  private readonly groupsDir: string
  private readonly filesDir: string
  private readonly identityPath: string
  private readonly inboxPath: string

  constructor (userDataPath: string) {
    this.rootDir = path.join(userDataPath, 'online-groups')
    this.groupsDir = path.join(this.rootDir, 'groups')
    this.filesDir = path.join(this.rootDir, 'files')
    this.identityPath = path.join(this.rootDir, 'identity.json')
    this.inboxPath = path.join(this.rootDir, 'inbox.json')
    fs.mkdirSync(this.groupsDir, { recursive: true })
    fs.mkdirSync(this.filesDir, { recursive: true })
  }

  loadIdentity (): OnlineGroupIdentity {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.identityPath, 'utf-8')) as Partial<OnlineGroupIdentity>
      return normalizeIdentity(parsed)
    } catch {
      const identity = normalizeIdentity({ displayName: 'WorldBase' })
      this.saveIdentity(identity)
      return identity
    }
  }

  saveIdentity (identity: OnlineGroupIdentity): OnlineGroupIdentity {
    const normalized = normalizeIdentity({ ...identity, updatedAt: nowIso() })
    writeJsonAtomic(this.identityPath, normalized)
    return normalized
  }

  listGroups (): OnlineGroupRecord[] {
    if (!fs.existsSync(this.groupsDir)) return []
    const groups: OnlineGroupRecord[] = []
    for (const file of fs.readdirSync(this.groupsDir).filter(name => name.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.groupsDir, file), 'utf-8')) as Partial<OnlineGroupRecord>
        const group = normalizeGroup(parsed)
        if (group) groups.push(group)
      } catch {
        // A damaged group must not take down every other LAN collaboration.
      }
    }
    return groups.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  getGroup (id: string): OnlineGroupRecord | null {
    const safeId = sanitizeId(id)
    if (!safeId) return null
    try {
      const parsed = JSON.parse(fs.readFileSync(this.groupPath(safeId), 'utf-8')) as Partial<OnlineGroupRecord>
      return normalizeGroup(parsed)
    } catch {
      return null
    }
  }

  saveGroup (group: OnlineGroupRecord): OnlineGroupRecord {
    const normalized = normalizeGroup({ ...group, updatedAt: nowIso() })
    if (!normalized) throw new Error('Invalid online group record.')
    normalized.messages = normalized.messages.slice(-MAX_MESSAGES_PER_GROUP)
    writeJsonAtomic(this.groupPath(normalized.id), normalized)
    return normalized
  }

  deleteGroup (id: string): boolean {
    const safeId = sanitizeId(id)
    try {
      fs.unlinkSync(this.groupPath(safeId))
      try {
        fs.rmSync(path.join(this.filesDir, safeId), { recursive: true, force: true })
      } catch {
        // Group metadata is already gone; a locked attachment cache must not
        // resurrect a deleted group or fail the delete operation.
      }
      return true
    } catch {
      return false
    }
  }

  listInbox (): OnlineGroupInboxItem[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.inboxPath, 'utf-8')) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed
        .map(item => normalizeInboxItem(item as Partial<OnlineGroupInboxItem>))
        .filter((item): item is OnlineGroupInboxItem => Boolean(item))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    } catch {
      return []
    }
  }

  getInboxItem (id: string): OnlineGroupInboxItem | null {
    return this.listInbox().find(item => item.id === sanitizeId(id)) || null
  }

  saveInboxItem (item: OnlineGroupInboxItem): OnlineGroupInboxItem {
    const normalized = normalizeInboxItem({ ...item, updatedAt: nowIso() })
    if (!normalized) throw new Error('Invalid online group inbox item.')
    const items = this.listInbox().filter(existing => existing.id !== normalized.id)
    items.unshift(normalized)
    writeJsonAtomic(this.inboxPath, items)
    return normalized
  }

  saveAttachment (groupId: string, attachmentId: string, data: Buffer): void {
    const dir = path.join(this.filesDir, sanitizeId(groupId))
    fs.mkdirSync(dir, { recursive: true })
    writeJsonAtomic(path.join(dir, sanitizeId(attachmentId)), { dataBase64: data.toString('base64') })
  }

  readAttachment (groupId: string, attachmentId: string): Buffer | null {
    try {
      const raw = JSON.parse(fs.readFileSync(
        path.join(this.filesDir, sanitizeId(groupId), sanitizeId(attachmentId)),
        'utf-8'
      )) as { dataBase64?: unknown }
      if (typeof raw.dataBase64 !== 'string') return null
      return Buffer.from(raw.dataBase64, 'base64')
    } catch {
      return null
    }
  }

  private groupPath (id: string): string {
    return path.join(this.groupsDir, `${sanitizeId(id)}.json`)
  }
}

export { MAX_MESSAGES_PER_GROUP }
