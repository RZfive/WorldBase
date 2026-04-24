import fs from 'node:fs'
import path from 'node:path'
import type { ChannelBinding, ConnectorDefinition } from '../../shared/agent-workspace-types.js'

export const BUILTIN_CONNECTORS: ConnectorDefinition[] = [
  {
    id: 'feishu',
    name: 'Feishu',
    description: '为未来接入飞书群、线程与审批链路做准备。',
    supportsThreads: true,
    supportsMentions: true,
    supportsAttachments: true
  },
  {
    id: 'wecom',
    name: 'WeCom',
    description: '为未来接入企业微信会话与审批流做准备。',
    supportsThreads: false,
    supportsMentions: true,
    supportsAttachments: true
  },
  {
    id: 'slack',
    name: 'Slack',
    description: '为未来接入 Slack channel 与 thread 做准备。',
    supportsThreads: true,
    supportsMentions: true,
    supportsAttachments: true
  },
  {
    id: 'discord',
    name: 'Discord',
    description: '为未来接入 Discord guild channel 与 thread 做准备。',
    supportsThreads: true,
    supportsMentions: true,
    supportsAttachments: true
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: '为未来接入 Telegram 群组与机器人回复做准备。',
    supportsThreads: false,
    supportsMentions: false,
    supportsAttachments: true
  },
  {
    id: 'custom',
    name: 'Custom Webhook',
    description: '自定义消息入口，适合后续对接中台或内部 IM 网关。',
    supportsThreads: true,
    supportsMentions: true,
    supportsAttachments: true
  }
]

function createBindingId (): string {
  return `binding_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeBinding (value: Partial<ChannelBinding>, existing?: ChannelBinding | null): ChannelBinding {
  const timestamp = new Date().toISOString()

  return {
    id: value.id || existing?.id || createBindingId(),
    connectorType: value.connectorType || existing?.connectorType || 'custom',
    externalChannelId: typeof value.externalChannelId === 'string' ? value.externalChannelId.trim() : (existing?.externalChannelId || ''),
    externalThreadId: typeof value.externalThreadId === 'string' && value.externalThreadId.trim() ? value.externalThreadId.trim() : existing?.externalThreadId,
    boundConversationId: typeof value.boundConversationId === 'string' && value.boundConversationId.trim() ? value.boundConversationId.trim() : existing?.boundConversationId,
    boundGroupId: typeof value.boundGroupId === 'string' && value.boundGroupId.trim() ? value.boundGroupId.trim() : existing?.boundGroupId,
    defaultAgentId: typeof value.defaultAgentId === 'string' && value.defaultAgentId.trim() ? value.defaultAgentId.trim() : existing?.defaultAgentId,
    targetProjectId: typeof value.targetProjectId === 'string' && value.targetProjectId.trim() ? value.targetProjectId.trim() : (value.targetProjectId === null ? null : existing?.targetProjectId),
    autoReply: value.autoReply ?? existing?.autoReply ?? false,
    requireApprovalForRiskyTools: value.requireApprovalForRiskyTools ?? existing?.requireApprovalForRiskyTools ?? true,
    createdAt: existing?.createdAt || value.createdAt || timestamp,
    updatedAt: timestamp
  }
}

export class ChannelBindingStore {
  private filePath: string

  constructor (userDataPath: string) {
    const dir = path.join(userDataPath, 'im')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    this.filePath = path.join(dir, 'channel-bindings.json')
  }

  listConnectors (): ConnectorDefinition[] {
    return BUILTIN_CONNECTORS.map(item => ({ ...item }))
  }

  private readAll (): ChannelBinding[] {
    if (!fs.existsSync(this.filePath)) return []

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<ChannelBinding>[]
      if (!Array.isArray(parsed)) return []
      return parsed.map(item => normalizeBinding(item))
    } catch {
      return []
    }
  }

  private writeAll (bindings: ChannelBinding[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(bindings, null, 2), 'utf-8')
  }

  list (): ChannelBinding[] {
    return this.readAll().sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).reverse()
  }

  get (id: string): ChannelBinding | null {
    return this.readAll().find(item => item.id === id) || null
  }

  save (value: Partial<ChannelBinding>): ChannelBinding {
    const bindings = this.readAll()
    const existing = value.id ? bindings.find(item => item.id === value.id) || null : null
    const normalized = normalizeBinding(value, existing)
    const nextBindings = existing
      ? bindings.map(item => item.id === normalized.id ? normalized : item)
      : [...bindings, normalized]
    this.writeAll(nextBindings)
    return normalized
  }

  delete (id: string): boolean {
    const bindings = this.readAll()
    const nextBindings = bindings.filter(item => item.id !== id)
    if (nextBindings.length === bindings.length) return false
    this.writeAll(nextBindings)
    return true
  }
}