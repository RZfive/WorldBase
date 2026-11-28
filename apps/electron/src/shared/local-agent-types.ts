export type LocalAgentKind = 'codex' | 'claude' | 'opencode'

export interface LocalAgentProfile {
  agentId: string
  kind: LocalAgentKind
  name: string
  description: string
  executablePath: string
  version?: string
  available: boolean
  supportsResume: boolean
  supportsStructuredEvents: boolean
  supportsSessionDiscovery: boolean
}

export interface LocalAgentSessionSummary {
  agentId: string
  sessionId: string
  title: string
  cwd?: string
  updatedAt?: string
  status?: string
}

export interface LocalAgentSession {
  agentId: string
  sessionId: string
  updatedAt: string
}

export interface RoomLocalWorkspace {
  path: string
  source: 'group' | 'task' | 'project' | 'room'
}

export interface RoomLocalWorkerOptions {
  role: string
  instructions?: string
  exitAfterTask: boolean
}

export interface RoomLocalWorker extends RoomLocalWorkerOptions {
  id: string
  kind: LocalAgentKind
}

export function roomLocalWorkerName (worker: Pick<RoomLocalWorker, 'id' | 'role'>): string {
  return `${worker.role}-${worker.id.split('_').at(-1)?.slice(0, 8)}`
}
