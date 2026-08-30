import type { ProjectDataAccess } from '../../../project-data-access/data-access.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'

interface ToolServices {
  dataAccess: ProjectDataAccess
}

interface AnalyzeDataArgs {
  project_id: string
  analysis_type: string
  options?: Record<string, unknown>
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

/**
 * Tool: analyze_project_data — 分析指定项目的数据
 */
export function toolAnalyzeData (services: ToolServices): Tool {
  return {
    definition: {
      name: 'analyze_project_data',
      description: 'Analyze project data and return statistics. Supported types: summary, trend, distribution, comparison.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          analysis_type: {
            type: 'string',
            enum: ['summary', 'trend', 'distribution', 'comparison'],
            description: 'Analysis type'
          },
          options: {
            type: 'object',
            description: 'Analysis options. trend needs {table, dateColumn, valueColumn}; distribution needs {table, column}; comparison needs {table, groupColumn, valueColumn}.',
            properties: {
              table: { type: 'string', description: 'Table name' },
              dateColumn: { type: 'string', description: 'Date column (trend)' },
              valueColumn: { type: 'string', description: 'Value column' },
              column: { type: 'string', description: 'Column to analyze (distribution)' },
              groupColumn: { type: 'string', description: 'Group column (comparison)' },
              aggregation: { type: 'string', description: 'Aggregation function (comparison): SUM/AVG/COUNT/MIN/MAX' }
            }
          }
        },
        required: ['project_id', 'analysis_type']
      }
    },
    handler: async (args) => {
      const { project_id, analysis_type, options } = args as unknown as AnalyzeDataArgs
      return services.dataAccess.analyzeData(project_id, analysis_type, options || {})
    }
  }
}
