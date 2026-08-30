import type { RuntimeManager } from '../../../project-runtime/runtime-manager.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'

interface ToolServices {
  runtimeManager: RuntimeManager
}

interface RestartProjectServerArgs {
  project_id: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

export function toolRestartProjectServer (services: ToolServices): Tool {
  return {
    definition: {
      name: 'restart_project_server',
      description: 'Force-stop any existing project server process, then start a fresh one and return new runtime info plus startup logs.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          }
        },
        required: ['project_id']
      }
    },
    handler: async (args, onProgress) => {
      const { project_id } = args as unknown as RestartProjectServerArgs
      onProgress?.('🔄 正在重启项目服务...', project_id)
      const startResult = await services.runtimeManager.restart(project_id)
      const status = services.runtimeManager.getStatus(project_id)
      const startupLogs = services.runtimeManager.getLogs(project_id, 20)
      onProgress?.('✅ 项目服务已重启', `${project_id} @ ${status.port ?? startResult.port}`)
      return {
        project_id,
        status: startResult.status,
        port: status.port ?? startResult.port,
        pid: status.pid,
        started_at: status.startedAt,
        startup_logs: startupLogs
      }
    }
  }
}
