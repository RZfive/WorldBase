import type { RuntimeManager } from '../../../project-runtime/runtime-manager.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'

interface ToolServices {
  runtimeManager: RuntimeManager
}

interface GetProjectLogsArgs {
  project_id: string
  lines?: number
  type?: 'stdout' | 'stderr' | 'all'
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

const DEFAULT_LINES = 50
const MAX_LINES = 200

export function toolGetProjectLogs (services: ToolServices): Tool {
  return {
    definition: {
      name: 'get_project_logs',
      description: '读取项目最近的运行日志，可按 stdout、stderr 或全部日志过滤。',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: '项目 ID'
          },
          lines: {
            type: 'integer',
            description: `返回最近多少条日志，默认 ${DEFAULT_LINES}，最大 ${MAX_LINES}`
          },
          type: {
            type: 'string',
            enum: ['stdout', 'stderr', 'all'],
            description: '日志类型过滤，默认 all'
          }
        },
        required: ['project_id']
      }
    },
    handler: async (args) => {
      const { project_id, lines, type } = args as unknown as GetProjectLogsArgs
      const requestedLines = Math.min(Math.max(lines || DEFAULT_LINES, 1), MAX_LINES)
      const logType = type || 'all'
      const logs = services.runtimeManager
        .getLogs(project_id, requestedLines * (logType === 'all' ? 1 : 3))
        .filter(entry => logType === 'all' || entry.type === logType)
        .slice(-requestedLines)

      return {
        project_id,
        type: logType,
        lines: requestedLines,
        logs
      }
    }
  }
}
