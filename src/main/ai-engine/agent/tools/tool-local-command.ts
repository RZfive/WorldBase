import { spawn } from 'node:child_process'
import path from 'node:path'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback, SessionState } from '../agent-core.js'
import type { BrowserWindow } from 'electron'
import { requestUserAuth, requestSudoPassword } from './user-auth.js'

interface ToolServices {
  getMainWindow?: () => BrowserWindow | null
}

interface LocalCommandArgs {
  command: string
  cwd?: string
  timeout?: number
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/** Returns true if the command string contains a sudo invocation. */
function commandHasSudo (command: string): boolean {
  return /(?:^|[|;&])\s*sudo\b/.test(command)
}

/**
 * Check whether the current sudo timestamp is still valid (i.e. no password needed).
 * Runs `sudo -n true` non-interactively — exits 0 if credentials are cached, non-zero otherwise.
 */
function checkSudoCredentialsCached (workDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('sudo -n true', [], {
      shell: true,
      cwd: workDir,
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'ignore']
    })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

/**
 * Rewrite every `sudo` token in the command to `sudo -S` so the process
 * reads its password from stdin rather than the TTY.
 * Idempotent — if `-S` is already present the replacement is skipped.
 */
function injectSudoStdinFlag (command: string): string {
  // Match `sudo` not already followed by flags containing S
  return command.replace(/\bsudo\b(?=\s)(?!\s+-\S*S)/g, 'sudo -S')
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/**
 * Tool: local_run_command — 在用户本地电脑执行命令行命令（需要用户授权）
 */
export function toolLocalCommand (services: ToolServices, getSessionState?: () => SessionState, getAbortSignal?: () => AbortSignal | undefined): Tool {
  return {
    definition: {
      name: 'local_run_command',
      description: "Run a shell command on the user's local computer. User approval is required.",
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute'
          },
          cwd: {
            type: 'string',
            description: 'Working directory as an absolute path. Defaults to the user home directory.'
          },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds. Default 60, maximum 300.'
          }
        },
        required: ['command']
      }
    },
    handler: async (args, onProgress) => {
      const { command, cwd, timeout } = args as unknown as LocalCommandArgs
      const workDir = cwd ? path.resolve(cwd) : process.env.HOME || '/'
      const timeoutSec = Math.min(Math.max(timeout || 60, 1), 300)

      // Request user authorization
      const authorized = await requestUserAuth(
        services.getMainWindow,
        getSessionState,
        getAbortSignal,
        'AI requests a local command',
        `The AI assistant wants to run this command:\n\n$ ${command}\n\nWorking directory: ${workDir}\nTimeout: ${timeoutSec} seconds\n\nAllow it?`
      )

      if (!authorized) {
        return { error: 'The user denied the local command request.', command }
      }

      // --- sudo password handling ---
      let sudoPassword: string | null = null
      let finalCommand = command
      const needsSudo = commandHasSudo(command)

      if (needsSudo) {
        const cached = await checkSudoCredentialsCached(workDir)
        if (!cached) {
          onProgress?.('🔑 Waiting for sudo password...', command)
          sudoPassword = await requestSudoPassword(
            services.getMainWindow,
            getSessionState,
            getAbortSignal,
            command
          )
          if (sudoPassword === null) {
            return { error: 'Sudo password was not provided or the request was cancelled.', command }
          }
          finalCommand = injectSudoStdinFlag(command)
        }
      }
      // --- end sudo handling ---

      onProgress?.('⚡ Running local command...', finalCommand)

      return new Promise((resolve) => {
        const child = spawn(finalCommand, [], {
          cwd: workDir,
          shell: true,
          timeout: timeoutSec * 1000,
          env: { ...process.env },
          // stdin must be piped when we need to supply a sudo password
          stdio: sudoPassword !== null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
        })

        // Write the sudo password to stdin immediately then close it
        if (sudoPassword !== null) {
          child.stdin?.write(sudoPassword + '\n')
          child.stdin?.end()
        }

        let stdout = ''
        let stderr = ''

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString()
          // Trim if too large to prevent memory issues
          if (stdout.length > 200000) {
            stdout = stdout.substring(0, 200000)
            child.kill()
          }
        })
        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString()
          if (stderr.length > 50000) {
            stderr = stderr.substring(0, 50000)
          }
        })

        child.on('exit', (code) => {
          onProgress?.('✅ Local command finished', `Exit code: ${code}`)
          resolve({
            exitCode: code,
            stdout: stdout.substring(0, 50000),
            stderr: stderr.substring(0, 10000)
          })
        })

        child.on('error', (err) => {
          onProgress?.('❌ Local command failed', err.message)
          resolve({
            exitCode: -1,
            error: err.message,
            stdout: stdout.substring(0, 50000),
            stderr: stderr.substring(0, 10000)
          })
        })
      })
    }
  }
}
