import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { BuilderService } from '../../../project-runtime/builder-service.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import { PROJECT_COMMAND_WHITELIST } from './command-capabilities.js'
import { createBundledRuntimeEnv } from '../../../project-runtime/bundled-runtime.js'

interface ToolServices {
  projectFS: ProjectFS
  builderService: Pick<BuilderService, 'syncManualBuildState'>
}

interface RunCommandArgs {
  project_id: string
  command: string
  cwd?: string
  timeout_seconds?: number
}

interface GetProjectCommandStatusArgs {
  command_id: string
}

interface ParsedCommand {
  baseCommand: string
  tokens: string[]
}

type CommandReason = 'completed' | 'spawn_error' | 'timeout' | 'output_limit'
type CommandStatus = 'running' | 'completed' | 'failed'

interface ProjectCommandSnapshot {
  command_id: string
  project_id: string
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
  observedReadySignal: boolean
  background: boolean
  message?: string
  error?: string
  manualBuildStateSynced?: boolean
  manualBuildStateSyncReason?: string
}

interface CommandExecutionRecord extends ProjectCommandSnapshot {
  child: ChildProcess
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

const DEFAULT_TIMEOUT_SECONDS = 90
const MAX_TIMEOUT_SECONDS = 180
const HEARTBEAT_INTERVAL_MS = 10000
const MAX_STDOUT_CHARS = 20000
const MAX_STDERR_CHARS = 10000
const MAX_COMMAND_HISTORY = 100
const LONG_RUNNING_NPM_SCRIPTS = new Set(['dev', 'start', 'serve', 'preview', 'watch'])
const BUILD_NPM_SCRIPTS = new Set(['build'])
const SAFE_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'branch'])
const READY_SIGNAL_PATTERNS = [
  /\bready\b/i,
  /\blistening\b/i,
  /\bstarted server\b/i,
  /\bserver started\b/i,
  /已启动/i,
  /启动完成/i,
  /监听中/i,
  /服务已就绪/i
]

const commandHistory = new Map<string, CommandExecutionRecord>()
let commandSequence = 0

/**
 * Tool: run_project_command — 在指定项目目录执行命令
 */
export function toolRunCommand (services: ToolServices): Tool {
  return {
    definition: {
      name: 'run_project_command',
      description: 'Run a safe project command. If the foreground wait times out, the command keeps running in the background and returns a command_id for status checks.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          command: {
            type: 'string',
            description: 'Shell command'
          },
          cwd: {
            type: 'string',
            description: 'Working subdirectory (defaults to the project root)'
          },
          timeout_seconds: {
            type: 'integer',
            description: `Foreground wait timeout in seconds. Default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS}.`
          }
        },
        required: ['project_id', 'command']
      }
    },
    handler: async (args, onProgress) => {
      const { project_id, command, cwd, timeout_seconds } = args as unknown as RunCommandArgs
      const parsed = validateProjectCommand(command)
      const timeoutSeconds = Math.min(Math.max(timeout_seconds || DEFAULT_TIMEOUT_SECONDS, 5), MAX_TIMEOUT_SECONDS)

      onProgress?.('⚡ 正在执行命令...', `${command}（前台等待 ${timeoutSeconds}s）`)

      const projectDir = path.join(services.projectFS.projectsDir, project_id)
      const workDir = cwd ? path.join(projectDir, cwd) : projectDir

      const resolvedWorkDir = path.resolve(workDir)
      if (!resolvedWorkDir.startsWith(path.resolve(projectDir))) {
        throw new Error('Working directory must be within the project directory')
      }

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
          windowsHide: true
        })

        const record: CommandExecutionRecord = {
          command_id: globalThis.crypto?.randomUUID?.() || `cmd_${Date.now().toString(36)}_${(++commandSequence).toString(36)}`,
          project_id,
          command,
          cwd: resolvedWorkDir,
          pid: child.pid,
          status: 'running',
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          stdout: '',
          stderr: '',
          timedOut: false,
          outputTruncated: false,
          observedReadySignal: false,
          background: false,
          child
        }
        storeCommandRecord(record)

        let resolved = false
        let outputLimitTerminated = false
        let forceFinalizeHandle: NodeJS.Timeout | null = null
        const startedAt = Date.now()

        const updateReadySignal = () => {
          record.observedReadySignal = hasReadySignal(record.stdout, record.stderr)
        }

        const appendOutput = (current: string, chunk: Buffer, limit: number) => {
          const next = current + chunk.toString()
          if (next.length <= limit) {
            return { value: next, truncated: false }
          }
          return { value: next.slice(0, limit), truncated: true }
        }

        const cleanupForegroundTimers = () => {
          clearTimeout(timeoutHandle)
          clearInterval(heartbeatHandle)
          if (forceFinalizeHandle) {
            clearTimeout(forceFinalizeHandle)
            forceFinalizeHandle = null
          }
        }

        const resolveOnce = (payload: ProjectCommandSnapshot) => {
          if (resolved) return
          resolved = true
          cleanupForegroundTimers()
          resolve(payload)
        }

        const finalizeRecord = async (
          status: CommandStatus,
          reason: CommandReason,
          exitCode: number | null,
          signal?: string | null,
          error?: string
        ) => {
          record.status = status
          record.reason = reason
          record.exitCode = exitCode
          record.signal = signal ?? null
          record.error = error
          record.completed_at = new Date().toISOString()
          record.background = false
          record.message = undefined
          updateReadySignal()

          if (isSuccessfulManualBuild(parsed, record)) {
            try {
              const syncResult = await services.builderService.syncManualBuildState(project_id)
              record.manualBuildStateSynced = syncResult.synced
              if (!syncResult.synced && syncResult.reason) {
                record.manualBuildStateSyncReason = syncResult.reason
              }
            } catch (err) {
              record.manualBuildStateSynced = false
              record.manualBuildStateSyncReason = (err as Error).message
            }
          }

          if (!resolved) {
            resolveOnce(toCommandSnapshot(record))
          }
        }

        const terminateForOutputLimit = () => {
          if (outputLimitTerminated) return
          outputLimitTerminated = true
          record.outputTruncated = true
          record.reason = 'output_limit'
          onProgress?.('⚠️ 命令输出过长，正在终止...', parsed.baseCommand)
          void terminateProcessTree(child.pid)

          forceFinalizeHandle = setTimeout(() => {
            void finalizeRecord(
              'failed',
              'output_limit',
              -1,
              null,
              'Command output exceeded the capture limit and was terminated.'
            )
          }, 5000)
        }

        const timeoutHandle = setTimeout(() => {
          record.reason = 'timeout'
          record.timedOut = true
          record.background = true
          record.status = 'running'
          record.message = 'Command exceeded the foreground wait timeout but is still running in the background. This is NOT a crash — use get_project_command_status with this command_id to check progress before retrying.'
          updateReadySignal()
          onProgress?.('⏱️ 前台等待超时，命令转入后台继续执行', `${timeoutSeconds}s: ${command}`)
          resolveOnce(toCommandSnapshot(record))
        }, timeoutSeconds * 1000)

        const heartbeatHandle = setInterval(() => {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
          onProgress?.('⏳ 命令仍在执行...', `${elapsedSeconds}s: ${command}`)
        }, HEARTBEAT_INTERVAL_MS)

        child.stdout?.on('data', (data: Buffer) => {
          const next = appendOutput(record.stdout, data, MAX_STDOUT_CHARS)
          record.stdout = next.value
          record.outputTruncated = record.outputTruncated || next.truncated
          updateReadySignal()
          if (next.truncated) {
            terminateForOutputLimit()
          }
        })

        child.stderr?.on('data', (data: Buffer) => {
          const next = appendOutput(record.stderr, data, MAX_STDERR_CHARS)
          record.stderr = next.value
          record.outputTruncated = record.outputTruncated || next.truncated
          updateReadySignal()
          if (next.truncated) {
            terminateForOutputLimit()
          }
        })

        child.on('close', (code, signal) => {
          if (outputLimitTerminated) {
            onProgress?.('⚠️ 命令已终止', '输出过长')
            void finalizeRecord(
              'failed',
              'output_limit',
              code ?? -1,
              signal,
              'Command output exceeded the capture limit and was terminated.'
            )
            return
          }

          if (record.timedOut) {
            void finalizeRecord(
              code === 0 ? 'completed' : 'failed',
              'completed',
              code,
              signal,
              code === 0 ? undefined : `Command exited with code ${String(code)}`
            )
            return
          }

          onProgress?.('✅ 命令执行完成', `退出码: ${String(code ?? 0)}`)
          void finalizeRecord(
            code === 0 ? 'completed' : 'failed',
            'completed',
            code,
            signal,
            code === 0 ? undefined : `Command exited with code ${String(code)}`
          )
        })

        child.on('error', (err) => {
          onProgress?.('❌ 命令执行失败', err.message)
          void finalizeRecord('failed', 'spawn_error', -1, null, `Command failed: ${err.message}`)
        })
      })
    }
  }
}

export function toolGetProjectCommandStatus (): Tool {
  return {
    definition: {
      name: 'get_project_command_status',
      description: 'Get the latest status, output, and final result for a command started by run_project_command.',
      parameters: {
        type: 'object',
        properties: {
          command_id: {
            type: 'string',
            description: 'Command execution ID returned by run_project_command'
          }
        },
        required: ['command_id']
      }
    },
    handler: async (args) => {
      const { command_id } = args as unknown as GetProjectCommandStatusArgs
      const record = commandHistory.get(command_id)
      if (!record) {
        throw new Error(`Project command not found: ${command_id}`)
      }
      return toCommandSnapshot(record)
    }
  }
}

function storeCommandRecord (record: CommandExecutionRecord): void {
  commandHistory.set(record.command_id, record)
  pruneCommandHistory()
}

function pruneCommandHistory (): void {
  if (commandHistory.size <= MAX_COMMAND_HISTORY) {
    return
  }

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

function toCommandSnapshot (record: CommandExecutionRecord): ProjectCommandSnapshot {
  return {
    command_id: record.command_id,
    project_id: record.project_id,
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
    observedReadySignal: record.observedReadySignal,
    background: record.background,
    message: record.message,
    error: record.error,
    manualBuildStateSynced: record.manualBuildStateSynced,
    manualBuildStateSyncReason: record.manualBuildStateSyncReason
  }
}

function validateProjectCommand (rawCommand: string): ParsedCommand {
  const command = rawCommand.trim()
  if (!command) {
    throw new Error('Command must not be empty')
  }

  if (/[\r\n;&|<>`]/.test(command)) {
    throw new Error('Command contains shell control operators. Run a single non-interactive command only.')
  }

  const tokens = tokenizeCommand(command)
  if (tokens.length === 0) {
    throw new Error('Command must not be empty')
  }

  const baseCommand = normalizeBaseCommand(tokens[0])
  if (!PROJECT_COMMAND_WHITELIST.includes(baseCommand)) {
    throw new Error(`Command not allowed: ${baseCommand}. Allowed: ${PROJECT_COMMAND_WHITELIST.join(', ')}. For file exploration use list_project_files/read_project_file.`)
  }

  if (baseCommand === 'npm') {
    validateNpmCommand(tokens)
  } else if (baseCommand === 'git') {
    validateGitCommand(tokens)
  }

  return { baseCommand, tokens }
}

function isSuccessfulManualBuild (parsed: ParsedCommand, payload: { exitCode?: number | null }): boolean {
  return parsed.baseCommand === 'npm' &&
    parsed.tokens[1]?.toLowerCase() === 'run' &&
    BUILD_NPM_SCRIPTS.has(parsed.tokens[2]?.toLowerCase() || '') &&
    payload.exitCode === 0
}

function hasReadySignal (stdout: string, stderr: string): boolean {
  const combinedOutput = `${stdout}\n${stderr}`
  return READY_SIGNAL_PATTERNS.some(pattern => pattern.test(combinedOutput))
}

function tokenizeCommand (command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) || [])
    .map(token => token.replace(/^("|')|("|')$/g, ''))
}

function normalizeBaseCommand (token: string): string {
  return path.basename(token).replace(/\.(cmd|exe|bat)$/i, '').toLowerCase()
}

function validateNpmCommand (tokens: string[]): void {
  const subCommand = tokens[1]?.toLowerCase()
  if (!subCommand) {
    throw new Error('run_project_command only allows npm install, npm ci, npm test, or npm run <script>.')
  }

  if (subCommand === 'install' || subCommand === 'ci' || subCommand === 'test') {
    return
  }

  if (subCommand === 'run') {
    const scriptName = tokens[2]?.toLowerCase()
    if (!scriptName) {
      throw new Error('npm run requires a script name.')
    }
    if (LONG_RUNNING_NPM_SCRIPTS.has(scriptName)) {
      throw new Error(`npm run ${scriptName} is a long-running command. Use the project runtime tools instead of run_project_command.`)
    }
    return
  }

  throw new Error('run_project_command only allows npm install, npm ci, npm test, or npm run <short-lived-script>.')
}

function validateGitCommand (tokens: string[]): void {
  const subCommand = tokens[1]?.toLowerCase() || 'status'
  if (!SAFE_GIT_SUBCOMMANDS.has(subCommand)) {
    throw new Error(`git ${subCommand} is not allowed in run_project_command. Allowed git subcommands: ${Array.from(SAFE_GIT_SUBCOMMANDS).join(', ')}.`)
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
        } catch {
          // Ignore termination failures.
        }
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
    } catch {
      // Ignore termination failures.
    }
  }
}
