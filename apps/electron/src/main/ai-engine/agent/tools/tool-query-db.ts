import type { ProjectDataAccess } from '../../../project-data-access/data-access.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'

interface ToolServices {
  dataAccess: ProjectDataAccess
}

interface QueryDbArgs {
  project_id: string
  sql: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

/**
 * Tool: query_project_database — 查询指定项目的数据库
 */
export function toolQueryDb (services: ToolServices): Tool {
  return {
    definition: {
      name: 'query_project_database',
      description: 'Run a read-only SQL query against the specified project database. SELECT only.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          sql: {
            type: 'string',
            description: 'SELECT query'
          }
        },
        required: ['project_id', 'sql']
      }
    },
    handler: async (args) => {
      const { project_id, sql } = args as unknown as QueryDbArgs
      const rows = await services.dataAccess.queryDatabase(project_id, sql)
      return { rowCount: rows.length, rows }
    }
  }
}
