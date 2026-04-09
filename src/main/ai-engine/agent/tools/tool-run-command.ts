import { spawn } from 'node:child_process'
import path from 'node:path'
import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import { PROJECT_COMMAND_WHITELIST } from './command-capabilities.js'
import { createBundledRuntimeEnv } from '../../../project-runtime/bundled-runtime.js'

interface ToolServices {
  projectFS: ProjectFS
}

interface RunCommandArgs {
  project_id: string
  command: string
  cwd?: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/**
 * Tool: run_project_command — 在指定项目目录执行命令
 */
export function toolRunCommand (services: ToolServices): Tool {
  return {
    definition: {
      name: 'run_project_command',
      description: '在指定项目目录中执行 shell 命令。仅允许安全命令 (npm, node, git 等)。',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: '项目 ID'
          },
          command: {
            type: 'string',
            description: 'Shell 命令'
          },
          cwd: {
            type: 'string',
            description: '工作子目录 (默认项目根目录)'
          }
        },
        required: ['project_id', 'command']
      }
    },
    handler: async (args, onProgress) => {
      const { project_id, command, cwd } = args as unknown as RunCommandArgs
      // Security: check command whitelist
      const baseCommand = command.split(' ')[0]
      if (!PROJECT_COMMAND_WHITELIST.includes(baseCommand)) {
        const hint = baseCommand === 'rm'
          ? ' Use delete_project_file to remove files inside the project.'
          : ''
        throw new Error(`Command not allowed: ${baseCommand}. Allowed: ${PROJECT_COMMAND_WHITELIST.join(', ')}.${hint}`)
      }

      onProgress?.('⚡ 正在执行命令...', command)

      const projectDir = path.join(services.projectFS.projectsDir, project_id)
      const workDir = cwd ? path.join(projectDir, cwd) : projectDir

      // Validate the working directory is within the project
      const resolvedWorkDir = path.resolve(workDir)
      if (!resolvedWorkDir.startsWith(path.resolve(projectDir))) {
        throw new Error('Working directory must be within the project directory')
      }

      const env = await createBundledRuntimeEnv(workDir, { NODE_ENV: 'development' })

      return new Promise((resolve, reject) => {
        const [cmd, ...cmdArgs] = command.split(' ')
        const child = spawn(cmd, cmdArgs, {
          cwd: workDir,
          shell: true,
          timeout: 30000, // 30 second timeout
          env
        })

        let stdout = ''
        let stderr = ''

        child.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
        child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

        child.on('exit', (code) => {
          onProgress?.('✅ 命令执行完成', `退出码: ${code}`)
          resolve({
            exitCode: code,
            stdout: stdout.substring(0, 5000), // Limit output size
            stderr: stderr.substring(0, 2000)
          })
        })

        child.on('error', (err) => {
          reject(new Error(`Command failed: ${err.message}`))
        })
      })
    }
  }
}
