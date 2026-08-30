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
const FILTER_BUFFER_MULTIPLIER = 3

export function toolGetProjectLogs (services: ToolServices): Tool {
  return {
    definition: {
      name: 'get_project_logs',
      description: 'Read recent project logs, optionally filtered by stdout, stderr, or all logs.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          lines: {
            type: 'integer',
            description: `How many recent log lines to return. Default ${DEFAULT_LINES}, maximum ${MAX_LINES}.`
          },
          type: {
            type: 'string',
            enum: ['stdout', 'stderr', 'all'],
            description: 'Log type filter. Defaults to all.'
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
        .getLogs(project_id, requestedLines * (logType === 'all' ? 1 : FILTER_BUFFER_MULTIPLIER))
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
