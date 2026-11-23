import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LocalAgentKind, LocalAgentProfile, LocalAgentSession, LocalAgentSessionSummary } from '../../shared/local-agent-types.js'
import { parseLocalAgentSessions } from './session-parser.js'
import { listCodexSessions } from './codex-sessions.js'

const execFileAsync = promisify(execFile)
const LOCAL_AGENT_PREFIX = 'local_cli_'
const LOCAL_WORKER_ID = /^local_worker_(codex|claude|opencode)_[0-9a-f]{32}$/

export function localAgentId (kind: LocalAgentKind): string {
  return `${LOCAL_AGENT_PREFIX}${kind}`
}

export function localAgentKindFromId (id: string): LocalAgentKind | null {
  if (!id.startsWith(LOCAL_AGENT_PREFIX)) return null
  const kind = id.slice(LOCAL_AGENT_PREFIX.length)
  return kind === 'codex' || kind === 'claude' || kind === 'opencode' ? kind : null
}

function localSessionKind (id: string): LocalAgentKind | null {
  const workerKind = LOCAL_WORKER_ID.exec(id)?.[1] as LocalAgentKind | undefined
  return localAgentKindFromId(id) || workerKind || null
}

const CATALOG: Array<Omit<LocalAgentProfile, 'executablePath' | 'available' | 'version'>> = [
  {
    agentId: localAgentId('codex'),
    kind: 'codex',
    name: 'Codex CLI',
    description: 'OpenAI Codex coding agent; JSONL events and resumable sessions.',
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsSessionDiscovery: true
  },
  {
    agentId: localAgentId('claude'),
    kind: 'claude',
    name: 'Claude Code CLI',
    description: 'Claude Code coding agent; JSON events and resumable sessions.',
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsSessionDiscovery: true
  },
  {
    agentId: localAgentId('opencode'),
    kind: 'opencode',
    name: 'OpenCode CLI',
    description: 'OpenCode coding agent; JSON events and resumable sessions.',
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsSessionDiscovery: true
  }
]

async function executableVersion (executablePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(executablePath, ['--version'], { timeout: 5_000, windowsHide: true })
    return stdout.trim().split('\n')[0]?.trim() || undefined
  } catch {
    return undefined
  }
}

export class LocalAgentRegistry {
  private readonly sessionFile: string
  private discoveryPromise?: Promise<LocalAgentProfile[]>
  private readonly activeRuns = new Set<string>()

  constructor (userDataPath: string) {
    const dir = path.join(userDataPath, 'local-agents')
    fs.mkdirSync(dir, { recursive: true })
    this.sessionFile = path.join(dir, 'sessions.json')
  }

  async discover (): Promise<LocalAgentProfile[]> {
    this.discoveryPromise ||= this.probe()
    try {
      return await this.discoveryPromise
    } finally {
      this.discoveryPromise = undefined
    }
  }

  private async probe (): Promise<LocalAgentProfile[]> {
    const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(entry => path.isAbsolute(entry))
    return await Promise.all(CATALOG.map(async profile => {
      let executablePath = ''
      for (const entry of pathEntries) {
        const candidate = path.join(entry, process.platform === 'win32' ? `${profile.kind}.exe` : profile.kind)
        try {
          fs.accessSync(candidate, fs.constants.X_OK)
          if (!fs.statSync(candidate).isFile()) continue
          executablePath = candidate
          break
        } catch {
          continue
        }
      }
      return {
        ...profile,
        executablePath,
        available: Boolean(executablePath),
        version: executablePath ? await executableVersion(executablePath) : undefined
      }
    }))
  }

  async get (agentId: string): Promise<LocalAgentProfile | null> {
    const kind = localSessionKind(agentId)
    return kind ? (await this.discover()).find(profile => profile.kind === kind) || null : null
  }

  async discoverSessions (agentId: string, workspaceRoot: string): Promise<LocalAgentSessionSummary[]> {
    const profile = await this.get(agentId)
    if (!profile?.available || !profile.supportsSessionDiscovery) return []
    const args = profile.kind === 'claude'
      ? ['agents', '--json', '--all', '--cwd', workspaceRoot]
      : ['session', 'list', '--format', 'json', '--max-count', '100']
    let stdout: string
    try {
      if (profile.kind === 'codex') {
        stdout = await listCodexSessions(profile.executablePath, workspaceRoot)
      } else {
        ({ stdout } = await execFileAsync(profile.executablePath, args, {
          cwd: workspaceRoot,
          timeout: 10_000,
          windowsHide: true,
          maxBuffer: 2 * 1024 * 1024
        }))
      }
    } catch (error) {
      const failure = error as { code?: string | number; stderr?: string; message?: string }
      const detail = failure.stderr?.trim().slice(-1000) || failure.code || failure.message || 'unknown error'
      throw new Error(`${profile.name} could not list sessions: ${detail}`)
    }
    const root = fs.realpathSync(workspaceRoot)
    const claimed = new Set(Object.values(this.readSessions()).filter(session => localSessionKind(session.agentId) === profile.kind).map(session => session.sessionId))
    return parseLocalAgentSessions(profile.kind, stdout).filter(session => {
      if (claimed.has(session.sessionId) || !session.cwd) return false
      try {
        return fs.realpathSync(session.cwd) === root
      } catch {
        return false
      }
    })
  }

  getSession (groupId: string, agentId: string, cwd: string): LocalAgentSession | null {
    return this.readSessions()[this.sessionKey(groupId, agentId, cwd)] || null
  }

  saveSession (groupId: string, agentId: string, cwd: string, sessionId: string): void {
    const kind = localSessionKind(agentId)
    sessionId = sessionId.trim()
    if (!groupId || !kind || !sessionId) throw new Error('Invalid local Agent session.')
    const key = this.sessionKey(groupId, agentId, cwd)
    const sessions = this.readSessions()
    if (Object.entries(sessions).some(([entry, value]) => entry !== key && localSessionKind(value.agentId) === kind && value.sessionId === sessionId)) {
      throw new Error('This session is already assigned to another room or workspace.')
    }
    sessions[key] = {
      agentId,
      sessionId,
      updatedAt: new Date().toISOString()
    }
    this.writeSessions(sessions)
  }

  releaseWorkerSessions (groupId: string, workerId: string): void {
    if (!LOCAL_WORKER_ID.test(workerId)) throw new Error('Invalid local worker ID.')
    this.releaseSessions([groupId, workerId])
  }

  releaseRoomSessions (groupId: string): void {
    this.releaseSessions([groupId])
  }

  private releaseSessions (identity: string[]): void {
    const prefix = `${JSON.stringify(identity).slice(0, -1)},`
    if ([...this.activeRuns].some(key => key.startsWith(prefix))) throw new Error('A local Agent is still running.')
    const sessions = this.readSessions()
    const keys = Object.keys(sessions).filter(key => key.startsWith(prefix))
    for (const key of keys) delete sessions[key]
    if (keys.length) this.writeSessions(sessions)
  }

  reserveRun (groupId: string, agentId: string, cwd: string): () => void {
    const key = this.sessionKey(groupId, agentId, cwd)
    if (this.activeRuns.has(key)) throw new Error('This local Agent is already working in the room.')
    this.activeRuns.add(key)
    return () => { this.activeRuns.delete(key) }
  }

  bindSession (groupId: string, agentId: string, cwd: string, sessionId: string): void {
    if (this.activeRuns.has(this.sessionKey(groupId, agentId, cwd))) {
      throw new Error('Stop the current local Agent turn before changing its session.')
    }
    this.saveSession(groupId, agentId, cwd, sessionId)
  }

  private sessionKey (groupId: string, agentId: string, cwd: string): string {
    return JSON.stringify([groupId, agentId, path.resolve(cwd)])
  }

  private writeSessions (sessions: Record<string, LocalAgentSession>): void {
    const temporary = `${this.sessionFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(sessions, null, 2), 'utf-8')
    fs.renameSync(temporary, this.sessionFile)
  }

  private readSessions (): Record<string, LocalAgentSession> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sessionFile, 'utf-8')) as Record<string, LocalAgentSession>
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
}
