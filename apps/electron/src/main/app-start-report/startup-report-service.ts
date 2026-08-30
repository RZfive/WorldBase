import { app } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SettingsStore } from '../settings/settings-store.js'
import type { SystemService, SystemStatusSnapshot } from '../system-capabilities/system-service.js'

const DEFAULT_UPDATE_API_BASE_URL = 'https://api.worldbase.world'
const START_REPORT_PATH = '/api/app-starts'
const INSTALL_ID_FILE = 'install-id.json'
const REPORT_TIMEOUT_MS = 10000

type StartupReportOptions = {
  settingsStore: SettingsStore
  systemService: SystemService
}

type InstallIdFile = {
  id?: unknown
}

function inferChannelFromVersion (version: string): 'stable' | 'beta' {
  return /(?:alpha|beta|rc)/i.test(version) ? 'beta' : 'stable'
}

function normalizeUrlBase (value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function isValidHttpUrl (value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function resolveApiBaseUrl (settingsStore: SettingsStore): string {
  const config = settingsStore.getAppUpdateConfig()
  const explicit = normalizeUrlBase(config.updateApiUrl || '')

  if (explicit && isValidHttpUrl(explicit)) {
    try {
      const parsed = new URL(explicit)
      return `${parsed.protocol}//${parsed.host}`
    } catch {
      return DEFAULT_UPDATE_API_BASE_URL
    }
  }

  return DEFAULT_UPDATE_API_BASE_URL
}

function resolveReportUrl (settingsStore: SettingsStore): string {
  return `${resolveApiBaseUrl(settingsStore)}${START_REPORT_PATH}`
}

async function readInstallId (filePath: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as InstallIdFile
    return typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : null
  } catch {
    return null
  }
}

async function getOrCreateInstallId (): Promise<string> {
  const filePath = path.join(app.getPath('userData'), INSTALL_ID_FILE)
  const existing = await readInstallId(filePath)
  if (existing) return existing

  const id = randomUUID()
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify({ id }, null, 2), 'utf8')
  return id
}

function execFileText (command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2500 }, (error, stdout) => {
      if (error) {
        resolve('')
        return
      }
      resolve(String(stdout).trim())
    })
  })
}

async function resolveDeviceModel (): Promise<string> {
  if (process.platform === 'darwin') {
    return await execFileText('sysctl', ['-n', 'hw.model'])
  }

  if (process.platform === 'win32') {
    return await execFileText('powershell.exe', [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance Win32_ComputerSystem).Model'
    ])
  }

  if (process.platform === 'linux') {
    for (const filePath of [
      '/sys/devices/virtual/dmi/id/product_name',
      '/sys/firmware/devicetree/base/model'
    ]) {
      try {
        const value = fs.readFileSync(filePath, 'utf8').replace(/\0/g, '').trim()
        if (value) return value
      } catch {
        // Try the next known system model location.
      }
    }
  }

  return os.hostname()
}

function buildSystemPayload (snapshot: SystemStatusSnapshot) {
  return {
    host: {
      platform: snapshot.host.platform,
      release: snapshot.host.release,
      arch: snapshot.host.arch,
      electronVersion: snapshot.host.electronVersion,
      nodeVersion: snapshot.host.nodeVersion
    },
    cpu: {
      model: snapshot.cpu.model,
      cores: snapshot.cpu.cores,
      architecture: snapshot.cpu.architecture
    },
    memory: {
      totalBytes: snapshot.memory.totalBytes
    },
    gpu: {
      primaryDevice: snapshot.gpu.primaryDevice,
      status: snapshot.gpu.status
    }
  }
}

export async function reportStartup (options: StartupReportOptions): Promise<void> {
  if (!app.isPackaged) return

  const reportUrl = resolveReportUrl(options.settingsStore)
  if (!isValidHttpUrl(reportUrl)) return

  const [deviceId, deviceModel, systemSnapshot] = await Promise.all([
    getOrCreateInstallId(),
    resolveDeviceModel(),
    options.systemService.getStatus()
  ])

  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), REPORT_TIMEOUT_MS)

  try {
    const response = await fetch(reportUrl, {
      method: 'POST',
      signal: timeoutController.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        channel: inferChannelFromVersion(app.getVersion()),
        deviceId,
        deviceModel,
        osRelease: os.release(),
        coldStart: true,
        system: buildSystemPayload(systemSnapshot)
      })
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(body || `Startup report API returned ${response.status}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}
