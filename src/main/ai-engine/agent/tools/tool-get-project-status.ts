import type { RuntimeManager } from '../../../project-runtime/runtime-manager.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'

interface ToolServices {
  runtimeManager: RuntimeManager
}

interface GetProjectStatusArgs {
  project_id: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

export function toolGetProjectStatus (services: ToolServices): Tool {
  return {
    definition: {
      name: 'get_project_status',
      description: '获取项目当前运行状态、端口、进程 ID、启动时间，以及最近的错误日志摘要。',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: '项目 ID'
          }
        },
        required: ['project_id']
      }
    },
    handler: async (args) => {
      const { project_id } = args as unknown as GetProjectStatusArgs
      const status = services.runtimeManager.getStatus(project_id)
      const recentLogs = services.runtimeManager
        .getLogs(project_id, 20)
        .filter(entry => entry.type === 'stderr')
        .slice(-10)

      return {
        ...status,
        recent_error_logs: recentLogs
      }
    }
  }
}
