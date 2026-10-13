import os from 'node:os'
import { app } from 'electron'
import { t } from '../i18n/main-i18n.js'
export type RestartPolicy = 'always' | 'on-failure' | 'never'

export interface ServiceEntry {
  projectId: string
  name: string
  port: number
  status: string
  pid?: number
  startedAt?: string
  framework?: string
  restartPolicy: RestartPolicy
  restartCount: number
}

export interface ServiceMap {
  services: ServiceEntry[]
  totalRunning: number
  totalStopped: number
  totalCrashed: number
}

interface CpuSample {
  total: number
  idle: number
  capturedAt: number
}

export interface SystemSummary {
  status: 'ok' | 'busy' | 'degraded'
  hostUptimeSeconds: number
  runningProjectCount: number
  trackedProjectProcessCount: number
  totalServiceCount: number
  crashedServiceCount: number
  cpuUsagePercent: number | null
  memoryUsagePercent: number
}

export interface HostCpuInfo {
  model: string
  cores: number
  architecture: string
  loadAverage: number[]
  usagePercent: number | null
  sampleWindowMs: number | null
}

export interface HostMemoryInfo {
  totalBytes: number
  freeBytes: number
  usedBytes: number
  usagePercent: number
  processRssBytes: number
  processHeapUsedBytes: number
  processHeapTotalBytes: number
  processExternalBytes: number
}

export interface CurrentProcessInfo {
  pid: number
  uptimeSeconds: number
  platform: NodeJS.Platform
  arch: string
  memory: {
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
    externalBytes: number
  }
}

export interface ProjectProcessInfo {
  projectId: string
  status: string
  port?: number
  pid?: number
  startedAt?: string
  uptimeSeconds?: number
  exitCode?: number | null
  error?: string
}

export interface SystemStatusSnapshot {
  fetchedAt: string
  refreshIntervalMs: number
  cacheAgeMs: number
  host: {
    platform: NodeJS.Platform
    release: string
    arch: string
    uptimeSeconds: number
    nodeVersion: string
    electronVersion: string | null
  }
  summary: SystemSummary
  cpu: HostCpuInfo
  memory: HostMemoryInfo
  gpu: {
    status: 'hardware' | 'software' | 'disabled' | 'unavailable'
    primaryDevice: string
    secondaryDevices: string[]
    featureStatus: Record<string, string>
  }
  currentProcess: CurrentProcessInfo
  projectProcesses: ProjectProcessInfo[]
  services: ServiceMap
}

/**
 * Electron owns host-only observations (GPU, Electron heap and OS counters),
 * while the selected harness owns managed project process state. This bridge
 * keeps the two boundaries explicit instead of letting Rust-mode status read
 * the dormant TypeScript RuntimeManager.
 */
export interface HarnessProjectRuntimeSnapshot {
  services: ServiceMap
  projectProcesses: ProjectProcessInfo[]
}

export type HarnessProjectRuntimeResolver = () => Promise<HarnessProjectRuntimeSnapshot | null>

export class SystemService {
  private readonly refreshIntervalMs: number
  private readonly harnessProjectRuntimeResolver?: HarnessProjectRuntimeResolver
  private cachedSnapshot: SystemStatusSnapshot | null = null
  private cachedRuntimeSource: 'rust' | 'typescript' | null = null
  private lastCpuSample: CpuSample | null = null

  constructor (
    refreshIntervalMs = 5000,
    harnessProjectRuntimeResolver?: HarnessProjectRuntimeResolver
  ) {
    this.refreshIntervalMs = refreshIntervalMs
    this.harnessProjectRuntimeResolver = harnessProjectRuntimeResolver
  }

  async getStatus (): Promise<SystemStatusSnapshot> {
    const now = Date.now()
    const harnessRuntime = await this.harnessProjectRuntimeResolver?.()
    const runtimeSource = harnessRuntime ? 'rust' : 'typescript'
    if (this.cachedSnapshot && this.cachedRuntimeSource === runtimeSource) {
      const cacheAgeMs = now - new Date(this.cachedSnapshot.fetchedAt).getTime()
      if (cacheAgeMs < this.refreshIntervalMs) {
        return {
          ...this.cachedSnapshot,
          cacheAgeMs
        }
      }
    }

    // Rust is the only project runtime; the resolver is mandatory in practice.
    const projectProcesses = harnessRuntime?.projectProcesses ?? []
    const services = harnessRuntime?.services ?? { services: [], totalRunning: 0, totalStopped: 0, totalCrashed: 0 }
    const cpu = this.captureCpuInfo(now)
    const memory = this.captureMemoryInfo()
    const gpu = await this.captureGpuInfo()
    const currentProcess = this.captureCurrentProcess()
    const hostUptimeSeconds = os.uptime()

    const snapshot: SystemStatusSnapshot = {
      fetchedAt: new Date(now).toISOString(),
      refreshIntervalMs: this.refreshIntervalMs,
      cacheAgeMs: 0,
      host: {
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        uptimeSeconds: hostUptimeSeconds,
        nodeVersion: process.version,
        electronVersion: process.versions.electron || null
      },
      summary: {
        status: this.resolveOverallStatus(cpu.usagePercent, memory.usagePercent, services),
        hostUptimeSeconds,
        runningProjectCount: services.totalRunning,
        trackedProjectProcessCount: projectProcesses.length,
        totalServiceCount: services.services.length,
        crashedServiceCount: services.totalCrashed,
        cpuUsagePercent: cpu.usagePercent,
        memoryUsagePercent: memory.usagePercent
      },
      cpu,
      memory,
      gpu,
      currentProcess,
      projectProcesses,
      services
    }

    this.cachedSnapshot = snapshot
    this.cachedRuntimeSource = runtimeSource
    return snapshot
  }

  private captureCpuInfo (now: number): HostCpuInfo {
    const cpuModels = os.cpus()
    const sample = cpuModels.reduce<CpuSample>((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
      acc.total += total
      acc.idle += cpu.times.idle
      return acc
    }, { total: 0, idle: 0, capturedAt: now })

    let usagePercent: number | null = null
    let sampleWindowMs: number | null = null

    if (this.lastCpuSample) {
      const totalDelta = sample.total - this.lastCpuSample.total
      const idleDelta = sample.idle - this.lastCpuSample.idle
      sampleWindowMs = now - this.lastCpuSample.capturedAt
      if (totalDelta > 0) {
        usagePercent = this.roundToOneDecimal(((totalDelta - idleDelta) / totalDelta) * 100)
      }
    }

    this.lastCpuSample = sample

    return {
      model: cpuModels[0]?.model || 'unknown',
      cores: cpuModels.length,
      architecture: process.arch,
      loadAverage: os.loadavg().map(value => Number(value.toFixed(2))),
      usagePercent,
      sampleWindowMs
    }
  }

  private captureMemoryInfo (): HostMemoryInfo {
    const totalBytes = os.totalmem()
    const freeBytes = os.freemem()
    const usedBytes = totalBytes - freeBytes
    const usagePercent = totalBytes > 0
      ? this.roundToOneDecimal((usedBytes / totalBytes) * 100)
      : 0
    const processMemory = process.memoryUsage()

    return {
      totalBytes,
      freeBytes,
      usedBytes,
      usagePercent,
      processRssBytes: processMemory.rss,
      processHeapUsedBytes: processMemory.heapUsed,
      processHeapTotalBytes: processMemory.heapTotal,
      processExternalBytes: processMemory.external
    }
  }

  private captureCurrentProcess (): CurrentProcessInfo {
    const memory = process.memoryUsage()
    return {
      pid: process.pid,
      uptimeSeconds: Number(process.uptime().toFixed(1)),
      platform: process.platform,
      arch: process.arch,
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external
      }
    }
  }

  private async captureGpuInfo (): Promise<SystemStatusSnapshot['gpu']> {
    try {
      const featureStatus = app.getGPUFeatureStatus()
      const normalizedFeatureStatus = Object.fromEntries(
        Object.entries(featureStatus).map(([name, status]) => [name, String(status)])
      )
      const gpuInfo = await app.getGPUInfo('basic') as Record<string, unknown>
      const rawDevices = Array.isArray(gpuInfo.gpuDevice) ? gpuInfo.gpuDevice : []
      const devices = rawDevices
        .filter((device): device is Record<string, unknown> => Boolean(device) && typeof device === 'object')
        .map((device) => ({
          active: Boolean(device.active),
          deviceString: typeof device.deviceString === 'string' && device.deviceString.trim()
            ? device.deviceString.trim()
            : t('mainDialog.unknownGpu')
        }))

      const activeDevice = devices.find(device => device.active) || devices[0]
      const primaryDevice = activeDevice?.deviceString || t('mainDialog.gpuNotDetected')
      const secondaryDevices = devices
        .filter(device => device !== activeDevice)
        .map(device => device.deviceString)

      const statusValues = Object.values(normalizedFeatureStatus)
      let status: SystemStatusSnapshot['gpu']['status'] = 'unavailable'
      if (statusValues.some(value => value === 'disabled_off' || value === 'unavailable_software')) {
        status = 'disabled'
      } else if (statusValues.some(value => value === 'software_only' || value === 'disabled_software')) {
        status = 'software'
      } else if (statusValues.some(value => value === 'enabled' || value === 'enabled_readback' || value === 'enabled_force')) {
        status = 'hardware'
      }

      return {
        status,
        primaryDevice,
        secondaryDevices,
        featureStatus: normalizedFeatureStatus
      }
    } catch {
      return {
        status: 'unavailable',
        primaryDevice: t('mainDialog.gpuNotDetected'),
        secondaryDevices: [],
        featureStatus: {}
      }
    }
  }

  private resolveOverallStatus (
    cpuUsagePercent: number | null,
    memoryUsagePercent: number,
    services: ServiceMap
  ): 'ok' | 'busy' | 'degraded' {
    if (services.totalCrashed > 0) return 'degraded'
    if ((cpuUsagePercent ?? 0) >= 85 || memoryUsagePercent >= 85) return 'busy'
    return 'ok'
  }

  private roundToOneDecimal (value: number): number {
    return Math.round(value * 10) / 10
  }
}
