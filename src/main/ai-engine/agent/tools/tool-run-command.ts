import { spawn } from 'node:child_process'
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

interface ParsedCommand {
  baseCommand: string
  tokens: string[]
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

/**
 * Tool: run_project_command — 在指定项目目录执行命令
 */
export function toolRunCommand (services: ToolServices): Tool {
  return {
    definition: {
      name: 'run_project_command',
      description: 'Run a shell command in the specified project directory. Only safe commands are allowed.',
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
            description: `Timeout in seconds. Default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS}.`
          }
        },
        required: ['project_id', 'command']
      }
    },
    handler: async (args, onProgress) => {
      const { project_id, command, cwd, timeout_seconds } = args as unknown as RunCommandArgs
      const parsed = validateProjectCommand(command)
      const timeoutSeconds = Math.min(Math.max(timeout_seconds || DEFAULT_TIMEOUT_SECONDS, 5), MAX_TIMEOUT_SECONDS)

      onProgress?.('⚡ 正在执行命令...', `${command}（超时 ${timeoutSeconds}s）`)

      const projectDir = path.join(services.projectFS.projectsDir, project_id)
      const workDir = cwd ? path.join(projectDir, cwd) : projectDir

      // Validate the working directory is within the project
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

      return new Promise((resolve) => {
        const child = spawn(command, [], {
          cwd: workDir,
          shell: true,
          env,
          windowsHide: true
        })

        let stdout = ''
        let stderr = ''
        let settled = false
        let timedOut = false
        let outputTruncated = false
        let terminatedByOutputLimit = false
        const startedAt = Date.now()
        let forceResolveHandle: NodeJS.Timeout | null = null

        const finish = async (payload: Record<string, unknown>) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutHandle)
          clearInterval(heartbeatHandle)
          if (forceResolveHandle) {
            clearTimeout(forceResolveHandle)
          }
          if (isSuccessfulManualBuild(parsed, payload)) {
            try {
              const syncResult = await services.builderService.syncManualBuildState(project_id)
              payload.manualBuildStateSynced = syncResult.synced
              if (!syncResult.synced && syncResult.reason) {
                payload.manualBuildStateSyncReason = syncResult.reason
              }
            } catch (err) {
              payload.manualBuildStateSynced = false
              payload.manualBuildStateSyncReason = (err as Error).message
            }
          }
          resolve(payload)
        }

        const appendOutput = (current: string, chunk: Buffer, limit: number) => {
          const next = current + chunk.toString()
          if (next.length <= limit) {
            return { value: next, truncated: false }
          }
          return { value: next.slice(0, limit), truncated: true }
        }

        const requestTermination = (reason: 'timeout' | 'output_limit') => {
          if (timedOut || terminatedByOutputLimit) return
          if (reason === 'timeout') {
            timedOut = true
            onProgress?.('⏱️ 命令执行超时，正在终止...', `${timeoutSeconds}s: ${parsed.baseCommand}`)
          } else {
            terminatedByOutputLimit = true
            outputTruncated = true
            onProgress?.('⚠️ 命令输出过长，正在终止...', parsed.baseCommand)
          }

          void terminateProcessTree(child.pid)

          if (!forceResolveHandle) {
            forceResolveHandle = setTimeout(() => {
              if (!settled) {
                void finish({
                  exitCode: -1,
                  reason: timedOut ? 'timeout' : 'output_limit',
                  timedOut: timedOut || terminatedByOutputLimit,
                  stdout,
                  stderr,
                  error: timedOut
                    ? `Command timed out after ${timeoutSeconds} seconds`
                    : 'Command did not close cleanly after termination',
                  outputTruncated,
                  observedReadySignal: hasReadySignal(stdout, stderr)
                })
              }
            }, 5000)
          }
        }

        const timeoutHandle = setTimeout(() => {
          requestTermination('timeout')
        }, timeoutSeconds * 1000)

        const heartbeatHandle = setInterval(() => {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
          onProgress?.('⏳ 命令仍在执行...', `${elapsedSeconds}s: ${command}`)
        }, HEARTBEAT_INTERVAL_MS)

        child.stdout?.on('data', (data: Buffer) => {
          const next = appendOutput(stdout, data, MAX_STDOUT_CHARS)
          stdout = next.value
          outputTruncated = outputTruncated || next.truncated
          if (next.truncated) {
            requestTermination('output_limit')
          }
        })

        child.stderr?.on('data', (data: Buffer) => {
          const next = appendOutput(stderr, data, MAX_STDERR_CHARS)
          stderr = next.value
          outputTruncated = outputTruncated || next.truncated
          if (next.truncated) {
            requestTermination('output_limit')
          }
        })

        child.on('close', (code, signal) => {
          const exitCode = code ?? (timedOut || terminatedByOutputLimit ? -1 : null)
          if (timedOut || terminatedByOutputLimit) {
            onProgress?.('⚠️ 命令已终止', timedOut ? `超时 ${timeoutSeconds}s` : '输出过长')
          } else {
            onProgress?.('✅ 命令执行完成', `退出码: ${String(exitCode)}`)
          }

            void finish({
              exitCode,
              signal,
              reason: timedOut ? 'timeout' : terminatedByOutputLimit ? 'output_limit' : 'completed',
              timedOut,
              stdout,
              stderr,
              outputTruncated,
              observedReadySignal: hasReadySignal(stdout, stderr),
              error: timedOut
                ? `Command timed out after ${timeoutSeconds} seconds`
                : undefined
            })
          })

        child.on('error', (err) => {
          onProgress?.('❌ 命令执行失败', err.message)
          void finish({
            exitCode: -1,
            reason: 'spawn_error',
            stdout,
            stderr,
            error: `Command failed: ${err.message}`,
            timedOut,
            outputTruncated,
            observedReadySignal: hasReadySignal(stdout, stderr)
          })
        })
      })
    }
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

function isSuccessfulManualBuild (parsed: ParsedCommand, payload: Record<string, unknown>): boolean {
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
