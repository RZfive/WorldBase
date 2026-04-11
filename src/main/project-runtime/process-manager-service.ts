import { spawn } from 'node:child_process'
import type { RuntimeManager } from './runtime-manager.js'
import type { ProjectFS } from '../project-fs/project-fs.js'

export interface ManagedProcessInfo {
  projectId: string
  projectName: string
  status: string
  pid?: number
  port?: number
  startedAt?: string
  uptimeSeconds?: number
  memoryRssBytes?: number
  exitCode?: number | null
  error?: string
}

export interface OrphanProcessInfo {
  pid: number
  name: string
  memoryRssBytes: number
  commandLine: string
  /** The port this process is listening on, if detectable */
  listeningPort?: number
}

export interface ProcessManagerSnapshot {
  managed: ManagedProcessInfo[]
  orphans: OrphanProcessInfo[]
  fetchedAt: string
}

/**
 * ProcessManagerService — 精细化进程管理
 *
 * Provides operations to inspect, restart, stop, and force-kill managed project
 * processes as well as discover orphaned child processes left over from previous
 * sessions (e.g. node processes listening on ports in the 3100-3999 range).
 */
export class ProcessManagerService {
  private runtimeManager: RuntimeManager
  private projectFS: ProjectFS

  constructor (runtimeManager: RuntimeManager, projectFS: ProjectFS) {
    this.runtimeManager = runtimeManager
    this.projectFS = projectFS
  }

  /**
   * Build a full snapshot of managed processes and orphans.
   */
  async getSnapshot (): Promise<ProcessManagerSnapshot> {
    const [managed, orphans] = await Promise.all([
      this._getManagedProcesses(),
      this._findOrphanProcesses()
    ])

    return {
      managed,
      orphans,
      fetchedAt: new Date().toISOString()
    }
  }

  /**
   * Restart a managed project by id.
   */
  async restartProject (projectId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.runtimeManager.restart(projectId)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /**
   * Stop a managed project by id.
   */
  async stopProject (projectId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.runtimeManager.stop(projectId)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /**
   * Force-kill an orphan process by PID.
   */
  async killOrphanProcess (pid: number): Promise<{ success: boolean; error?: string }> {
    try {
      if (process.platform === 'win32') {
        await this._execCommand('taskkill', ['/pid', String(pid), '/t', '/f'])
      } else {
        process.kill(pid, 'SIGKILL')
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /**
   * Force kill a managed project by id — bypasses the graceful stop flow.
   */
  async forceKillProject (projectId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const snapshot = this.runtimeManager.getProjectProcesses().find(p => p.projectId === projectId)
      if (!snapshot?.pid) {
        return { success: false, error: 'Process not found or already exited' }
      }
      if (process.platform === 'win32') {
        await this._execCommand('taskkill', ['/pid', String(snapshot.pid), '/t', '/f'])
      } else {
        process.kill(-snapshot.pid, 'SIGKILL')
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  // ── Private ──

  private async _getManagedProcesses (): Promise<ManagedProcessInfo[]> {
    const projects = await this.projectFS.listProjects()
    const processSnapshots = this.runtimeManager.getProjectProcesses()
    const projectNameMap = new Map(projects.map(p => [p.id, p.name || p.id]))

    // Resolve per-pid RSS memory on Windows using tasklist
    const pidList = processSnapshots
      .filter(p => p.pid && (p.status === 'running' || p.status === 'starting'))
      .map(p => p.pid!)
    const memoryMap = pidList.length > 0 ? await this._getProcessMemory(pidList) : new Map<number, number>()

    return processSnapshots.map(snap => ({
      projectId: snap.projectId,
      projectName: projectNameMap.get(snap.projectId) || snap.projectId,
      status: snap.status,
      pid: snap.pid,
      port: snap.port,
      startedAt: snap.startedAt,
      uptimeSeconds: snap.uptimeSeconds,
      memoryRssBytes: snap.pid ? memoryMap.get(snap.pid) : undefined,
      exitCode: snap.exitCode,
      error: snap.error
    }))
  }

  /**
   * Discover orphaned node processes that are NOT tracked by RuntimeManager.
   * On Windows uses `wmic` / `tasklist`; on Unix uses `ps`.
   */
  private async _findOrphanProcesses (): Promise<OrphanProcessInfo[]> {
    const managedPids = new Set(
      this.runtimeManager.getProjectProcesses()
        .filter(p => p.pid)
        .map(p => p.pid!)
    )
    // Also exclude the host process itself
    managedPids.add(process.pid)

    try {
      if (process.platform === 'win32') {
        return await this._findOrphansWindows(managedPids)
      } else {
        return await this._findOrphansUnix(managedPids)
      }
    } catch {
      return []
    }
  }

  private async _findOrphansWindows (managedPids: Set<number>): Promise<OrphanProcessInfo[]> {
    // Get node processes with memory info
    const output = await this._execCommand('wmic', [
      'process', 'where',
      "name like '%node%'",
      'get', 'ProcessId,Name,CommandLine,WorkingSetSize',
      '/format:csv'
    ])

    const orphans: OrphanProcessInfo[] = []
    const lines = output.split('\n').filter(l => l.trim())

    for (const line of lines) {
      // CSV format: Node,CommandLine,Name,ProcessId,WorkingSetSize
      const parts = line.split(',')
      if (parts.length < 5) continue

      const pid = parseInt(parts[parts.length - 2], 10)
      if (!pid || isNaN(pid) || managedPids.has(pid)) continue

      const commandLine = parts.slice(1, parts.length - 3).join(',')
      const name = parts[parts.length - 3] || 'node'
      const workingSet = parseInt(parts[parts.length - 1], 10)

      // Only include processes that look like they could be project-related
      if (!this._looksLikeProjectProcess(commandLine)) continue

      orphans.push({
        pid,
        name,
        memoryRssBytes: isNaN(workingSet) ? 0 : workingSet,
        commandLine: commandLine.slice(0, 200)
      })
    }

    return orphans
  }

  private async _findOrphansUnix (managedPids: Set<number>): Promise<OrphanProcessInfo[]> {
    const output = await this._execCommand('ps', [
      'ax', '-o', 'pid,rss,comm,args'
    ])

    const orphans: OrphanProcessInfo[] = []
    const lines = output.split('\n').filter(l => l.trim())

    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
      if (!match) continue

      const pid = parseInt(match[1], 10)
      const rssKb = parseInt(match[2], 10)
      const comm = match[3]
      const args = match[4]

      if (!pid || managedPids.has(pid)) continue
      if (!comm.includes('node')) continue
      if (!this._looksLikeProjectProcess(args)) continue

      orphans.push({
        pid,
        name: comm,
        memoryRssBytes: rssKb * 1024,
        commandLine: args.slice(0, 200)
      })
    }

    return orphans
  }

  /**
   * Heuristic: does this command line look like a project process spawned by TheWorld?
   */
  private _looksLikeProjectProcess (commandLine: string): boolean {
    const lower = commandLine.toLowerCase()
    return (
      lower.includes('the_world') ||
      lower.includes('the-world') ||
      lower.includes('server.js') ||
      lower.includes('next') ||
      lower.includes('http-server') ||
      // Port range used by our PortManager (3100-3999)
      /\bport[=\s]*3[1-9]\d{2}\b/i.test(commandLine) ||
      /\b-p\s*3[1-9]\d{2}\b/i.test(commandLine)
    )
  }

  /**
   * Get RSS memory usage for a list of PIDs.
   */
  private async _getProcessMemory (pids: number[]): Promise<Map<number, number>> {
    const memMap = new Map<number, number>()
    try {
      if (process.platform === 'win32') {
        // Use tasklist with filters for each PID
        const pidFilter = pids.map(p => `/fi "PID eq ${p}"`).join(' ')
        const output = await this._execCommand('tasklist', [
          '/fo', 'csv', '/nh', ...pids.flatMap(p => ['/fi', `PID eq ${p}`])
        ])
        for (const line of output.split('\n')) {
          const match = line.match(/"[^"]*","(\d+)","[^"]*","[^"]*","([\d,]+)\s*K"/)
          if (match) {
            const pid = parseInt(match[1], 10)
            const memKb = parseInt(match[2].replace(/,/g, ''), 10)
            memMap.set(pid, memKb * 1024)
          }
        }
      } else {
        const output = await this._execCommand('ps', [
          '-o', 'pid,rss', '-p', pids.join(',')
        ])
        for (const line of output.split('\n')) {
          const match = line.trim().match(/^(\d+)\s+(\d+)$/)
          if (match) {
            memMap.set(parseInt(match[1], 10), parseInt(match[2], 10) * 1024)
          }
        }
      }
    } catch {
      // Non-fatal — memory info is best-effort
    }
    return memMap
  }

  private _execCommand (command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'pipe', shell: true })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
      child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })
      child.on('exit', (code) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`${command} exited with code ${code}: ${stderr}`))
      })
      child.on('error', reject)
    })
  }
}
