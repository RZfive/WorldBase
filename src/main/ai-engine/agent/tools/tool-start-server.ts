import type { RuntimeManager } from '../../../project-runtime/runtime-manager.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'

interface ToolServices {
  runtimeManager: RuntimeManager
}

interface StartProjectServerArgs {
  project_id: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

export function toolStartProjectServer (services: ToolServices): Tool {
  return {
    definition: {
      name: 'start_project_server',
      description: 'Start a project server in the background and return its runtime info plus recent startup logs.',
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
      const { project_id } = args as unknown as StartProjectServerArgs
      onProgress?.('🚀 正在启动项目服务...', project_id)
      const startResult = await services.runtimeManager.start(project_id)
      const status = services.runtimeManager.getStatus(project_id)
      const startupLogs = services.runtimeManager.getLogs(project_id, 40).slice(-20)
      onProgress?.('✅ 项目服务已就绪', `${project_id} @ ${status.port ?? startResult.port}`)
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
