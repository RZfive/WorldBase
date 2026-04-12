import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import type { PortableSettingsConfig } from './settings-store.js'

export const PORTABLE_SETTINGS_APP_ID = 'com.theworld.app'
export const PORTABLE_SETTINGS_EXTENSION = 'twcfg'

const PORTABLE_SETTINGS_FORMAT = 'the-world/encrypted-config'
const PORTABLE_SETTINGS_VERSION = 1
const PORTABLE_SETTINGS_ALGORITHM = 'aes-256-gcm'
const PORTABLE_SETTINGS_SECRET = 'TheWorld::PortableConfig::2026-04::internal-only'

interface PortableSettingsEnvelope {
  format: string
  version: number
  algorithm: string
  appId: string
  iv: string
  authTag: string
  ciphertext: string
}

interface PortableSettingsPayload {
  exportedAt: string
  config: PortableSettingsConfig
}

function derivePortableSettingsKey (appId: string): Buffer {
  return scryptSync(PORTABLE_SETTINGS_SECRET, `${appId}:${PORTABLE_SETTINGS_FORMAT}:v${PORTABLE_SETTINGS_VERSION}`, 32)
}

function decodeBase64Field (value: unknown, fieldName: string): Buffer {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`配置包字段无效: ${fieldName}`)
  }

  try {
    return Buffer.from(value, 'base64')
  } catch {
    throw new Error(`配置包字段无法解码: ${fieldName}`)
  }
}

export function encryptPortableSettingsConfig (config: PortableSettingsConfig, appId = PORTABLE_SETTINGS_APP_ID): string {
  const payload: PortableSettingsPayload = {
    exportedAt: new Date().toISOString(),
    config
  }

  const key = derivePortableSettingsKey(appId)
  const iv = randomBytes(12)
  const cipher = createCipheriv(PORTABLE_SETTINGS_ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ])

  const envelope: PortableSettingsEnvelope = {
    format: PORTABLE_SETTINGS_FORMAT,
    version: PORTABLE_SETTINGS_VERSION,
    algorithm: PORTABLE_SETTINGS_ALGORITHM,
    appId,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }

  return JSON.stringify(envelope, null, 2)
}

export function decryptPortableSettingsConfig (serialized: string, appId = PORTABLE_SETTINGS_APP_ID): PortableSettingsPayload {
  let envelope: PortableSettingsEnvelope
  try {
    envelope = JSON.parse(serialized) as PortableSettingsEnvelope
  } catch {
    throw new Error('配置包不是有效的 JSON 文件。')
  }

  if (envelope.format !== PORTABLE_SETTINGS_FORMAT) {
    throw new Error('不是 The World 可识别的配置包格式。')
  }
  if (envelope.version !== PORTABLE_SETTINGS_VERSION) {
    throw new Error(`不支持的配置包版本: ${String(envelope.version)}`)
  }
  if (envelope.algorithm !== PORTABLE_SETTINGS_ALGORITHM) {
    throw new Error(`不支持的配置包加密算法: ${String(envelope.algorithm)}`)
  }
  if (envelope.appId !== appId) {
    throw new Error('该配置包不属于当前应用。')
  }

  const iv = decodeBase64Field(envelope.iv, 'iv')
  const authTag = decodeBase64Field(envelope.authTag, 'authTag')
  const ciphertext = decodeBase64Field(envelope.ciphertext, 'ciphertext')

  try {
    const decipher = createDecipheriv(PORTABLE_SETTINGS_ALGORITHM, derivePortableSettingsKey(appId), iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString('utf8')

    const payload = JSON.parse(plaintext) as PortableSettingsPayload
    if (!payload || typeof payload !== 'object' || !payload.config || typeof payload.exportedAt !== 'string') {
      throw new Error('配置包内容缺失。')
    }
    return payload
  } catch (error) {
    throw new Error(`配置包解密失败: ${(error as Error).message || String(error)}`)
  }
}