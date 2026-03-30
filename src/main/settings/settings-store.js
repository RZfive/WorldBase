import fs from 'node:fs'
import path from 'node:path'

/**
 * SettingsStore — 用户设置持久化存储
 * 将设置保存为 JSON 文件到 userData 目录
 */
export class SettingsStore {
  /**
   * @param {string} userDataPath - Electron app.getPath('userData')
   */
  constructor (userDataPath) {
    this.filePath = path.join(userDataPath, 'settings.json')
    this._cache = null
  }

  /**
   * Read all settings from disk.
   * @returns {object}
   */
  read () {
    if (this._cache) return this._cache

    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this._cache = JSON.parse(raw)
        return this._cache
      }
    } catch (err) {
      console.error('[settings] Failed to read settings:', err.message)
    }

    return {}
  }

  /**
   * Write settings to disk (merge with existing).
   * @param {object} data
   */
  write (data) {
    const current = this.read()
    const merged = { ...current, ...data }
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf-8')
      this._cache = merged
    } catch (err) {
      console.error('[settings] Failed to write settings:', err.message)
      throw err
    }
  }

  /**
   * Get AI provider settings.
   * @returns {{ apiKey: string, baseUrl: string, model: string }}
   */
  getAISettings () {
    const settings = this.read()
    return {
      apiKey: settings.aiApiKey || '',
      baseUrl: settings.aiBaseUrl || '',
      model: settings.aiModel || ''
    }
  }

  /**
   * Save AI provider settings.
   * @param {{ apiKey?: string, baseUrl?: string, model?: string }} config
   */
  saveAISettings (config) {
    const data = {}
    if (config.apiKey !== undefined) data.aiApiKey = config.apiKey
    if (config.baseUrl !== undefined) data.aiBaseUrl = config.baseUrl
    if (config.model !== undefined) data.aiModel = config.model
    this.write(data)
  }
}
