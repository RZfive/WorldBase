import { spawn } from 'node:child_process'
import path from 'node:path'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { BrowserWindow } from 'electron'
import { requestUserAuth } from './user-auth.js'
import type { AIExecutionPreferences } from '../../../settings/settings-store.js'

interface ToolServices {
  getMainWindow?: () => BrowserWindow | null
  getAIExecutionPreferences?: () => AIExecutionPreferences
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
export function toolLocalCommand (services: ToolServices): Tool {
  return {
    definition: {
      name: 'local_run_command',
      description: '在用户本地电脑执行 shell 命令。执行前需要用户授权。可以运行任何命令行程序来完成系统任务。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 shell 命令'
          },
          cwd: {
            type: 'string',
            description: '工作目录（绝对路径），默认为用户 Home 目录'
          },
          timeout: {
            type: 'number',
            description: '超时时间（秒），默认 60 秒，最大 300 秒'
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
        services.getAIExecutionPreferences,
        'AI 请求执行命令行',
        `AI 助手请求执行以下命令:\n\n$ ${command}\n\n工作目录: ${workDir}\n超时: ${timeoutSec} 秒\n\n是否允许？`
      )

      if (!authorized) {
        return { error: '用户拒绝了命令执行请求', command }
      }

      onProgress?.('⚡ 执行本地命令...', command)

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
          onProgress?.('✅ 命令执行完成', `退出码: ${code}`)
          resolve({
            exitCode: code,
            stdout: stdout.substring(0, 50000),
            stderr: stderr.substring(0, 10000)
          })
        })

        child.on('error', (err) => {
          onProgress?.('❌ 命令执行失败', err.message)
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
