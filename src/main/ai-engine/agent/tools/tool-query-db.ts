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
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

/**
 * Tool: query_project_database — 查询指定项目的数据库
 */
export function toolQueryDb (services: ToolServices): Tool {
  return {
    definition: {
      name: 'query_project_database',
      description: '对指定项目的数据库执行只读 SQL 查询。仅支持 SELECT 语句。用于分析项目数据。',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: '项目 ID'
          },
          sql: {
            type: 'string',
            description: 'SELECT 查询语句'
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
