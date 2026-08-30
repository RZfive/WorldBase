import type { ProjectApiClient } from '../../../project-api-bridge/api-client.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'

interface ToolServices {
  apiClient: ProjectApiClient
}

interface CallApiArgs {
  project_id: string
  method: string
  path: string
  body?: Record<string, unknown>
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

/**
 * Tool: call_project_api — 调用指定项目的后端 API
 */
export function toolCallApi (services: ToolServices): Tool {
  return {
    definition: {
      name: 'call_project_api',
      description: 'Call a running HTTP API exposed by the specified project.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE'],
            description: 'HTTP method'
          },
          path: {
            type: 'string',
            description: 'API path, for example /api/records'
          },
          body: {
            type: 'object',
            description: 'Request body for POST or PUT requests'
          }
        },
        required: ['project_id', 'method', 'path']
      }
    },
    handler: async (args) => {
      const { project_id, method, path, body } = args as unknown as CallApiArgs
      return services.apiClient.call(project_id, method, path, body ?? null)
    }
  }
}
