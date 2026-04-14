import { spawn } from 'node:child_process'
import path from 'node:path'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback, SessionState } from '../agent-core.js'
import type { BrowserWindow } from 'electron'
import { requestUserAuth } from './user-auth.js'

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

/**
 * Tool: local_run_command — 在用户本地电脑执行命令行命令（需要用户授权）
 */
export function toolLocalCommand (services: ToolServices, getSessionState?: () => SessionState): Tool {
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
        'AI requests a local command',
        `The AI assistant wants to run this command:\n\n$ ${command}\n\nWorking directory: ${workDir}\nTimeout: ${timeoutSec} seconds\n\nAllow it?`
      )

      if (!authorized) {
        return { error: 'The user denied the local command request.', command }
      }

      onProgress?.('⚡ Running local command...', command)

      return new Promise((resolve) => {
        const child = spawn(command, [], {
          cwd: workDir,
          shell: true,
          timeout: timeoutSec * 1000,
          env: { ...process.env }
        })

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
