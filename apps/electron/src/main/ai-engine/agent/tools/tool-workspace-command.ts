import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PROJECT_COMMAND_WHITELIST, DANGEROUS_COMMAND_PATTERNS, isDeveloperCommandModeEnabled } from './command-capabilities.js'
import { createBundledRuntimeEnv } from '../../../project-runtime/bundled-runtime.js'
import { scanCommandSegments, splitCommandSegments, tokenizeCommand } from './command-parser.js'
import type { ProgressCallback } from '../agent-core.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import { resolveFolderWorkspacePath } from '../../../folder-workspace/folder-workspace-fs.js'
import type { ToolServices } from './index.js'

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

interface RunWorkspaceCommandArgs {
  command: string
  cwd?: string
  timeout_seconds?: number
}

interface GetWorkspaceCommandStatusArgs {
  command_id: string
}

interface ParsedCommand {
  baseCommand: string
  tokens: string[]
}

type CommandReason = 'completed' | 'spawn_error' | 'timeout' | 'output_limit'
type CommandStatus = 'running' | 'completed' | 'failed'

interface WorkspaceCommandSnapshot {
  command_id: string
  workspace_root: string
  command: string
  cwd: string
  pid?: number
  status: CommandStatus
  reason?: CommandReason
  created_at: string
  started_at: string
  completed_at?: string
  exitCode?: number | null
  signal?: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputTruncated: boolean
  background: boolean
  message?: string
  error?: string
}

interface WorkspaceCommandExecutionRecord extends WorkspaceCommandSnapshot {
  child: ChildProcess
}

const DEFAULT_TIMEOUT_SECONDS = 90
const MAX_TIMEOUT_SECONDS = 180
const HEARTBEAT_INTERVAL_MS = 10000
const MAX_STDOUT_CHARS = 20000
const MAX_STDERR_CHARS = 10000
const MAX_COMMAND_HISTORY = 100
const LONG_RUNNING_NPM_SCRIPTS = new Set(['dev', 'start', 'serve', 'preview', 'watch'])
const SAFE_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'branch'])

const commandHistory = new Map<string, WorkspaceCommandExecutionRecord>()
let commandSequence = 0

export function toolRunWorkspaceCommand (services: ToolServices): Tool {
  return {
    definition: {
      name: 'run_workspace_command',
      description: 'Run a short-lived install, build, test, lint, type-check, or diagnostic command inside the selected folder workspace. Do not start long-lived dev servers.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run, e.g. "npm test", "pnpm build", "npx tsc --noEmit".' },
          cwd: { type: 'string', description: 'Working subdirectory relative to the workspace root.' },
          timeout_seconds: { type: 'integer', description: `Foreground wait timeout. Default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}.` }
        },
        required: ['command']
      }
    },
    handler: async (args, onProgress) => {
      const { command, cwd, timeout_seconds } = args as unknown as RunWorkspaceCommandArgs
      if (!services.workspaceRoot) throw new Error('No folder workspace is selected for this conversation.')
      validateProjectLikeCommand(command)
      const timeoutSeconds = Math.min(Math.max(timeout_seconds || DEFAULT_TIMEOUT_SECONDS, 5), MAX_TIMEOUT_SECONDS)
      const workspaceRoot = path.resolve(services.workspaceRoot)
      const workDir = cwd ? resolveFolderWorkspacePath(workspaceRoot, cwd) : workspaceRoot
      const relativeWorkDir = path.relative(workspaceRoot, workDir)
      if (relativeWorkDir.startsWith('..') || path.isAbsolute(relativeWorkDir)) {
        throw new Error('Working directory must be within the selected workspace.')
      }

      onProgress?.('Running workspace command', `${command} (${timeoutSeconds}s)`)
      const env = await createBundledRuntimeEnv(workDir, {
        CI: 'true',
        GIT_TERMINAL_PROMPT: '0',
        NPM_CONFIG_AUDIT: 'false',
        NPM_CONFIG_FUND: 'false',
        npm_config_audit: 'false',
        npm_config_fund: 'false'
      })

      return await new Promise((resolve) => {
        const child = spawn(command, [], {
          cwd: workDir,
          shell: true,
          env,
          windowsHide: true,
          detached: process.platform !== 'win32'
        })

        const record: WorkspaceCommandExecutionRecord = {
          command_id: globalThis.crypto?.randomUUID?.() || `wcmd_${Date.now().toString(36)}_${(++commandSequence).toString(36)}`,
          workspace_root: workspaceRoot,
          command,
          cwd: workDir,
          pid: child.pid,
          status: 'running',
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          stdout: '',
          stderr: '',
          timedOut: false,
          outputTruncated: false,
          background: false,
          child
        }
        storeCommandRecord(record)

        let resolved = false
        let outputLimitTerminated = false
        let forceFinalizeHandle: NodeJS.Timeout | null = null
        const startedAt = Date.now()

        const cleanupForegroundTimers = () => {
          clearTimeout(timeoutHandle)
          clearInterval(heartbeatHandle)
          if (forceFinalizeHandle) clearTimeout(forceFinalizeHandle)
        }
        const resolveOnce = (payload: WorkspaceCommandSnapshot) => {
          if (resolved) return
          resolved = true
          cleanupForegroundTimers()
          resolve(payload)
        }
        const finalizeRecord = (status: CommandStatus, reason: CommandReason, exitCode: number | null, signal?: string | null, error?: string) => {
          record.status = status
          record.reason = reason
          record.exitCode = exitCode
          record.signal = signal ?? null
          record.error = error
          record.completed_at = new Date().toISOString()
          record.background = false
          record.message = undefined
          if (!resolved) resolveOnce(toCommandSnapshot(record))
        }
        const appendOutput = (current: string, chunk: Buffer, limit: number) => {
          const next = current + chunk.toString()
          if (next.length <= limit) return { value: next, truncated: false }
          return { value: next.slice(0, limit), truncated: true }
        }
        const terminateForOutputLimit = () => {
          if (outputLimitTerminated) return
          outputLimitTerminated = true
          record.outputTruncated = true
          record.reason = 'output_limit'
          onProgress?.('Workspace command output too long; terminating', command)
          void terminateProcessTree(child.pid)
          forceFinalizeHandle = setTimeout(() => {
            finalizeRecord('failed', 'output_limit', -1, null, 'Command output exceeded the capture limit and was terminated.')
          }, 5000)
        }

        const timeoutHandle = setTimeout(() => {
          record.reason = 'timeout'
          record.timedOut = true
          record.background = true
          record.status = 'running'
          record.message = 'Command exceeded the foreground wait timeout but is still running in the background. Use get_workspace_command_status with this command_id before retrying.'
          onProgress?.('Workspace command moved to background after timeout', `${timeoutSeconds}s: ${command}`)
          resolveOnce(toCommandSnapshot(record))
        }, timeoutSeconds * 1000)

        const heartbeatHandle = setInterval(() => {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
          onProgress?.('Workspace command still running', `${elapsedSeconds}s: ${command}`)
        }, HEARTBEAT_INTERVAL_MS)

        child.stdout?.on('data', (data: Buffer) => {
          const next = appendOutput(record.stdout, data, MAX_STDOUT_CHARS)
          record.stdout = next.value
          record.outputTruncated = record.outputTruncated || next.truncated
          if (next.truncated) terminateForOutputLimit()
        })
        child.stderr?.on('data', (data: Buffer) => {
          const next = appendOutput(record.stderr, data, MAX_STDERR_CHARS)
          record.stderr = next.value
          record.outputTruncated = record.outputTruncated || next.truncated
          if (next.truncated) terminateForOutputLimit()
        })
        child.on('close', (code, signal) => {
          if (outputLimitTerminated) {
            finalizeRecord('failed', 'output_limit', code ?? -1, signal, 'Command output exceeded the capture limit and was terminated.')
            return
          }
          const status = code === 0 ? 'completed' : 'failed'
          onProgress?.('Workspace command completed', `exit code: ${String(code ?? 0)}`)
          finalizeRecord(status, 'completed', code, signal, code === 0 ? undefined : `Command exited with code ${String(code)}`)
        })
        child.on('error', (err) => {
          onProgress?.('Workspace command failed', err.message)
          finalizeRecord('failed', 'spawn_error', -1, null, `Command failed: ${err.message}`)
        })
      })
    }
  }
}

export function toolGetWorkspaceCommandStatus (): Tool {
  return {
    definition: {
      name: 'get_workspace_command_status',
      description: 'Get the latest status and output for a command started by run_workspace_command.',
      parameters: {
        type: 'object',
        properties: {
          command_id: { type: 'string', description: 'Command execution ID returned by run_workspace_command' }
        },
        required: ['command_id']
      }
    },
    handler: async (args) => {
      const { command_id } = args as unknown as GetWorkspaceCommandStatusArgs
      const record = commandHistory.get(command_id)
      if (!record) throw new Error(`Workspace command not found: ${command_id}`)
      return toCommandSnapshot(record)
    }
  }
}

function storeCommandRecord (record: WorkspaceCommandExecutionRecord): void {
  commandHistory.set(record.command_id, record)
  if (commandHistory.size <= MAX_COMMAND_HISTORY) return
  const removableIds = Array.from(commandHistory.values())
    .filter(record => record.status !== 'running')
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .map(record => record.command_id)
  while (commandHistory.size > MAX_COMMAND_HISTORY && removableIds.length > 0) {
    const id = removableIds.shift()
    if (!id) break
    commandHistory.delete(id)
  }
}

function toCommandSnapshot (record: WorkspaceCommandExecutionRecord): WorkspaceCommandSnapshot {
  return {
    command_id: record.command_id,
    workspace_root: record.workspace_root,
    command: record.command,
    cwd: record.cwd,
    pid: record.pid,
    status: record.status,
    reason: record.reason,
    created_at: record.created_at,
    started_at: record.started_at,
    completed_at: record.completed_at,
    exitCode: record.exitCode,
    signal: record.signal,
    stdout: record.stdout,
    stderr: record.stderr,
    timedOut: record.timedOut,
    outputTruncated: record.outputTruncated,
    background: record.background,
    message: record.message,
    error: record.error
  }
}

function validateProjectLikeCommand (rawCommand: string): ParsedCommand {
  const command = rawCommand.trim()
  if (!command) throw new Error('Command must not be empty.')
  if (/[\r\n]/.test(command)) throw new Error('Run a single logical command without newlines.')
  if (/`|\$\(/.test(command)) throw new Error('Command substitution is not allowed.')
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error('Command was blocked as potentially destructive.')
    }
  }

  const developerMode = isDeveloperCommandModeEnabled()
  // Only shell syntax outside quoted/escaped text counts as an operator.
  const { hasOperator: hasShellOperators } = scanCommandSegments(command)
  if (hasShellOperators && !developerMode) {
    throw new Error('Command contains shell operators. Run one command per call or enable THE_WORLD_DEV_COMMANDS=1.')
  }

  const segments = developerMode ? splitCommandSegments(command) : [command]
  let firstParsed: ParsedCommand | null = null
  for (const segment of segments) {
    const parsed = validateSingleCommand(segment)
    if (!firstParsed) firstParsed = parsed
  }
  if (!firstParsed) throw new Error('Command must not be empty.')
  return firstParsed
}

function validateSingleCommand (segment: string): ParsedCommand {
  const tokens = tokenizeCommand(segment)
  if (tokens.length === 0) throw new Error('Command must not be empty.')
  const baseCommand = normalizeBaseCommand(tokens[0])
  if (!PROJECT_COMMAND_WHITELIST.includes(baseCommand)) {
    throw new Error(`Command not allowed: ${baseCommand}. Allowed: ${PROJECT_COMMAND_WHITELIST.join(', ')}.`)
  }
  if (baseCommand === 'npm') validateNpmCommand(tokens)
  else if (baseCommand === 'git') validateGitCommand(tokens)
  return { baseCommand, tokens }
}

function normalizeBaseCommand (token: string): string {
  return path.basename(token).replace(/\.(cmd|exe|bat)$/i, '').toLowerCase()
}

function validateNpmCommand (tokens: string[]): void {
  const subCommand = tokens[1]?.toLowerCase()
  if (!subCommand) throw new Error('npm command requires a subcommand.')
  if (subCommand === 'install' || subCommand === 'i' || subCommand === 'ci' || subCommand === 'test') return
  if (subCommand === 'run') {
    const scriptName = tokens[2]?.toLowerCase()
    if (!scriptName) throw new Error('npm run requires a script name.')
    if (LONG_RUNNING_NPM_SCRIPTS.has(scriptName)) {
      throw new Error(`npm run ${scriptName} is long-running. Do not use run_workspace_command for dev servers.`)
    }
    return
  }
  throw new Error('npm command is not allowed here.')
}

function validateGitCommand (tokens: string[]): void {
  const subCommand = tokens[1]?.toLowerCase() || 'status'
  if (!SAFE_GIT_SUBCOMMANDS.has(subCommand)) {
    throw new Error(`git ${subCommand} is not allowed. Allowed git subcommands: ${Array.from(SAFE_GIT_SUBCOMMANDS).join(', ')}.`)
  }
}

async function terminateProcessTree (pid?: number): Promise<void> {
  if (!pid) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.on('close', () => resolve())
      killer.on('error', () => {
        try {
          process.kill(pid)
        } catch { /* ignore */ }
        resolve()
      })
    })
    return
  }
  try {
    process.kill(-pid)
  } catch {
    try {
      process.kill(pid)
    } catch { /* ignore */ }
  }
}

