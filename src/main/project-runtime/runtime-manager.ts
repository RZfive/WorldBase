import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { PortManager } from './port-manager.js'
import { ProcessMonitor } from './process-monitor.js'

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
  startedAt?: string
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

/**
 * RuntimeManager — 子项目进程生命周期管理
 */
export class RuntimeManager {
  private projectsDir: string
  private portManager: PortManager
  private processMonitor: ProcessMonitor
  private runningProjects = new Map<string, ProjectRunInfo>()

  constructor (projectsDir: string) {
    this.projectsDir = projectsDir
    this.portManager = new PortManager()
    this.processMonitor = new ProcessMonitor()
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
    }

    const projectDir = path.join(this.projectsDir, projectId)
    const metaPath = path.join(projectDir, '.world-meta.json')

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

    // Auto-install dependencies if node_modules is missing
    const packageJsonPath = path.join(projectDir, 'package.json')
    const nodeModulesPath = path.join(projectDir, 'node_modules')
    if (existsSync(packageJsonPath) && !existsSync(nodeModulesPath)) {
      console.log(`[RuntimeManager] Auto-installing dependencies for ${projectId}...`)
      await this.installDeps(projectId)
      console.log(`[RuntimeManager] Dependencies installed for ${projectId}`)
    }

    // Allocate a port (prefer the port detected from the project's scripts)
    const port = await this.portManager.allocate(projectId, backendConfig.port as number | undefined)

    // Determine working directory and command
    const cwd = backendConfig.cwd
      ? path.join(projectDir, backendConfig.cwd as string)
      : projectDir

    const command = (backendConfig.command as string) || 'node server.js'
    const [cmd, ...args] = command.split(' ')

    // Spawn the process
    const env = {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development'
    }

    const childProcess = spawn(cmd, args, {
      cwd,
      env,
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

    // Wait for the process to be ready (simple delay + port check)
    await this.processMonitor.waitForReady(port, 10000)
    projectInfo.status = 'running'

    return { projectId, port, status: 'running' }
  }

  /**
   * Stop a project's backend process.
   */
  async stop (projectId: string): Promise<StopResult> {
    const info = this.runningProjects.get(projectId)
    if (!info || info.status !== 'running') {
      return { projectId, status: 'not_running' }
    }

    return new Promise((resolve) => {
      info.process.on('exit', () => {
        info.status = 'stopped'
        this.portManager.release(projectId)
        resolve({ projectId, status: 'stopped' })
      })

      info.process.kill('SIGTERM')

      // Force kill after 5 seconds
      setTimeout(() => {
        if (info.status === 'running') {
          info.process.kill('SIGKILL')
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
      startedAt: info.startedAt,
      exitCode: info.exitCode,
      error: info.error
    }
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

    return new Promise((resolve, reject) => {
      const child = spawn('npm', ['install'], {
        cwd,
        stdio: 'pipe',
        shell: true
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
    })
  }

  /**
   * Auto-detect runtime configuration from project files.
   */
  private async _detectRuntimeConfig (projectDir: string): Promise<Record<string, unknown> | null> {
    const packageJsonPath = path.join(projectDir, 'package.json')

    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8')) as Record<string, unknown>
        const scripts = (pkg.scripts || {}) as Record<string, string>

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
}
