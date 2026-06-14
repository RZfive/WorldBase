import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import type { ChannelBinding, ChannelEvent, ConnectorType } from '../../shared/agent-workspace-types.js'
import type { ChannelBindingStore } from './channel-binding-store.js'

type RawRequest = Request & { rawBody?: Buffer }

interface ParsedChannelEvent extends ChannelEvent {
  replyWebhookUrl?: string
  rawPayload?: unknown
}

interface ImGatewayConfig {
  bindingStore: ChannelBindingStore
  generateReply: (binding: ChannelBinding, event: ChannelEvent) => Promise<string | null>
}

const CONNECTOR_TYPES = new Set<ConnectorType>(['feishu', 'wechat', 'wecom', 'slack', 'discord', 'telegram', 'custom'])

function safeCompare (left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function getBodyObject (req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
    ? req.body as Record<string, unknown>
    : {}
}

function getRawBodyString (req: RawRequest): string {
  if (req.rawBody) return req.rawBody.toString('utf-8')
  if (typeof req.body === 'string') return req.body
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body)
  return ''
}

function getString (value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function getNestedString (value: unknown, keys: string[]): string {
  let current = value
  for (const key of keys) {
    if (!current || typeof current !== 'object') return ''
    current = (current as Record<string, unknown>)[key]
  }
  return getString(current)
}

function parseJsonObject (value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function asRecord (value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parseXmlTag (xml: string, tagName: string): string {
  const match = xml.match(new RegExp(`<${tagName}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tagName}>|<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'))
  return (match?.[1] || match?.[2] || '').trim()
}

function verifyWeComSignature (binding: ChannelBinding, timestamp: string, nonce: string, encrypted: string, signature: string): boolean {
  if (!binding.verificationToken || !signature) return true
  const expected = [binding.verificationToken, timestamp, nonce, encrypted]
    .sort()
    .join('')
  const digest = createHash('sha1').update(expected).digest('hex')
  return safeCompare(digest, signature)
}

function verifyWeChatPlainSignature (binding: ChannelBinding, timestamp: string, nonce: string, signature: string): boolean {
  if (!binding.verificationToken || !signature) return true
  const digest = createHash('sha1')
    .update([binding.verificationToken, timestamp, nonce].sort().join(''))
    .digest('hex')
  return safeCompare(digest, signature)
}

function escapeXml (value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildWeChatTextReply (event: ChannelEvent, text: string): string {
  return [
    '<xml>',
    `<ToUserName><![CDATA[${event.senderId}]]></ToUserName>`,
    `<FromUserName><![CDATA[${event.channelId}]]></FromUserName>`,
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content>${escapeXml(text)}</Content>`,
    '</xml>'
  ].join('')
}

function getWeChatAesKey (binding: ChannelBinding): Buffer {
  if (!binding.encryptKey) {
    throw new Error('缺少 EncodingAESKey')
  }
  const normalizedKey = binding.encryptKey.length === 43
    ? `${binding.encryptKey}=`
    : binding.encryptKey
  const aesKey = Buffer.from(normalizedKey, 'base64')
  if (aesKey.length !== 32) {
    throw new Error('EncodingAESKey 无效')
  }
  return aesKey
}

function pkcs7Pad (buffer: Buffer, blockSize = 32): Buffer {
  const remainder = buffer.length % blockSize
  const pad = remainder === 0 ? blockSize : blockSize - remainder
  const padding = Buffer.alloc(pad, pad)
  return Buffer.concat([buffer, padding])
}

function encryptWeChatPayload (binding: ChannelBinding, xml: string): string {
  const aesKey = getWeChatAesKey(binding)
  const receiveId = binding.appId || ''
  const message = Buffer.from(xml, 'utf-8')
  const lengthBuffer = Buffer.alloc(4)
  lengthBuffer.writeUInt32BE(message.length, 0)
  const plain = pkcs7Pad(Buffer.concat([
    randomBytes(16),
    lengthBuffer,
    message,
    Buffer.from(receiveId, 'utf-8')
  ]))
  const cipher = createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}

function buildEncryptedWeChatReply (binding: ChannelBinding, event: ChannelEvent, text: string, nonce?: string): string {
  if (!binding.verificationToken) {
    throw new Error('加密回包需要配置 Token')
  }
  const encrypted = encryptWeChatPayload(binding, buildWeChatTextReply(event, text))
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const replyNonce = nonce || randomBytes(8).toString('hex')
  const signature = createHash('sha1')
    .update([binding.verificationToken, timestamp, replyNonce, encrypted].sort().join(''))
    .digest('hex')

  return [
    '<xml>',
    `<Encrypt><![CDATA[${encrypted}]]></Encrypt>`,
    `<MsgSignature><![CDATA[${signature}]]></MsgSignature>`,
    `<TimeStamp>${timestamp}</TimeStamp>`,
    `<Nonce><![CDATA[${replyNonce}]]></Nonce>`,
    '</xml>'
  ].join('')
}

function decryptWeComPayload (binding: ChannelBinding, encrypted: string): string {
  if (!binding.encryptKey) return encrypted
  const aesKey = getWeChatAesKey(binding)

  const decipher = createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16))
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final()
  ])
  const pad = decrypted[decrypted.length - 1]
  const unpadded = decrypted.subarray(0, decrypted.length - pad)
  const messageLength = unpadded.readUInt32BE(16)
  return unpadded.subarray(20, 20 + messageLength).toString('utf-8')
}

function decryptFeishuPayload (binding: ChannelBinding, encrypted: string): Record<string, unknown> {
  if (!binding.encryptKey) {
    throw new Error('飞书加密回调需要配置 Encrypt Key')
  }
  const aesKey = createHash('sha256').update(binding.encryptKey).digest()
  const decipher = createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final()
  ]).toString('utf-8')
  return parseJsonObject(decrypted)
}

function verifyFeishuSignature (req: RawRequest, binding: ChannelBinding): boolean {
  if (!binding.encryptKey) return true
  const timestamp = req.header('x-lark-request-timestamp') || req.header('x-feishu-request-timestamp') || ''
  const nonce = req.header('x-lark-request-nonce') || req.header('x-feishu-request-nonce') || ''
  const signature = req.header('x-lark-signature') || req.header('x-feishu-signature') || ''
  if (!timestamp || !nonce || !signature) return false
  const rawBody = getRawBodyString(req)
  const signatureBase = `${timestamp}${nonce}${binding.encryptKey}${rawBody}`
  const candidates = [
    createHash('sha256').update(signatureBase).digest('hex'),
    createHash('sha256').update(signatureBase).digest('base64'),
    createHmac('sha256', `${timestamp}${nonce}${binding.encryptKey}`).update(rawBody).digest('base64'),
    createHmac('sha256', binding.encryptKey).update(`${timestamp}${nonce}${rawBody}`).digest('hex'),
    createHmac('sha256', binding.encryptKey).update(`${timestamp}${nonce}${rawBody}`).digest('base64')
  ]
  return candidates.some(candidate => safeCompare(candidate, signature))
}

function verifySlackSignature (req: RawRequest, binding: ChannelBinding): boolean {
  if (!binding.incomingSecret) return true
  const timestamp = req.header('x-slack-request-timestamp') || ''
  const signature = req.header('x-slack-signature') || ''
  if (!timestamp || !signature) return false
  const digest = `v0=${createHmac('sha256', binding.incomingSecret)
    .update(`v0:${timestamp}:${getRawBodyString(req)}`)
    .digest('hex')}`
  return safeCompare(digest, signature)
}

function hasSharedSecret (req: Request, binding: ChannelBinding, body: Record<string, unknown>): boolean {
  if (!binding.incomingSecret) return true
  const provided = getString(req.header('x-the-world-im-secret'))
    || getString(req.header('x-im-secret'))
    || getString(req.query.secret)
    || getString(body.secret)
  return Boolean(provided) && safeCompare(provided, binding.incomingSecret)
}

export class ImGatewayService {
  constructor (private readonly config: ImGatewayConfig) {}

  router (): Router {
    const router = Router()
    router.get('/webhook/:connectorType/:bindingId?', async (req, res) => {
      await this.handleWebhook(req, res)
    })
    router.post('/webhook/:connectorType/:bindingId?', async (req, res) => {
      await this.handleWebhook(req, res)
    })
    router.post('/openclaw/:bindingId?', async (req, res) => {
      const params = req.params as Record<string, string>
      params.connectorType = 'custom'
      await this.handleWebhook(req, res)
    })
    router.get('/health', (_req, res) => {
      res.json({ ok: true, service: 'im-gateway' })
    })
    return router
  }

  private resolveBinding (connectorType: ConnectorType, event: Pick<ChannelEvent, 'channelId' | 'threadId'>, bindingId?: string): ChannelBinding | null {
    if (bindingId) {
      const binding = this.config.bindingStore.get(bindingId)
      return binding?.connectorType === connectorType ? binding : null
    }
    return this.config.bindingStore.findForEvent(connectorType, event.channelId, event.threadId)
  }

  private resolveRouteBinding (connectorType: ConnectorType, bindingId?: string): ChannelBinding | null {
    if (!bindingId) return null
    const binding = this.config.bindingStore.get(bindingId)
    return binding?.connectorType === connectorType ? binding : null
  }

  private async handleWebhook (req: RawRequest, res: Response): Promise<void> {
    const connectorType = String(req.params.connectorType || '') as ConnectorType
    const bindingId = typeof req.params.bindingId === 'string' ? req.params.bindingId : undefined
    if (!CONNECTOR_TYPES.has(connectorType)) {
      res.status(404).json({ error: 'Unknown IM connector' })
      return
    }

    try {
      if ((connectorType === 'wecom' || connectorType === 'wechat') && req.method === 'GET') {
        if (connectorType === 'wechat') {
          await this.handleWeChatVerify(req, res, bindingId)
          return
        }
        await this.handleWeComVerify(req, res, bindingId)
        return
      }

      const verification = this.tryHandleUrlVerification(connectorType, req, bindingId)
      if (verification.handled) {
        res.json(verification.body)
        return
      }

      const parsed = await this.parseEvent(connectorType, req)
      if (!parsed) {
        res.json({ ok: true, ignored: true })
        return
      }

      const binding = this.resolveBinding(connectorType, parsed, bindingId)
      if (!binding) {
        res.status(404).json({ error: 'No matching IM binding' })
        return
      }
      if (binding.botUserId && parsed.senderId === binding.botUserId) {
        res.json({ ok: true, ignored: true, reason: 'bot-self-message' })
        return
      }
      if (!this.verifyConnectorRequest(connectorType, req, binding, parsed.rawPayload)) {
        res.status(401).json({ error: 'Invalid IM webhook signature or secret' })
        return
      }
      if (!binding.autoReply) {
        if (connectorType === 'wechat' || connectorType === 'wecom') {
          res.type('text/plain').send('success')
          return
        }
        res.json({ ok: true, accepted: true, autoReply: false })
        return
      }

      const reply = await this.config.generateReply(binding, parsed)
      if (!reply) {
        if (connectorType === 'wechat' || connectorType === 'wecom') {
          res.type('text/plain').send('success')
          return
        }
        res.json({ ok: true, accepted: true, reply: null })
        return
      }
      if ((connectorType === 'wechat' || connectorType === 'wecom') && !binding.outgoingWebhookUrl) {
        const xmlReply = binding.encryptKey
          ? buildEncryptedWeChatReply(binding, parsed, reply, getString(req.query.nonce))
          : buildWeChatTextReply(parsed, reply)
        res.type('application/xml').send(xmlReply)
        return
      }
      const delivered = await this.deliverReply(connectorType, binding, parsed, reply)
      if (connectorType === 'wechat') {
        res.type('text/plain').send('success')
        return
      }
      res.json({ ok: true, accepted: true, delivered, reply })
    } catch (error) {
      res.status(500).json({ error: (error as Error).message })
    }
  }

  private tryHandleUrlVerification (connectorType: ConnectorType, req: RawRequest, bindingId?: string): { handled: boolean; body?: Record<string, unknown> } {
    let body = getBodyObject(req)

    if (connectorType === 'slack') {
      if (body.type !== 'url_verification') return { handled: false }
      const binding = this.resolveRouteBinding('slack', bindingId)
      if (binding?.incomingSecret && !verifySlackSignature(req, binding)) {
        throw new Error('Slack 签名校验失败')
      }
      return { handled: true, body: { challenge: body.challenge || '' } }
    }

    if (connectorType !== 'feishu') return { handled: false }
    const binding = this.resolveRouteBinding('feishu', bindingId)
    if (body.encrypt) {
      if (!binding) {
        throw new Error('飞书加密 URL 校验需要在回调地址中包含 bindingId')
      }
      if (!verifyFeishuSignature(req, binding)) {
        throw new Error('飞书签名校验失败')
      }
      body = decryptFeishuPayload(binding, getString(body.encrypt))
    }
    if (body.type !== 'url_verification') return { handled: false }

    const token = getString(body.token)
    if (binding?.verificationToken && !safeCompare(binding.verificationToken, token)) {
      throw new Error('飞书 Verification Token 不匹配')
    }
    return { handled: true, body: { challenge: body.challenge || '' } }
  }

  private async handleWeComVerify (req: RawRequest, res: Response, bindingId?: string): Promise<void> {
    const binding = bindingId ? this.config.bindingStore.get(bindingId) : null
    if (!binding || binding.connectorType !== 'wecom') {
      res.status(404).send('missing binding')
      return
    }
    const encrypted = getString(req.query.echostr)
    const timestamp = getString(req.query.timestamp)
    const nonce = getString(req.query.nonce)
    const signature = getString(req.query.msg_signature)
    if (!verifyWeComSignature(binding, timestamp, nonce, encrypted, signature)) {
      res.status(401).send('invalid signature')
      return
    }
    res.type('text/plain').send(decryptWeComPayload(binding, encrypted))
  }

  private async handleWeChatVerify (req: RawRequest, res: Response, bindingId?: string): Promise<void> {
    const binding = bindingId ? this.config.bindingStore.get(bindingId) : null
    if (!binding || binding.connectorType !== 'wechat') {
      res.status(404).send('missing binding')
      return
    }

    const echostr = getString(req.query.echostr)
    const timestamp = getString(req.query.timestamp)
    const nonce = getString(req.query.nonce)
    const signature = getString(req.query.signature)
    const msgSignature = getString(req.query.msg_signature)
    if (msgSignature) {
      if (!verifyWeComSignature(binding, timestamp, nonce, echostr, msgSignature)) {
        res.status(401).send('invalid signature')
        return
      }
      res.type('text/plain').send(decryptWeComPayload(binding, echostr))
      return
    }
    if (!verifyWeChatPlainSignature(binding, timestamp, nonce, signature)) {
      res.status(401).send('invalid signature')
      return
    }
    res.type('text/plain').send(echostr)
  }

  private async parseEvent (connectorType: ConnectorType, req: RawRequest): Promise<ParsedChannelEvent | null> {
    if (connectorType === 'feishu') return this.parseFeishuEvent(req)
    if (connectorType === 'wechat') return this.parseWeChatEvent(req)
    if (connectorType === 'wecom') return this.parseWeComEvent(req)
    if (connectorType === 'telegram') return this.parseTelegramEvent(req)
    if (connectorType === 'slack') return this.parseSlackEvent(req)
    return this.parseGenericEvent(connectorType, req)
  }

  private parseFeishuEvent (req: RawRequest): ParsedChannelEvent | null {
    let body = getBodyObject(req)
    const encrypted = getString(body.encrypt)
    if (encrypted) {
      const bindingId = typeof req.params.bindingId === 'string' ? req.params.bindingId : undefined
      const binding = this.resolveRouteBinding('feishu', bindingId)
      if (!binding) {
        throw new Error('飞书加密事件需要在回调地址中包含 bindingId')
      }
      if (!verifyFeishuSignature(req, binding)) {
        throw new Error('飞书签名校验失败')
      }
      body = decryptFeishuPayload(binding, encrypted)
    }

    const event = asRecord(body.event)
    const message = asRecord(event.message)
    const content = parseJsonObject(getString(message.content))
    const text = getString(content.text)
      || getString(message.content)
      || getString(event.text_without_at_bot)
      || getString(event.text)
    if (!text) return null
    const createdAtRaw = Number(message.create_time || event.create_time || Date.now())
    const createdAtMs = Number.isFinite(createdAtRaw) && createdAtRaw > 0 && createdAtRaw < 1000000000000
      ? createdAtRaw * 1000
      : createdAtRaw

    return {
      connectorType: 'feishu',
      channelId: getString(message.chat_id) || getString(message.open_chat_id) || getString(event.open_chat_id) || getString(event.chat_id),
      threadId: getString(message.thread_id) || undefined,
      messageId: getString(message.message_id) || getString(event.message_id) || getNestedString(body, ['header', 'event_id']) || `feishu_${Date.now()}`,
      senderId: getNestedString(event, ['sender', 'sender_id', 'open_id'])
        || getNestedString(event, ['sender', 'sender_id', 'user_id'])
        || getString(event.open_id)
        || 'feishu-user',
      senderName: getNestedString(event, ['sender', 'sender_type']) || getString(event.user_name) || undefined,
      text,
      mentions: Array.isArray(message.mentions)
        ? message.mentions.map(item => getNestedString(item, ['name']) || getNestedString(item, ['id', 'open_id'])).filter(Boolean)
        : [],
      createdAt: new Date(createdAtMs).toISOString(),
      rawPayload: body
    }
  }

  private parseWeComEvent (req: RawRequest): ParsedChannelEvent | null {
    const contentType = req.header('content-type') || ''
    if (contentType.includes('json')) {
      return this.parseGenericEvent('wecom', req)
    }

    const rawXml = getRawBodyString(req)
    const encrypted = parseXmlTag(rawXml, 'Encrypt')
    const timestamp = getString(req.query.timestamp)
    const nonce = getString(req.query.nonce)
    const signature = getString(req.query.msg_signature)
    const bindingId = typeof req.params.bindingId === 'string' ? req.params.bindingId : undefined
    const binding = bindingId ? this.config.bindingStore.get(bindingId) : null
    if (binding && encrypted && !verifyWeComSignature(binding, timestamp, nonce, encrypted, signature)) {
      throw new Error('企业微信签名校验失败')
    }
    const xml = binding && encrypted ? decryptWeComPayload(binding, encrypted) : rawXml
    const text = parseXmlTag(xml, 'Content')
    if (!text) return null
    const createdAtSeconds = Number(parseXmlTag(xml, 'CreateTime'))

    return {
      connectorType: 'wecom',
      channelId: parseXmlTag(xml, 'ToUserName') || 'wecom',
      messageId: parseXmlTag(xml, 'MsgId') || `wecom_${Date.now()}`,
      senderId: parseXmlTag(xml, 'FromUserName') || 'wecom-user',
      text,
      createdAt: Number.isFinite(createdAtSeconds) && createdAtSeconds > 0
        ? new Date(createdAtSeconds * 1000).toISOString()
        : new Date().toISOString(),
      rawPayload: xml
    }
  }

  private parseWeChatEvent (req: RawRequest): ParsedChannelEvent | null {
    const rawXml = getRawBodyString(req)
    const encrypted = parseXmlTag(rawXml, 'Encrypt')
    const timestamp = getString(req.query.timestamp)
    const nonce = getString(req.query.nonce)
    const signature = getString(req.query.signature)
    const msgSignature = getString(req.query.msg_signature)
    const bindingId = typeof req.params.bindingId === 'string' ? req.params.bindingId : undefined
    const binding = bindingId ? this.config.bindingStore.get(bindingId) : null
    if (binding && encrypted && !verifyWeComSignature(binding, timestamp, nonce, encrypted, msgSignature)) {
      throw new Error('微信签名校验失败')
    }
    if (binding && !encrypted && !verifyWeChatPlainSignature(binding, timestamp, nonce, signature)) {
      throw new Error('微信签名校验失败')
    }
    const xml = binding && encrypted ? decryptWeComPayload(binding, encrypted) : rawXml
    const text = parseXmlTag(xml, 'Content')
    if (!text) return null
    const createdAtSeconds = Number(parseXmlTag(xml, 'CreateTime'))

    return {
      connectorType: 'wechat',
      channelId: parseXmlTag(xml, 'ToUserName') || 'wechat',
      messageId: parseXmlTag(xml, 'MsgId') || `wechat_${Date.now()}`,
      senderId: parseXmlTag(xml, 'FromUserName') || 'wechat-user',
      text,
      createdAt: Number.isFinite(createdAtSeconds) && createdAtSeconds > 0
        ? new Date(createdAtSeconds * 1000).toISOString()
        : new Date().toISOString(),
      rawPayload: xml
    }
  }

  private parseTelegramEvent (req: RawRequest): ParsedChannelEvent | null {
    const body = getBodyObject(req)
    const message = body.message && typeof body.message === 'object'
      ? body.message as Record<string, unknown>
      : body.edited_message && typeof body.edited_message === 'object'
        ? body.edited_message as Record<string, unknown>
        : {}
    const text = getString(message.text)
    if (!text) return null
    const chatId = getNestedString(message, ['chat', 'id'])
    const senderId = getNestedString(message, ['from', 'id'])
    const senderName = [getNestedString(message, ['from', 'first_name']), getNestedString(message, ['from', 'last_name'])]
      .filter(Boolean)
      .join(' ')
    const createdAtSeconds = Number(message.date)
    return {
      connectorType: 'telegram',
      channelId: chatId,
      messageId: getString(message.message_id) || `telegram_${Date.now()}`,
      senderId: senderId || 'telegram-user',
      senderName: senderName || undefined,
      text,
      createdAt: Number.isFinite(createdAtSeconds) && createdAtSeconds > 0
        ? new Date(createdAtSeconds * 1000).toISOString()
        : new Date().toISOString(),
      rawPayload: body
    }
  }

  private parseSlackEvent (req: RawRequest): ParsedChannelEvent | null {
    const body = getBodyObject(req)
    const payload = typeof body.payload === 'string'
      ? parseJsonObject(getString(body.payload))
      : asRecord(body.payload)
    const source = Object.keys(payload).length > 0 ? payload : body
    const event = asRecord(source.event)
    const message = asRecord(source.message)
    const channel = asRecord(source.channel)
    const user = asRecord(source.user)
    const text = getString(source.text)
      || getString(event.text)
      || getString(message.text)
      || getNestedString(source, ['actions', '0', 'value'])
    if (!text) return null
    const eventTs = getString(event.ts) || getString(message.ts) || getString(source.event_time)
    const createdAtSeconds = Number(eventTs || source.event_time)

    return {
      connectorType: 'slack',
      channelId: getString(source.channel_id)
        || getString(channel.id)
        || getString(event.channel)
        || getString(message.channel)
        || 'slack',
      threadId: getString(source.thread_ts)
        || getString(event.thread_ts)
        || getString(message.thread_ts)
        || undefined,
      messageId: getString(source.message_id)
        || getString(source.event_id)
        || getString(event.client_msg_id)
        || getString(event.ts)
        || getString(message.ts)
        || getString(source.trigger_id)
        || `slack_${Date.now()}`,
      senderId: getString(source.user_id)
        || getString(user.id)
        || getString(event.user)
        || getString(message.user)
        || 'slack-user',
      senderName: getString(source.user_name) || getString(user.name) || undefined,
      text,
      replyWebhookUrl: getString(source.response_url) || undefined,
      createdAt: Number.isFinite(createdAtSeconds) && createdAtSeconds > 0
        ? new Date(createdAtSeconds * 1000).toISOString()
        : new Date().toISOString(),
      rawPayload: source
    }
  }

  private parseGenericEvent (connectorType: ConnectorType, req: RawRequest): ParsedChannelEvent | null {
    const body = getBodyObject(req)
    const text = getString(body.text)
      || getString(body.content)
      || getString(body.message)
      || getNestedString(body, ['message', 'text'])
      || getNestedString(body, ['event', 'text'])
      || getNestedString(body, ['event', 'message', 'text'])
      || getNestedString(body, ['payload', 'text'])
    if (!text) return null
    return {
      connectorType,
      channelId: getString(body.channelId)
        || getString(body.channel_id)
        || getString(body.chat_id)
        || getString(body.conversation_id)
        || getString(body.room_id)
        || getNestedString(body, ['channel', 'id'])
        || getNestedString(body, ['event', 'channel'])
        || 'default',
      threadId: getString(body.threadId) || getString(body.thread_id) || getString(body.topic_id) || getNestedString(body, ['event', 'thread_ts']) || undefined,
      messageId: getString(body.messageId)
        || getString(body.message_id)
        || getNestedString(body, ['message', 'id'])
        || getNestedString(body, ['event', 'client_msg_id'])
        || getNestedString(body, ['event', 'ts'])
        || `${connectorType}_${Date.now()}`,
      senderId: getString(body.senderId)
        || getString(body.user_id)
        || getString(body.sender_id)
        || getNestedString(body, ['sender', 'id'])
        || getNestedString(body, ['user', 'id'])
        || getNestedString(body, ['event', 'user'])
        || 'external-user',
      senderName: getString(body.senderName)
        || getString(body.user_name)
        || getString(body.sender_name)
        || getNestedString(body, ['sender', 'name'])
        || getNestedString(body, ['user', 'name'])
        || undefined,
      text,
      replyWebhookUrl: getString(body.response_url) || undefined,
      createdAt: new Date().toISOString(),
      rawPayload: body
    }
  }

  private verifyConnectorRequest (connectorType: ConnectorType, req: RawRequest, binding: ChannelBinding, rawPayload?: unknown): boolean {
    const body = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
      ? rawPayload as Record<string, unknown>
      : getBodyObject(req)
    if (connectorType === 'feishu') {
      if (binding.verificationToken && getString(body.token) && !safeCompare(binding.verificationToken, getString(body.token))) return false
      return verifyFeishuSignature(req, binding)
    }
    if (connectorType === 'wechat') {
      const rawXml = getRawBodyString(req)
      const encrypted = parseXmlTag(rawXml, 'Encrypt')
      const timestamp = getString(req.query.timestamp)
      const nonce = getString(req.query.nonce)
      return encrypted
        ? verifyWeComSignature(binding, timestamp, nonce, encrypted, getString(req.query.msg_signature))
        : verifyWeChatPlainSignature(binding, timestamp, nonce, getString(req.query.signature))
    }
    if (connectorType === 'wecom') {
      const encrypted = parseXmlTag(getRawBodyString(req), 'Encrypt')
      if (!encrypted) return true
      return verifyWeComSignature(binding, getString(req.query.timestamp), getString(req.query.nonce), encrypted, getString(req.query.msg_signature))
    }
    if (connectorType === 'slack' && binding.incomingSecret && req.header('x-slack-signature')) {
      return verifySlackSignature(req, binding)
    }
    if (connectorType === 'telegram' && binding.incomingSecret) {
      return safeCompare(binding.incomingSecret, getString(req.header('x-telegram-bot-api-secret-token')))
    }
    return hasSharedSecret(req, binding, body)
  }

  private async deliverReply (connectorType: ConnectorType, binding: ChannelBinding, event: ParsedChannelEvent, reply: string): Promise<boolean> {
    if (connectorType === 'feishu' && binding.appId && binding.appSecret && event.messageId) {
      return this.replyToFeishuMessage(binding, event.messageId, reply)
    }
    if (connectorType === 'telegram' && binding.appSecret && event.channelId) {
      return this.sendTelegramMessage(binding, event.channelId, reply)
    }
    const webhookUrl = event.replyWebhookUrl || binding.outgoingWebhookUrl
    if (!webhookUrl) return false

    const payload = connectorType === 'wecom'
      ? { msgtype: 'text', text: { content: reply } }
      : connectorType === 'slack'
        ? { text: reply }
      : connectorType === 'discord'
        ? { content: reply }
        : { text: reply, reply, channelId: event.channelId, threadId: event.threadId, bindingId: binding.id }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return response.ok
  }

  private async replyToFeishuMessage (binding: ChannelBinding, messageId: string, reply: string): Promise<boolean> {
    const tokenResponse = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: binding.appId, app_secret: binding.appSecret })
    })
    const tokenPayload = await tokenResponse.json() as { tenant_access_token?: string }
    if (!tokenResponse.ok || !tokenPayload.tenant_access_token) return false

    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenPayload.tenant_access_token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        msg_type: 'text',
        content: JSON.stringify({ text: reply })
      })
    })
    return response.ok
  }

  private async sendTelegramMessage (binding: ChannelBinding, chatId: string, reply: string): Promise<boolean> {
    const response = await fetch(`https://api.telegram.org/bot${binding.appSecret}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply })
    })
    return response.ok
  }
}
