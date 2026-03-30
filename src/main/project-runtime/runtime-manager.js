import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { PortManager } from './port-manager.js'
import { ProcessMonitor } from './process-monitor.js'

/**
 * RuntimeManager — 子项目进程生命周期管理
 */
export class RuntimeManager {
  constructor (projectsDir) {
    this.projectsDir = projectsDir
    this.portManager = new PortManager()
    this.processMonitor = new ProcessMonitor()

    /** @type {Map<string, {process: ChildProcess, port: number, status: string}>} */
    this.runningProjects = new Map()
  }

  /**
   * Start a project's backend process.
   */
  async start (projectId) {
    if (this.runningProjects.has(projectId)) {
      const existing = this.runningProjects.get(projectId)
      if (existing.status === 'running') {
        return { projectId, port: existing.port, status: 'already_running' }
      }
    }

    const projectDir = path.join(this.projectsDir, projectId)
    const metaPath = path.join(projectDir, '.world-meta.json')

    if (!existsSync(metaPath)) {
      throw new Error(`Project meta not found: ${projectId}`)
    }

    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    const backendConfig = meta.runtime?.backend

    if (!backendConfig) {
      throw new Error(`No backend configuration for project: ${projectId}`)
    }

    // Allocate a port
    const port = await this.portManager.allocate(projectId, backendConfig.port)

    // Determine working directory and command
    const cwd = backendConfig.cwd
      ? path.join(projectDir, backendConfig.cwd)
      : projectDir

    const command = backendConfig.command || 'node server.js'
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

    const projectInfo = {
      process: childProcess,
      port,
      status: 'starting',
      logs: [],
      startedAt: new Date().toISOString()
    }

    // Capture stdout/stderr
    childProcess.stdout.on('data', (data) => {
      const line = data.toString()
      projectInfo.logs.push({ type: 'stdout', text: line, time: Date.now() })
      // Keep only last 500 log lines
      if (projectInfo.logs.length > 500) {
        projectInfo.logs = projectInfo.logs.slice(-500)
      }
    })

    childProcess.stderr.on('data', (data) => {
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
  async stop (projectId) {
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
  async restart (projectId) {
    await this.stop(projectId)
    return this.start(projectId)
  }

  /**
   * Stop all running projects.
   */
  async stopAll () {
    const promises = []
    for (const [projectId] of this.runningProjects) {
      promises.push(this.stop(projectId))
    }
    await Promise.allSettled(promises)
  }

  /**
   * Get the status of a project.
   */
  getStatus (projectId) {
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
  getPort (projectId) {
    const info = this.runningProjects.get(projectId)
    if (!info || info.status !== 'running') {
      return null
    }
    return info.port
  }

  /**
   * Get recent logs for a project.
   */
  getLogs (projectId, lines = 50) {
    const info = this.runningProjects.get(projectId)
    if (!info) {
      return []
    }
    return info.logs.slice(-lines)
  }

  /**
   * Install dependencies for a project.
   */
  async installDeps (projectId) {
    const projectDir = path.join(this.projectsDir, projectId)
    const meta = JSON.parse(await fs.readFile(path.join(projectDir, '.world-meta.json'), 'utf-8'))

    const cwd = meta.runtime?.backend?.cwd
      ? path.join(projectDir, meta.runtime.backend.cwd)
      : projectDir

    return new Promise((resolve, reject) => {
      const child = spawn('npm', ['install'], {
        cwd,
        stdio: 'pipe',
        shell: true
      })

      let output = ''
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { output += data.toString() })

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
}
