import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { PortManager } from './port-manager.js'
import { ProcessMonitor } from './process-monitor.js'
import { LAN_SERVER_PORT } from '../constants.js'
import type { BuilderService } from './builder-service.js'
import { createBundledRuntimeEnv } from './bundled-runtime.js'
import { ensureNextRuntimeCompatiblePackageJson } from './next-runtime-compat.js'

interface LogEntry {
  type: 'stdout' | 'stderr'
  text: string
  time: number
}

interface ProjectRunInfo {
  process: ChildProcess
  port: number
  status: string
  logs: LogEntry[]
  startedAt: string
  exitCode?: number | null
  error?: string
}

interface ProjectStatus {
  projectId: string
  status: string
  port?: number
  pid?: number
  startedAt?: string
  exitCode?: number | null
  error?: string
}

export interface ProjectProcessSnapshot {
  projectId: string
  status: string
  port?: number
  pid?: number
  startedAt?: string
  uptimeSeconds?: number
  exitCode?: number | null
  error?: string
}

interface StartResult {
  projectId: string
  port: number
  status: string
}

interface StopResult {
  projectId: string
  status: string
}

interface InstallResult {
  success: boolean
  output: string
}

/** Check whether a project has a Next.js standalone build output. */
function _hasStandaloneBuild (projectDir: string): boolean {
  return existsSync(path.join(projectDir, '.next', 'standalone', 'server.js'))
}

/**
 * RuntimeManager — 子项目进程生命周期管理
 */
export class RuntimeManager {
  private projectsDir: string
  private portManager: PortManager
  private processMonitor: ProcessMonitor
  private builderService: Pick<BuilderService, 'build'> | null = null
  private runningProjects = new Map<string, ProjectRunInfo>()

  constructor (projectsDir: string) {
    this.projectsDir = projectsDir
    this.portManager = new PortManager()
    this.processMonitor = new ProcessMonitor()
  }

  setBuilderService (builderService: Pick<BuilderService, 'build'>): void {
    this.builderService = builderService
  }

  /**
   * Start a project's backend process.
   */
  async start (projectId: string): Promise<StartResult> {
    if (this.runningProjects.has(projectId)) {
      const existing = this.runningProjects.get(projectId)!
      if (existing.status === 'running') {
        return { projectId, port: existing.port, status: 'already_running' }
      }

      if (this._hasLiveProcess(existing.process)) {
        this._terminateProcess(existing.process, 'SIGTERM')
      }

      this.runningProjects.delete(projectId)
      this.portManager.release(projectId)
    }

    const projectDir = path.join(this.projectsDir, projectId)
    const metaPath = path.join(projectDir, '.world-meta.json')
    const packageJsonPath = path.join(projectDir, 'package.json')

    if (!existsSync(metaPath)) {
      throw new Error(`Project meta not found: ${projectId}`)
    }

    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>
    let runtime = (meta.runtime as Record<string, unknown>) || {}
    let backendConfig = runtime.backend as Record<string, unknown> | undefined

    // Auto-detect runtime config if missing
    if (!backendConfig) {
      backendConfig = await this._detectRuntimeConfig(projectDir) ?? undefined
      if (backendConfig) {
        runtime.backend = backendConfig
        meta.runtime = runtime
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
        console.log(`[RuntimeManager] Auto-detected runtime config for ${projectId}:`, backendConfig)
      } else {
        return { projectId, port: 0, status: 'no_backend' } as StartResult
      }
    }

    const isNextProject = await this._isNextProject(projectDir, meta, backendConfig)
    if (isNextProject) {
      await this._ensureNextProjectReady(projectId, projectDir, packageJsonPath)
    }

    // If a Next.js standalone build exists, prefer it over the legacy dev flow.
    const isStandalone = _hasStandaloneBuild(projectDir)

    if (!isStandalone) {
      // Legacy path: auto-install dependencies if node_modules is missing
      const nodeModulesPath = path.join(projectDir, 'node_modules')
      if (existsSync(packageJsonPath) && !existsSync(nodeModulesPath)) {
        console.log(`[RuntimeManager] Auto-installing dependencies for ${projectId}...`)
        await this.installDeps(projectId)
        console.log(`[RuntimeManager] Dependencies installed for ${projectId}`)
      }
    }

    // Allocate a port dynamically; the configured port is a preference only
    const configuredPort = backendConfig.port as number | undefined
    const port = await this.portManager.allocate(projectId, configuredPort)

    // Determine working directory and command
    let cwd: string
    let command: string

    if (isStandalone) {
      // Next.js standalone mode — run the pre-built server directly
      cwd = path.join(projectDir, '.next', 'standalone')
      command = 'node server.js'
      console.log(`[RuntimeManager] Starting ${projectId} in standalone mode`)
    } else {
      // Legacy mode — use configured command
      cwd = backendConfig.cwd
        ? path.join(projectDir, backendConfig.cwd as string)
        : projectDir

      command = (backendConfig.command as string) || 'node server.js'

      // If allocated port differs from the configured port and the command is an
      // npm script wrapper, extract the raw script and replace the hardcoded port
      // with $PORT so the dynamically allocated port is always used.
      if (configuredPort && port !== configuredPort &&
          (command === 'npm start' || command === 'npm run dev')) {
        try {
          const pkgRaw = await fs.readFile(packageJsonPath, 'utf-8')
          const pkg = JSON.parse(pkgRaw) as Record<string, unknown>
          const scripts = (pkg.scripts || {}) as Record<string, string>
          const scriptKey = command === 'npm start' ? 'start' : 'dev'
          const rawScript = scripts[scriptKey]
          if (rawScript) {
            const replaced = this._replacePortInCommand(rawScript, configuredPort)
            if (replaced !== rawScript) {
              command = replaced
            }
          }
        } catch {
          // If reading package.json fails, continue with original command
        }
      }
    }

    const [cmd, ...args] = command.split(' ')

    // Spawn the process — include node_modules/.bin in PATH so that raw
    // commands extracted from npm scripts can resolve locally-installed binaries.
    const env = await createBundledRuntimeEnv(cwd, {
      PORT: String(port),
      HOSTNAME: '0.0.0.0',
      NODE_ENV: this._resolveNodeEnv(command, isStandalone, isNextProject),
      THE_WORLD_PROJECT_ID: projectId,
      THE_WORLD_PROJECT_ROOT: projectDir,
      THE_WORLD_LAN_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}`,
      THE_WORLD_RESOURCE_PROXY_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/resource-proxy`,
      THE_WORLD_PROJECT_DATA_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/projects/${projectId}/data`,
      THE_WORLD_SYSTEM_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/system`,
      NEXT_PUBLIC_THE_WORLD_LAN_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}`,
      NEXT_PUBLIC_THE_WORLD_RESOURCE_PROXY_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/resource-proxy`,
      NEXT_PUBLIC_THE_WORLD_PROJECT_DATA_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/projects/${projectId}/data`,
      NEXT_PUBLIC_THE_WORLD_SYSTEM_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/system`
    })

    const childProcess = spawn(cmd, args, {
      cwd,
      env,
      // Unix-like systems need detached mode here because it creates a new
      // process group; later shutdown uses process.kill(-pid, signal) to
      // target that whole group and terminate npm/shell descendants together.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    })

    const projectInfo: ProjectRunInfo = {
      process: childProcess,
      port,
      status: 'starting',
      logs: [],
      startedAt: new Date().toISOString()
    }

    // Capture stdout/stderr
    childProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString()
      projectInfo.logs.push({ type: 'stdout', text: line, time: Date.now() })
      // Keep only last 500 log lines
      if (projectInfo.logs.length > 500) {
        projectInfo.logs = projectInfo.logs.slice(-500)
      }
    })

    childProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString()
      projectInfo.logs.push({ type: 'stderr', text: line, time: Date.now() })
      if (projectInfo.logs.length > 500) {
        projectInfo.logs = projectInfo.logs.slice(-500)
      }
    })

    childProcess.on('exit', (code) => {
      projectInfo.status = code === 0 ? 'stopped' : 'crashed'
      projectInfo.exitCode = code
      this.portManager.release(projectId)
    })

    childProcess.on('error', (err) => {
      projectInfo.status = 'error'
      projectInfo.error = err.message
      this.portManager.release(projectId)
    })

    this.runningProjects.set(projectId, projectInfo)

    // Give generated projects a bit more time because first boot often includes
    // dependency warmup and framework startup before the port becomes reachable.
    const ready = await this.processMonitor.waitForReady(port, 15000)
    if (projectInfo.status === 'crashed' || projectInfo.status === 'error') {
      const recentLogs = this.getLogs(projectId, 40).map(log => log.text).join('\n')
      throw new Error(`Project process terminated before ready.${recentLogs ? `\n${recentLogs}` : ''}`)
    }
    if (!ready) {
      await this.stop(projectId)
      const recentLogs = this.getLogs(projectId, 40).map(log => log.text).join('\n')
      throw new Error(`Project did not become ready on port ${port} within 15 seconds.${recentLogs ? `\n${recentLogs}` : ''}`)
    }
    projectInfo.status = 'running'

    return { projectId, port, status: 'running' }
  }

  /**
   * Stop a project's backend process.
   */
  async stop (projectId: string): Promise<StopResult> {
    const info = this.runningProjects.get(projectId)
    if (!info) {
      return { projectId, status: 'not_running' }
    }

    if (!this._hasLiveProcess(info.process)) {
      if (info.status === 'running' || info.status === 'starting' || info.status === 'stopping') {
        info.status = 'stopped'
      }
      this.portManager.release(projectId)
      return { projectId, status: 'not_running' }
    }

    info.status = 'stopping'

    return new Promise((resolve) => {
      let forceKillTimer: NodeJS.Timeout | null = null

      const finalize = () => {
        if (forceKillTimer) {
          clearTimeout(forceKillTimer)
        }
        info.status = 'stopped'
        this.portManager.release(projectId)
        resolve({ projectId, status: 'stopped' })
      }

      const onExit = () => {
        info.process.off('error', onError)
        finalize()
      }

      const onError = () => {
        info.process.off('exit', onExit)
        finalize()
      }

      info.process.once('exit', onExit)
      info.process.once('error', onError)

      try {
        this._terminateProcess(info.process, 'SIGTERM')
      } catch {
        info.process.off('exit', onExit)
        info.process.off('error', onError)
        finalize()
        return
      }

      forceKillTimer = setTimeout(() => {
        if (this._hasLiveProcess(info.process)) {
          try {
            this._terminateProcess(info.process, 'SIGKILL')
          } catch {
            finalize()
          }
        }
      }, 5000)
    })
  }

  /**
   * Restart a project's backend.
   */
  async restart (projectId: string): Promise<StartResult> {
    await this.stop(projectId)
    return this.start(projectId)
  }

  /**
   * Stop all running projects.
   */
  async stopAll (): Promise<void> {
    const promises: Promise<StopResult>[] = []
    for (const [projectId] of this.runningProjects) {
      promises.push(this.stop(projectId))
    }
    await Promise.allSettled(promises)
  }

  /**
   * Get the status of a project.
   */
  getStatus (projectId: string): ProjectStatus {
    const info = this.runningProjects.get(projectId)
    if (!info) {
      return { projectId, status: 'not_started' }
    }
    return {
      projectId,
      status: info.status,
      port: info.port,
      pid: info.process.pid,
      startedAt: info.startedAt,
      exitCode: info.exitCode,
      error: info.error
    }
  }

  getProjectProcesses (): ProjectProcessSnapshot[] {
    return Array.from(this.runningProjects.entries())
      .map(([projectId, info]) => ({
        projectId,
        status: info.status,
        port: info.port,
        pid: info.process.pid,
        startedAt: info.startedAt,
        uptimeSeconds: info.startedAt
          ? Math.max(0, Number(((Date.now() - new Date(info.startedAt).getTime()) / 1000).toFixed(1)))
          : undefined,
        exitCode: info.exitCode,
        error: info.error
      }))
      .sort((left, right) => left.projectId.localeCompare(right.projectId))
  }

  /**
   * Get the port of a running project.
   */
  getPort (projectId: string): number | null {
    const info = this.runningProjects.get(projectId)
    if (!info || info.status !== 'running') {
      return null
    }
    return info.port
  }

  /**
   * Get recent logs for a project.
   */
  getLogs (projectId: string, lines = 50): LogEntry[] {
    const info = this.runningProjects.get(projectId)
    if (!info) {
      return []
    }
    return info.logs.slice(-lines)
  }

  /**
   * Install dependencies for a project.
   */
  async installDeps (projectId: string): Promise<InstallResult> {
    const projectDir = path.join(this.projectsDir, projectId)
    const meta = JSON.parse(await fs.readFile(path.join(projectDir, '.world-meta.json'), 'utf-8')) as Record<string, unknown>

    const runtime = meta.runtime as Record<string, unknown> | undefined
    const backend = runtime?.backend as Record<string, unknown> | undefined
    const cwd = backend?.cwd
      ? path.join(projectDir, backend.cwd as string)
      : projectDir

    if (await this._isNextProject(projectDir, meta, backend)) {
      await ensureNextRuntimeCompatiblePackageJson(this.projectsDir, cwd)
    }

    return createBundledRuntimeEnv(cwd).then(env => new Promise((resolve, reject) => {
      const child = spawn('npm', ['install'], {
        cwd,
        stdio: 'pipe',
        shell: true,
        env
      })

      let output = ''
      child.stdout?.on('data', (data: Buffer) => { output += data.toString() })
      child.stderr?.on('data', (data: Buffer) => { output += data.toString() })

      child.on('exit', (code) => {
        if (code === 0) {
          resolve({ success: true, output })
        } else {
          reject(new Error(`npm install failed with code ${code}: ${output}`))
        }
      })

      child.on('error', reject)
    }))
  }

  /**
   * Auto-detect runtime configuration from project files.
   */
  private async _detectRuntimeConfig (projectDir: string): Promise<Record<string, unknown> | null> {
    const packageJsonPath = path.join(projectDir, 'package.json')

    // Prefer Next.js standalone build if available
    if (_hasStandaloneBuild(projectDir)) {
      return { command: 'node .next/standalone/server.js' }
    }

    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8')) as Record<string, unknown>
        const scripts = (pkg.scripts || {}) as Record<string, string>
        const deps: Record<string, string> = {
          ...((pkg.dependencies || {}) as Record<string, string>),
          ...((pkg.devDependencies || {}) as Record<string, string>)
        }

        // Detect Next.js — prefer build script for standalone mode
        if (deps.next && scripts.build) {
          return { command: 'npm start' }
        }

        if (scripts.start) {
          const port = this._extractPortFromScript(scripts.start)
          return { command: 'npm start', ...(port ? { port } : {}) }
        }

        if (scripts.dev) {
          const port = this._extractPortFromScript(scripts.dev)
          return { command: 'npm run dev', ...(port ? { port } : {}) }
        }
      } catch {
        // Invalid package.json, fall through
      }
    }

    // Check common entry points
    if (existsSync(path.join(projectDir, 'server.js'))) {
      return { command: 'node server.js' }
    }
    if (existsSync(path.join(projectDir, 'index.js'))) {
      return { command: 'node index.js' }
    }
    if (existsSync(path.join(projectDir, 'app.js'))) {
      return { command: 'node app.js' }
    }

    // Pure static site — serve with http-server
    if (existsSync(path.join(projectDir, 'index.html'))) {
      return { command: 'npx http-server . -p $PORT -c-1 --cors' }
    }

    return null
  }

  private _hasLiveProcess (childProcess: ChildProcess): boolean {
    // `killed === true` only means a signal was sent, not that the process tree
    // has already exited, so rely on exit metadata here.
    return childProcess.exitCode == null && childProcess.signalCode == null
  }

  private _terminateProcess (childProcess: ChildProcess, signal: NodeJS.Signals): void {
    if (!this._hasLiveProcess(childProcess)) return

    if (process.platform === 'win32') {
      const pid = childProcess.pid
      if (!pid) {
        childProcess.kill(signal)
        return
      }

      const taskkillProcess = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        shell: true
      })
      taskkillProcess.once('exit', (code) => {
        if (code && this._hasLiveProcess(childProcess)) {
          console.warn(`[RuntimeManager] taskkill exited with code ${code} for PID ${pid}, falling back to direct kill`)
          try {
            childProcess.kill(signal)
          } catch {
            // Ignore fallback kill errors.
          }
        }
      })
      taskkillProcess.once('error', () => {
        console.warn(`[RuntimeManager] taskkill failed for PID ${pid}, falling back to direct kill`)
        try {
          childProcess.kill(signal)
        } catch {
          // Ignore fallback kill errors.
        }
      })
      return
    }

    const pid = childProcess.pid
    if (pid) {
      try {
        // On Unix-like systems, a negative PID targets the spawned process group,
        // so npm/shell child processes are terminated together with their parent.
        process.kill(-pid, signal)
        return
      } catch {
        // Fall back to killing the spawned shell process directly.
      }
    }

    childProcess.kill(signal)
  }

  private async _isNextProject (
    projectDir: string,
    meta?: Record<string, unknown>,
    backendConfig?: Record<string, unknown>
  ): Promise<boolean> {
    if (meta?.framework === 'nextjs') {
      return true
    }

    const command = backendConfig?.command
    if (typeof command === 'string' && command.includes('.next/standalone/server.js')) {
      return true
    }

    const packageJsonPath = path.join(projectDir, 'package.json')
    if (!existsSync(packageJsonPath)) {
      return false
    }

    try {
      const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8')) as Record<string, unknown>
      const deps: Record<string, string> = {
        ...((pkg.dependencies || {}) as Record<string, string>),
        ...((pkg.devDependencies || {}) as Record<string, string>)
      }
      return typeof deps.next === 'string'
    } catch {
      return false
    }
  }

  private async _ensureNextProjectReady (
    projectId: string,
    projectDir: string,
    packageJsonPath: string
  ): Promise<void> {
    if (_hasStandaloneBuild(projectDir)) {
      return
    }

    if (!existsSync(packageJsonPath)) {
      throw new Error('Next.js project is missing package.json, cannot rebuild standalone output.')
    }

    const nodeModulesPath = path.join(projectDir, 'node_modules')
    if (!existsSync(nodeModulesPath)) {
      console.log(`[RuntimeManager] Installing dependencies for Next.js project ${projectId} before build...`)
      await this.installDeps(projectId)
    }

    if (!this.builderService) {
      throw new Error('Next.js project is missing standalone output and no builder service is configured.')
    }

    console.log(`[RuntimeManager] Standalone build missing for ${projectId}, rebuilding before start...`)
    const buildResult = await this.builderService.build(projectId)
    if (!buildResult.success || !_hasStandaloneBuild(projectDir)) {
      const buildOutput = buildResult.output?.trim()
      throw new Error(`Next.js standalone build failed before start.${buildOutput ? `\n${buildOutput}` : ''}`)
    }
  }

  private _resolveNodeEnv (command: string, isStandalone: boolean, isNextProject: boolean): string {
    if (isStandalone) {
      return 'production'
    }

    if (command.includes('npm run dev') || command.includes('next dev')) {
      return 'development'
    }

    if (isNextProject) {
      return 'production'
    }

    return 'development'
  }

  /**
   * Extract a port number from a script command string.
   * Handles patterns like: -p 8080, --port 8080, --port=8080, -p8080
   */
  private _extractPortFromScript (script: string): number | null {
    // Match -p 8080, --port 8080, --port=8080
    const match = script.match(/(?:-p|--port)[=\s]+(\d+)/)
    if (match) {
      return parseInt(match[1], 10)
    }
    // Match -p8080 (no space)
    const shortMatch = script.match(/-p(\d+)/)
    if (shortMatch) {
      return parseInt(shortMatch[1], 10)
    }
    return null
  }

  /**
   * Replace a hardcoded port number in a command with the `$PORT` shell variable.
   * Only replaces port values that appear directly after known port flags to avoid
   * accidental substitutions in other parts of the command.
   */
  private _replacePortInCommand (command: string, port: number): string {
    const p = String(port)
    // --port=3000, --port 3000
    let result = command.replace(new RegExp(`(--port[=\\s])${p}\\b`), '$1$PORT')
    // -p 3000
    result = result.replace(new RegExp(`(-p\\s)${p}\\b`), '$1$PORT')
    // -p3000 (no space)
    result = result.replace(new RegExp(`(-p)${p}\\b`), '$1$PORT')
    return result
  }
}
