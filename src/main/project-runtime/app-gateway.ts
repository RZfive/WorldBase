import type { RuntimeManager } from './runtime-manager.js'
import type { ProjectFS } from '../project-fs/project-fs.js'
import type { BuilderService } from './builder-service.js'

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

/**
 * AppGateway — 统一网关 / 服务管理器
 * 维护服务注册表、定期健康检查、自动重启
 */
export class AppGateway {
  private runtimeManager: RuntimeManager
  private projectFS: ProjectFS
  private builderService: BuilderService
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null
  private restartPolicies = new Map<string, RestartPolicy>()
  private restartCounts = new Map<string, number>()
  private maxRestarts = 3

  constructor (
    runtimeManager: RuntimeManager,
    projectFS: ProjectFS,
    builderService: BuilderService
  ) {
    this.runtimeManager = runtimeManager
    this.projectFS = projectFS
    this.builderService = builderService
  }

  /**
   * Start periodic health checks (every 30 seconds).
   */
  startHealthChecks (intervalMs = 30000): void {
    if (this.healthCheckInterval) return

    this.healthCheckInterval = setInterval(async () => {
      await this._performHealthChecks()
    }, intervalMs)

    console.log(`[AppGateway] Health checks started (every ${intervalMs / 1000}s)`)
  }

  /**
   * Stop periodic health checks.
   */
  stopHealthChecks (): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
      console.log('[AppGateway] Health checks stopped')
    }
  }

  /**
   * Set restart policy for a project.
   */
  setRestartPolicy (projectId: string, policy: RestartPolicy): void {
    this.restartPolicies.set(projectId, policy)
  }

  /**
   * Get the restart policy for a project (defaults to 'on-failure').
   */
  getRestartPolicy (projectId: string): RestartPolicy {
    return this.restartPolicies.get(projectId) || 'on-failure'
  }

  /**
   * Get the complete service map showing all projects and their status.
   */
  async getServiceMap (): Promise<ServiceMap> {
    const projects = await this.projectFS.listProjects()
    const services: ServiceEntry[] = []
    let totalRunning = 0
    let totalStopped = 0
    let totalCrashed = 0

    for (const project of projects) {
      const status = this.runtimeManager.getStatus(project.id)
      const meta = project as Record<string, unknown>

      const entry: ServiceEntry = {
        projectId: project.id,
        name: project.name,
        port: status.port || 0,
        status: status.status,
        startedAt: status.startedAt,
        framework: (meta.framework as string) || undefined,
        restartPolicy: this.getRestartPolicy(project.id),
        restartCount: this.restartCounts.get(project.id) || 0
      }

      services.push(entry)

      if (status.status === 'running') totalRunning++
      else if (status.status === 'crashed' || status.status === 'error') totalCrashed++
      else totalStopped++
    }

    return { services, totalRunning, totalStopped, totalCrashed }
  }

  /**
   * Start all projects that have auto-start configured.
   */
  async startAll (): Promise<{ started: string[]; failed: string[] }> {
    const projects = await this.projectFS.listProjects()
    const started: string[] = []
    const failed: string[] = []

    for (const project of projects) {
      const status = this.runtimeManager.getStatus(project.id)
      if (status.status === 'running') continue

      try {
        await this.runtimeManager.start(project.id)
        started.push(project.id)
      } catch (err) {
        console.warn(`[AppGateway] Failed to start ${project.id}: ${(err as Error).message}`)
        failed.push(project.id)
      }
    }

    return { started, failed }
  }

  /**
   * Stop all running projects.
   */
  async stopAll (): Promise<void> {
    await this.runtimeManager.stopAll()
  }

  /**
   * Perform health checks on all registered services.
   * Auto-restart crashed services based on their restart policy.
   */
  private async _performHealthChecks (): Promise<void> {
    const projects = await this.projectFS.listProjects()

    for (const project of projects) {
      const status = this.runtimeManager.getStatus(project.id)

      if (status.status === 'crashed' || status.status === 'error') {
        const policy = this.getRestartPolicy(project.id)
        const restartCount = this.restartCounts.get(project.id) || 0

        if (policy === 'never') continue
        if (policy === 'on-failure' && restartCount >= this.maxRestarts) {
          console.warn(`[AppGateway] ${project.id} exceeded max restarts (${this.maxRestarts}), skipping`)
          continue
        }

        console.log(`[AppGateway] Auto-restarting ${project.id} (policy: ${policy}, count: ${restartCount + 1})`)
        try {
          await this.runtimeManager.start(project.id)
          this.restartCounts.set(project.id, restartCount + 1)
        } catch (err) {
          console.warn(`[AppGateway] Failed to restart ${project.id}: ${(err as Error).message}`)
          this.restartCounts.set(project.id, restartCount + 1)
        }
      }
    }
  }
}
