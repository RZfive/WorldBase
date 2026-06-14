import express from 'express'
import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

function assert (condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function signWeChat (token, timestamp, nonce) {
  return createHash('sha1')
    .update([token, timestamp, nonce].sort().join(''))
    .digest('hex')
}

function signWeChatEncrypted (token, timestamp, nonce, encrypted) {
  return createHash('sha1')
    .update([token, timestamp, nonce, encrypted].sort().join(''))
    .digest('hex')
}

function getWeChatAesKey (encodingAesKey) {
  const normalized = encodingAesKey.length === 43 ? `${encodingAesKey}=` : encodingAesKey
  const key = Buffer.from(normalized, 'base64')
  assert(key.length === 32, 'test EncodingAESKey should decode to 32 bytes')
  return key
}

function pkcs7Pad (buffer, blockSize = 32) {
  const remainder = buffer.length % blockSize
  const pad = remainder === 0 ? blockSize : blockSize - remainder
  return Buffer.concat([buffer, Buffer.alloc(pad, pad)])
}

function encryptWeChatPayload (encodingAesKey, receiveId, text) {
  const aesKey = getWeChatAesKey(encodingAesKey)
  const message = Buffer.from(text, 'utf-8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(message.length, 0)
  const plain = pkcs7Pad(Buffer.concat([
    Buffer.alloc(16, 7),
    length,
    message,
    Buffer.from(receiveId, 'utf-8')
  ]))
  const cipher = createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}

function decryptWeChatPayload (encodingAesKey, encrypted) {
  const aesKey = getWeChatAesKey(encodingAesKey)
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

function encryptFeishuBody (encryptKey, payload) {
  const aesKey = createHash('sha256').update(encryptKey).digest()
  const cipher = createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16))
  return Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf-8'),
    cipher.final()
  ]).toString('base64')
}

function signFeishu (encryptKey, timestamp, nonce, rawBody) {
  return createHash('sha256')
    .update(`${timestamp}${nonce}${encryptKey}${rawBody}`)
    .digest('hex')
}

function signSlack (secret, timestamp, rawBody) {
  return `v0=${createHmac('sha256', secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')}`
}

function parseXmlTag (xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tagName}>|<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'))
  return (match?.[1] || match?.[2] || '').trim()
}

function makeBinding (overrides) {
  const now = new Date().toISOString()
  return {
    id: 'binding_custom',
    connectorType: 'custom',
    externalChannelId: 'room-1',
    autoReply: true,
    requireApprovalForRiskyTools: true,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

function makeStore (bindings) {
  const entries = new Map(bindings.map(binding => [binding.id, binding]))
  return {
    get: id => entries.get(id) || null,
    findForEvent: (connectorType, channelId, threadId, bindingId) => {
      const candidates = [...entries.values()]
        .filter(binding => binding.connectorType === connectorType)
        .filter(binding => !bindingId || binding.id === bindingId)
      return candidates.find(binding => {
        if (binding.externalChannelId && binding.externalChannelId !== channelId) return false
        if (threadId && binding.externalThreadId && binding.externalThreadId !== threadId) return false
        return true
      }) || candidates.find(binding => !binding.externalChannelId) || null
    }
  }
}

async function requestJson (baseUrl, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  const payload = await response.json()
  return { response, payload }
}

async function requestRaw (baseUrl, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  return { response, payload, text }
}

async function main () {
  const tempRoot = path.resolve('.tmp')
  await mkdir(tempRoot, { recursive: true })
  const tempDir = await mkdtemp(path.join(tempRoot, 'im-gateway-'))
  const bundlePath = path.join(tempDir, 'im-gateway-service.cjs')
  const originalFetch = globalThis.fetch.bind(globalThis)
  const externalCalls = []
  const webhookCaptures = []
  let server

  try {
    await build({
      entryPoints: ['src/main/im/im-gateway-service.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: ['node22'],
      external: ['express'],
      outfile: bundlePath,
      logLevel: 'silent'
    })
    const { ImGatewayService } = require(bundlePath)
    const token = 'wechat-token'
    const encodingAesKey = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64').replace(/=+$/, '')
    const feishuEncryptKey = 'feishu-encrypt-key'
    const slackSigningSecret = 'slack-signing-secret'
    const bindings = [
      makeBinding({ id: 'binding_custom', connectorType: 'custom', externalChannelId: 'room-1', incomingSecret: 'secret' }),
      makeBinding({ id: 'binding_feishu', connectorType: 'feishu', externalChannelId: 'oc_chat', verificationToken: 'verify-token', encryptKey: feishuEncryptKey, appId: 'cli_a', appSecret: 'feishu-secret' }),
      makeBinding({ id: 'binding_wechat', connectorType: 'wechat', externalChannelId: 'gh_app', verificationToken: token }),
      makeBinding({ id: 'binding_wechat_encrypted', connectorType: 'wechat', externalChannelId: 'gh_encrypt', verificationToken: token, encryptKey: encodingAesKey, appId: 'gh_encrypt' }),
      makeBinding({ id: 'binding_wecom', connectorType: 'wecom', externalChannelId: 'corp_id', verificationToken: token, encryptKey: encodingAesKey, appId: 'corp_id' }),
      makeBinding({ id: 'binding_slack', connectorType: 'slack', externalChannelId: 'C123', incomingSecret: slackSigningSecret }),
      makeBinding({ id: 'binding_telegram', connectorType: 'telegram', externalChannelId: 'TG123', incomingSecret: 'telegram-secret', appSecret: 'telegram-token' }),
      makeBinding({ id: 'binding_discord', connectorType: 'discord', externalChannelId: 'D123', incomingSecret: 'discord-secret' })
    ]
    globalThis.fetch = async (url, options) => {
      const target = String(url)
      if (target === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal') {
        externalCalls.push({ target, body: options?.body ? JSON.parse(String(options.body)) : null })
        return new Response(JSON.stringify({ tenant_access_token: 'tenant-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (target.includes('https://open.feishu.cn/open-apis/im/v1/messages/') && target.endsWith('/reply')) {
        externalCalls.push({ target, body: options?.body ? JSON.parse(String(options.body)) : null })
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (target === 'https://api.telegram.org/bottelegram-token/sendMessage') {
        externalCalls.push({ target, body: options?.body ? JSON.parse(String(options.body)) : null })
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return originalFetch(url, options)
    }
    const service = new ImGatewayService({
      bindingStore: makeStore(bindings),
      generateReply: async (_binding, event) => `echo:${event.text}`
    })
    const app = express()
    const captureRawBody = (req, _res, buf) => {
      if (buf.length > 0) req.rawBody = Buffer.from(buf)
    }
    app.use(express.json({ verify: captureRawBody }))
    app.use(express.urlencoded({ extended: true, verify: captureRawBody }))
    app.use(express.text({ type: ['application/xml', 'text/xml', 'text/plain'], verify: captureRawBody }))
    app.post('/capture/:name', (req, res) => {
      webhookCaptures.push({ name: req.params.name, body: req.body })
      res.json({ ok: true })
    })
    app.use('/api/im', service.router())

    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    const discordBinding = bindings.find(binding => binding.id === 'binding_discord')
    discordBinding.outgoingWebhookUrl = `${baseUrl}/capture/discord`

    const custom = await requestJson(
      baseUrl,
      '/api/im/webhook/custom/binding_custom',
      { channelId: 'room-1', senderId: 'user-1', text: 'hello custom' },
      { 'x-the-world-im-secret': 'secret' }
    )
    assert(custom.response.ok, 'custom webhook should return 2xx')
    assert(custom.payload.reply === 'echo:hello custom', 'custom webhook should return generated reply')

    const openclaw = await requestJson(
      baseUrl,
      '/api/im/openclaw/binding_custom',
      { chat_id: 'room-1', user_id: 'user-2', message: { text: 'hello openclaw' }, secret: 'secret' }
    )
    assert(openclaw.response.ok, 'openclaw webhook should return 2xx')
    assert(openclaw.payload.reply === 'echo:hello openclaw', 'openclaw payload should map nested message text')

    const feishu = await requestJson(
      baseUrl,
      '/api/im/webhook/feishu/binding_feishu',
      { type: 'url_verification', token: 'verify-token', challenge: 'ok-feishu' }
    )
    assert(feishu.response.ok, 'feishu url verification should return 2xx')
    assert(feishu.payload.challenge === 'ok-feishu', 'feishu url verification should echo challenge')

    const feishuEncryptedVerifyPayload = {
      type: 'url_verification',
      token: 'verify-token',
      challenge: 'ok-feishu-encrypted'
    }
    const feishuEncryptedVerifyBody = JSON.stringify({
      encrypt: encryptFeishuBody(feishuEncryptKey, feishuEncryptedVerifyPayload)
    })
    const feishuVerifyTimestamp = '1700000001'
    const feishuVerifyNonce = 'feishu-nonce-verify'
    const feishuEncryptedVerify = await requestRaw(
      baseUrl,
      '/api/im/webhook/feishu/binding_feishu',
      feishuEncryptedVerifyBody,
      {
        'content-type': 'application/json',
        'x-lark-request-timestamp': feishuVerifyTimestamp,
        'x-lark-request-nonce': feishuVerifyNonce,
        'x-lark-signature': signFeishu(feishuEncryptKey, feishuVerifyTimestamp, feishuVerifyNonce, feishuEncryptedVerifyBody)
      }
    )
    assert(feishuEncryptedVerify.response.ok, 'encrypted feishu url verification should return 2xx')
    assert(feishuEncryptedVerify.payload.challenge === 'ok-feishu-encrypted', 'encrypted feishu url verification should echo challenge')

    const feishuEncryptedEventPayload = {
      schema: '2.0',
      header: { event_id: 'evt_feishu_encrypted' },
      event: {
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
        message: {
          message_id: 'om_encrypted',
          chat_id: 'oc_chat',
          thread_id: 'omt_thread',
          create_time: '1700000000000',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello encrypted feishu' })
        }
      }
    }
    const feishuEncryptedEventBody = JSON.stringify({
      encrypt: encryptFeishuBody(feishuEncryptKey, feishuEncryptedEventPayload)
    })
    const feishuEventTimestamp = '1700000002'
    const feishuEventNonce = 'feishu-nonce-event'
    const feishuEncryptedEvent = await requestRaw(
      baseUrl,
      '/api/im/webhook/feishu/binding_feishu',
      feishuEncryptedEventBody,
      {
        'content-type': 'application/json',
        'x-lark-request-timestamp': feishuEventTimestamp,
        'x-lark-request-nonce': feishuEventNonce,
        'x-lark-signature': signFeishu(feishuEncryptKey, feishuEventTimestamp, feishuEventNonce, feishuEncryptedEventBody)
      }
    )
    assert(feishuEncryptedEvent.response.ok, 'encrypted feishu message should return 2xx')
    assert(feishuEncryptedEvent.payload.reply === 'echo:hello encrypted feishu', 'encrypted feishu message should generate reply')
    assert(feishuEncryptedEvent.payload.delivered === true, 'encrypted feishu message should call reply API')
    assert(externalCalls.some(call => call.target.includes('/messages/om_encrypted/reply') && call.body?.content?.includes('hello encrypted feishu')), 'feishu reply API payload should contain generated reply')

    const timestamp = '1700000000'
    const nonce = 'nonce'
    const signature = signWeChat(token, timestamp, nonce)
    const verifyResponse = await fetch(`${baseUrl}/api/im/webhook/wechat/binding_wechat?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}&echostr=ok-wechat`)
    assert(verifyResponse.ok, 'wechat verify should return 2xx')
    assert(await verifyResponse.text() === 'ok-wechat', 'wechat verify should echo echostr')

    const xml = [
      '<xml>',
      '<ToUserName><![CDATA[gh_app]]></ToUserName>',
      '<FromUserName><![CDATA[user-openid]]></FromUserName>',
      '<CreateTime>1700000000</CreateTime>',
      '<MsgType><![CDATA[text]]></MsgType>',
      '<Content><![CDATA[hello wechat]]></Content>',
      '<MsgId>10001</MsgId>',
      '</xml>'
    ].join('')
    const wechatResponse = await fetch(`${baseUrl}/api/im/webhook/wechat/binding_wechat?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: xml
    })
    const wechatReply = await wechatResponse.text()
    assert(wechatResponse.ok, 'wechat message should return 2xx')
    assert(wechatReply.includes('<Content>echo:hello wechat</Content>'), 'wechat passive reply should contain generated text')

    const encryptedXml = [
      '<xml>',
      '<ToUserName><![CDATA[gh_encrypt]]></ToUserName>',
      '<FromUserName><![CDATA[user-openid]]></FromUserName>',
      '<CreateTime>1700000000</CreateTime>',
      '<MsgType><![CDATA[text]]></MsgType>',
      '<Content><![CDATA[hello encrypted wechat]]></Content>',
      '<MsgId>10002</MsgId>',
      '</xml>'
    ].join('')
    const encryptedMessage = encryptWeChatPayload(encodingAesKey, 'gh_encrypt', encryptedXml)
    const encryptedSignature = signWeChatEncrypted(token, timestamp, nonce, encryptedMessage)
    const wechatEncryptedResponse = await fetch(`${baseUrl}/api/im/webhook/wechat/binding_wechat_encrypted?timestamp=${timestamp}&nonce=${nonce}&msg_signature=${encryptedSignature}`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: `<xml><ToUserName><![CDATA[gh_encrypt]]></ToUserName><Encrypt><![CDATA[${encryptedMessage}]]></Encrypt></xml>`
    })
    const wechatEncryptedReply = await wechatEncryptedResponse.text()
    assert(wechatEncryptedResponse.ok, 'encrypted wechat message should return 2xx')
    const replyEncrypt = parseXmlTag(wechatEncryptedReply, 'Encrypt')
    assert(replyEncrypt, 'encrypted wechat reply should contain Encrypt')
    assert(decryptWeChatPayload(encodingAesKey, replyEncrypt).includes('<Content>echo:hello encrypted wechat</Content>'), 'encrypted wechat reply should decrypt to generated text')

    const wecomEcho = encryptWeChatPayload(encodingAesKey, 'corp_id', 'ok-wecom')
    const wecomSignature = signWeChatEncrypted(token, timestamp, nonce, wecomEcho)
    const wecomVerifyResponse = await fetch(`${baseUrl}/api/im/webhook/wecom/binding_wecom?timestamp=${timestamp}&nonce=${nonce}&msg_signature=${wecomSignature}&echostr=${encodeURIComponent(wecomEcho)}`)
    assert(wecomVerifyResponse.ok, 'encrypted wecom verify should return 2xx')
    assert(await wecomVerifyResponse.text() === 'ok-wecom', 'encrypted wecom verify should decrypt echostr')

    const wecomXml = [
      '<xml>',
      '<ToUserName><![CDATA[corp_id]]></ToUserName>',
      '<FromUserName><![CDATA[wecom-user]]></FromUserName>',
      '<CreateTime>1700000000</CreateTime>',
      '<MsgType><![CDATA[text]]></MsgType>',
      '<Content><![CDATA[hello encrypted wecom]]></Content>',
      '<MsgId>20001</MsgId>',
      '</xml>'
    ].join('')
    const wecomEncryptedMessage = encryptWeChatPayload(encodingAesKey, 'corp_id', wecomXml)
    const wecomMessageSignature = signWeChatEncrypted(token, timestamp, nonce, wecomEncryptedMessage)
    const wecomMessageResponse = await fetch(`${baseUrl}/api/im/webhook/wecom/binding_wecom?timestamp=${timestamp}&nonce=${nonce}&msg_signature=${wecomMessageSignature}`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: `<xml><ToUserName><![CDATA[corp_id]]></ToUserName><Encrypt><![CDATA[${wecomEncryptedMessage}]]></Encrypt></xml>`
    })
    const wecomEncryptedReply = await wecomMessageResponse.text()
    assert(wecomMessageResponse.ok, 'encrypted wecom message should return 2xx')
    const wecomReplyEncrypt = parseXmlTag(wecomEncryptedReply, 'Encrypt')
    assert(wecomReplyEncrypt, 'encrypted wecom reply should contain Encrypt')
    assert(decryptWeChatPayload(encodingAesKey, wecomReplyEncrypt).includes('<Content>echo:hello encrypted wecom</Content>'), 'encrypted wecom reply should decrypt to generated text')

    const slackChallengeBody = JSON.stringify({ type: 'url_verification', challenge: 'ok-slack' })
    const slackChallengeTimestamp = '1700000003'
    const slackChallenge = await requestRaw(
      baseUrl,
      '/api/im/webhook/slack/binding_slack',
      slackChallengeBody,
      {
        'content-type': 'application/json',
        'x-slack-request-timestamp': slackChallengeTimestamp,
        'x-slack-signature': signSlack(slackSigningSecret, slackChallengeTimestamp, slackChallengeBody)
      }
    )
    assert(slackChallenge.response.ok, 'slack url verification should return 2xx')
    assert(slackChallenge.payload.challenge === 'ok-slack', 'slack url verification should echo challenge')

    const slackForm = new URLSearchParams({
      channel_id: 'C123',
      user_id: 'U123',
      user_name: 'Ada',
      text: 'hello slack'
    }).toString()
    const slackFormTimestamp = '1700000004'
    const slackMessage = await requestRaw(
      baseUrl,
      '/api/im/webhook/slack/binding_slack',
      slackForm,
      {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': slackFormTimestamp,
        'x-slack-signature': signSlack(slackSigningSecret, slackFormTimestamp, slackForm)
      }
    )
    assert(slackMessage.response.ok, 'slack slash command form should return 2xx')
    assert(slackMessage.payload.reply === 'echo:hello slack', 'slack slash command form should generate reply')

    const telegramMessage = await requestJson(
      baseUrl,
      '/api/im/webhook/telegram/binding_telegram',
      {
        message: {
          message_id: 30001,
          date: 1700000000,
          text: 'hello telegram',
          chat: { id: 'TG123' },
          from: { id: 'TU123', first_name: 'Tanya' }
        }
      },
      { 'x-telegram-bot-api-secret-token': 'telegram-secret' }
    )
    assert(telegramMessage.response.ok, 'telegram webhook should return 2xx')
    assert(telegramMessage.payload.reply === 'echo:hello telegram', 'telegram webhook should generate reply')
    assert(telegramMessage.payload.delivered === true, 'telegram webhook should call sendMessage')
    assert(externalCalls.some(call => call.target === 'https://api.telegram.org/bottelegram-token/sendMessage' && call.body?.chat_id === 'TG123' && call.body?.text === 'echo:hello telegram'), 'telegram sendMessage payload should contain generated reply')

    const discordMessage = await requestJson(
      baseUrl,
      '/api/im/webhook/discord/binding_discord',
      { channelId: 'D123', senderId: 'DU123', text: 'hello discord', secret: 'discord-secret' }
    )
    assert(discordMessage.response.ok, 'discord webhook should return 2xx')
    assert(discordMessage.payload.reply === 'echo:hello discord', 'discord webhook should generate reply')
    assert(discordMessage.payload.delivered === true, 'discord webhook should call configured webhook')
    assert(webhookCaptures.some(capture => capture.name === 'discord' && capture.body?.content === 'echo:hello discord'), 'discord webhook payload should contain generated reply')

    console.log('[im-gateway-smoke] ok')
  } finally {
    globalThis.fetch = originalFetch
    if (server) {
      await new Promise(resolve => server.close(resolve))
    }
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('[im-gateway-smoke] failed:', error)
  process.exitCode = 1
})
