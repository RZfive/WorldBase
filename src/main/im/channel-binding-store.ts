import fs from 'node:fs'
import path from 'node:path'
import type { ChannelBinding, ConnectorDefinition } from '../../shared/agent-workspace-types.js'

export const BUILTIN_CONNECTORS: ConnectorDefinition[] = [
  {
    id: 'feishu',
    name: 'Feishu',
    description: '飞书机器人事件回调，支持 URL 校验、加密事件、文本消息接收和消息回复。',
    supportsThreads: true,
    supportsMentions: true,
    supportsAttachments: true,
    incomingWebhookPath: '/api/im/webhook/feishu/:bindingId?',
    credentialFields: [
      { key: 'verificationToken', label: 'Verification Token', secret: true },
      { key: 'encryptKey', label: 'Encrypt Key / Sign Key', secret: true },
      { key: 'appId', label: 'App ID' },
      { key: 'appSecret', label: 'App Secret', secret: true }
    ]
  },
  {
    id: 'wechat',
    name: 'WeChat',
    description: '微信公众号/测试号回调，支持 URL 校验、明文/加密文本消息接收和被动文本回复。',
    supportsThreads: false,
    supportsMentions: false,
    supportsAttachments: false,
    incomingWebhookPath: '/api/im/webhook/wechat/:bindingId?',
    credentialFields: [
      { key: 'verificationToken', label: 'Token', secret: true },
      { key: 'encryptKey', label: 'EncodingAESKey', secret: true },
      { key: 'appId', label: 'App ID' }
    ]
  },
  {
    id: 'wecom',
    name: 'WeCom',
    description: '企业微信回调与群机器人 Webhook，支持文本消息接收和群机器人回复。',
    supportsThreads: false,
    supportsMentions: true,
    supportsAttachments: true,
    incomingWebhookPath: '/api/im/webhook/wecom/:bindingId?',
    credentialFields: [
      { key: 'verificationToken', label: 'Token', secret: true },
      { key: 'encryptKey', label: 'EncodingAESKey', secret: true },
      { key: 'appId', label: 'Corp ID' },
      { key: 'outgoingWebhookUrl', label: '群机器人 Webhook', secret: true, placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' }
    ]
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Slack Slash/Event 兼容入口，支持 URL 校验、签名校验、表单文本 payload 与 response_url 回复。',
    supportsThreads: true,
    supportsMentions: true,
    supportsAttachments: true,
    incomingWebhookPath: '/api/im/webhook/slack/:bindingId?',
    credentialFields: [
      { key: 'incomingSecret', label: 'Signing Secret', secret: true },
      { key: 'outgoingWebhookUrl', label: 'Incoming Webhook', secret: true }
    ]
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Discord Webhook 入口，当前支持通用文本 payload 与 Webhook 回复。',
    supportsThreads: true,
    supportsMentions: true,
    supportsAttachments: true,
    incomingWebhookPath: '/api/im/webhook/discord/:bindingId?',
    credentialFields: [
      { key: 'incomingSecret', label: 'Shared Secret', secret: true },
      { key: 'outgoingWebhookUrl', label: 'Webhook URL', secret: true }
    ]
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Telegram Bot Webhook，支持文本消息接收和 sendMessage 回复。',
    supportsThreads: false,
    supportsMentions: false,
    supportsAttachments: true,
    incomingWebhookPath: '/api/im/webhook/telegram/:bindingId?',
    credentialFields: [
      { key: 'incomingSecret', label: 'Webhook Secret Token', secret: true },
      { key: 'appSecret', label: 'Bot Token', secret: true }
    ]
  },
  {
    id: 'custom',
    name: 'Custom Webhook',
    description: '自定义 JSON Webhook，可作为内部 IM 网关或 OpenClaw 风格桥接入口。',
    supportsThreads: true,
    supportsMentions: true,
    supportsAttachments: true,
    incomingWebhookPath: '/api/im/webhook/custom/:bindingId?',
    credentialFields: [
      { key: 'incomingSecret', label: 'Shared Secret', secret: true },
      { key: 'outgoingWebhookUrl', label: 'Reply Webhook', secret: true }
    ]
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
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : existing?.name,
    externalChannelId: typeof value.externalChannelId === 'string' ? value.externalChannelId.trim() : (existing?.externalChannelId || ''),
    externalThreadId: typeof value.externalThreadId === 'string' && value.externalThreadId.trim() ? value.externalThreadId.trim() : existing?.externalThreadId,
    boundConversationId: typeof value.boundConversationId === 'string' && value.boundConversationId.trim() ? value.boundConversationId.trim() : existing?.boundConversationId,
    boundGroupId: typeof value.boundGroupId === 'string' && value.boundGroupId.trim() ? value.boundGroupId.trim() : existing?.boundGroupId,
    defaultAgentId: typeof value.defaultAgentId === 'string' && value.defaultAgentId.trim() ? value.defaultAgentId.trim() : existing?.defaultAgentId,
    targetProjectId: typeof value.targetProjectId === 'string' && value.targetProjectId.trim() ? value.targetProjectId.trim() : (value.targetProjectId === null ? null : existing?.targetProjectId),
    incomingSecret: typeof value.incomingSecret === 'string' && value.incomingSecret.trim() ? value.incomingSecret.trim() : existing?.incomingSecret,
    outgoingWebhookUrl: typeof value.outgoingWebhookUrl === 'string' && value.outgoingWebhookUrl.trim() ? value.outgoingWebhookUrl.trim() : existing?.outgoingWebhookUrl,
    appId: typeof value.appId === 'string' && value.appId.trim() ? value.appId.trim() : existing?.appId,
    appSecret: typeof value.appSecret === 'string' && value.appSecret.trim() ? value.appSecret.trim() : existing?.appSecret,
    verificationToken: typeof value.verificationToken === 'string' && value.verificationToken.trim() ? value.verificationToken.trim() : existing?.verificationToken,
    encryptKey: typeof value.encryptKey === 'string' && value.encryptKey.trim() ? value.encryptKey.trim() : existing?.encryptKey,
    botUserId: typeof value.botUserId === 'string' && value.botUserId.trim() ? value.botUserId.trim() : existing?.botUserId,
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

  findForEvent (connectorType: ChannelBinding['connectorType'], channelId: string, threadId?: string, bindingId?: string): ChannelBinding | null {
    const bindings = this.readAll()
      .filter(item => item.connectorType === connectorType)
      .filter(item => !bindingId || item.id === bindingId)

    return bindings.find(item => {
      if (item.externalChannelId !== channelId) return false
      if (threadId && item.externalThreadId && item.externalThreadId !== threadId) return false
      return true
    }) || bindings.find(item => !item.externalChannelId) || null
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
