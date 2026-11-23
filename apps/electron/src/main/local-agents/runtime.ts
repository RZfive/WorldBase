import { spawn, type ChildProcess } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import type { LocalAgentProfile } from '../../shared/local-agent-types.js'
import type { LocalAgentRegistry } from './registry.js'
import { parseLocalAgentCliLine } from './cli-parser.js'

const RUN_TIMEOUT_MS = 20 * 60 * 1000
const MAX_OUTPUT_CHARS = 24_000
const MAX_STDERR_CHARS = 4_000
const MAX_EVENT_CHARS = 1_000_000

export interface LocalAgentRunRequest {
  groupId: string
  agentId: string
  prompt: string
  workspaceRoot: string
  contextDirectory?: string
  allowWorkspaceWrites: boolean
  abortSignal?: AbortSignal
  onEvent?: (event: { kind: 'progress' | 'tool' | 'thinking'; detail: string; sessionId?: string }) => void
}

export interface LocalAgentRunResult {
  text: string
  sessionId?: string
}

export function commandFor (profile: LocalAgentProfile, prompt: string, sessionId: string | undefined, allowWorkspaceWrites: boolean, contextDirectory?: string): { args: string[]; stdin?: string } {
  if (profile.kind === 'codex') {
    return {
      args: [
        '-c', `sandbox_mode="${allowWorkspaceWrites ? 'workspace-write' : 'read-only'}"`,
        '-a', 'never', 'exec', ...(sessionId ? ['resume'] : []), '--json', '--skip-git-repo-check',
        ...(sessionId ? ['--', sessionId] : []), '-'
      ],
      stdin: prompt
    }
  }
  if (profile.kind === 'claude') {
    return {
      args: [
        '-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none',
        '--permission-mode', allowWorkspaceWrites ? 'acceptEdits' : 'plan',
        ...(contextDirectory ? ['--add-dir', contextDirectory] : []),
        ...(sessionId ? ['--resume', sessionId] : [])
      ],
      stdin: prompt
    }
  }
  return {
    args: [
      'run', '--format', 'json', '--dir', '.',
      ...(allowWorkspaceWrites ? [] : ['--agent', 'plan']),
      ...(sessionId ? ['--session', sessionId] : []),
      '--', prompt
    ]
  }
}

function appendBounded (previous: string, next: string, maximum: number): string {
  return `${previous}${next}`.slice(-maximum)
}

function stopProcessTree (child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') {
      const stop = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      stop.once('error', () => { child.kill(signal) })
    } else {
      process.kill(-child.pid, signal)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal)
  }
}

export async function runLocalAgent (request: LocalAgentRunRequest, registry: LocalAgentRegistry): Promise<LocalAgentRunResult> {
  request.abortSignal?.throwIfAborted()
  const profile = await registry.get(request.agentId)
  if (!profile || !profile.available || !profile.executablePath) {
    throw new Error(`Local agent is unavailable: ${request.agentId}`)
  }
  const workspaceRoot = await realpath(request.workspaceRoot)
  request.abortSignal?.throwIfAborted()
  const release = registry.reserveRun(request.groupId, request.agentId, workspaceRoot)
  try {
    const previous = registry.getSession(request.groupId, request.agentId, workspaceRoot)
    return await executeLocalAgent(request, profile, workspaceRoot, previous?.sessionId, sessionId => {
      registry.saveSession(request.groupId, request.agentId, workspaceRoot, sessionId)
    })
  } finally {
    release()
  }
}

async function executeLocalAgent (
  request: LocalAgentRunRequest,
  profile: LocalAgentProfile,
  workspaceRoot: string,
  previousSessionId: string | undefined,
  saveSession: (sessionId: string) => void
): Promise<LocalAgentRunResult> {
  const command = commandFor(profile, request.prompt, previousSessionId, request.allowWorkspaceWrites, request.contextDirectory)
  const env = { ...process.env }
  if (profile.kind === 'opencode') {
    let permission: Record<string, unknown> = {}
    try {
      const configured = JSON.parse(env.OPENCODE_PERMISSION || '{}')
      if (configured && typeof configured === 'object' && !Array.isArray(configured)) permission = configured
    } catch {
      permission = {}
    }
    if (!request.allowWorkspaceWrites) permission = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' }
    if (request.contextDirectory) {
      const external = permission.external_directory
      permission.external_directory = {
        ...(external && typeof external === 'object' ? external : { '*': typeof external === 'string' ? external : 'ask' }),
        [`${request.contextDirectory}/*`]: 'allow'
      }
    }
    env.OPENCODE_PERMISSION = JSON.stringify(permission)
  }
  const child = spawn(profile.executablePath, command.args, {
    cwd: workspaceRoot,
    env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  let settled = false
  let stdoutBuffer = ''
  let discardLine = false
  let stderr = ''
  let response = ''
  let completedResponse = ''
  let sessionId = previousSessionId
  let failure: Error | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const stop = (error: Error) => {
    if (killTimer) return
    failure = error
    stopProcessTree(child, 'SIGTERM')
    killTimer = setTimeout(() => stopProcessTree(child, 'SIGKILL'), 1500)
  }
  const abort = () => stop(request.abortSignal?.reason instanceof Error ? request.abortSignal.reason : new Error('Local Agent turn stopped.'))
  const timer = setTimeout(() => stop(new Error(`Local agent timed out: ${profile.name}`)), RUN_TIMEOUT_MS)
  const consume = (line: string) => {
    if (line.length > MAX_EVENT_CHARS) return
    const event = parseLocalAgentCliLine(profile.kind, line)
    if (!event) return
    if (event.sessionId && event.sessionId !== sessionId) {
      saveSession(event.sessionId)
      sessionId = event.sessionId
    }
    if (event.error) failure ||= new Error(`${profile.name}: ${event.error.slice(0, MAX_STDERR_CHARS)}`)
    if (event.thinking) request.onEvent?.({ kind: 'thinking', detail: event.thinking.slice(0, MAX_OUTPUT_CHARS), sessionId })
    if (event.text) {
      if (event.responseComplete) completedResponse = event.text.slice(-MAX_OUTPUT_CHARS)
      else response = appendBounded(response, `${event.text}\n`, MAX_OUTPUT_CHARS)
    }
    if (event.toolName) {
      const detail = [event.toolName, event.detail].filter(Boolean).join(': ').slice(0, 400)
      request.onEvent?.({ kind: 'tool', detail, sessionId })
    }
  }

  return await new Promise<LocalAgentRunResult>((resolve, reject) => {
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) {
        clearTimeout(killTimer)
        if (process.platform !== 'win32') stopProcessTree(child, 'SIGKILL')
      }
      request.abortSignal?.removeEventListener('abort', abort)
      callback()
    }
    child.once('error', error => finish(() => reject(error)))
    child.stdin.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk, MAX_STDERR_CHARS)
    })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      try {
        const lines = (stdoutBuffer + chunk).split('\n')
        stdoutBuffer = lines.pop() || ''
        for (const line of lines) {
          if (!discardLine) consume(line)
          discardLine = false
        }
        if (stdoutBuffer.length > MAX_EVENT_CHARS || discardLine) {
          discardLine = true
          stdoutBuffer = ''
        }
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.once('close', (code, signal) => {
      try {
        if (!discardLine && stdoutBuffer.trim()) consume(stdoutBuffer)
      } catch (error) {
        finish(() => reject(error))
        return
      }
      finish(() => {
        if (failure) return reject(failure)
        if (code !== 0) return reject(new Error(`${profile.name} exited (${code ?? signal}): ${stderr.trim()}`))
        const output = completedResponse.trim() || response.trim()
        if (!output) return reject(new Error(`${profile.name} returned no assistant text.`))
        resolve({ text: output, sessionId })
      })
    })
    request.abortSignal?.addEventListener('abort', abort, { once: true })
    if (request.abortSignal?.aborted) abort()
    else request.onEvent?.({ kind: 'progress', detail: `Started ${profile.name}`, sessionId })
    if (command.stdin !== undefined) child.stdin.end(command.stdin)
    else child.stdin.end()
  })
}
