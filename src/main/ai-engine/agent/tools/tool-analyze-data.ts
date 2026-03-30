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
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

/**
 * Tool: analyze_project_data — 分析指定项目的数据
 */
export function toolAnalyzeData (services: ToolServices): Tool {
  return {
    definition: {
      name: 'analyze_project_data',
      description: '分析指定项目的数据，返回统计结果。支持: summary(概要), trend(趋势), distribution(分布), comparison(对比)。',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: '项目 ID'
          },
          analysis_type: {
            type: 'string',
            enum: ['summary', 'trend', 'distribution', 'comparison'],
            description: '分析类型'
          },
          options: {
            type: 'object',
            description: '分析选项。trend 需要: {table, dateColumn, valueColumn}; distribution 需要: {table, column}; comparison 需要: {table, groupColumn, valueColumn}',
            properties: {
              table: { type: 'string', description: '表名' },
              dateColumn: { type: 'string', description: '日期列 (trend)' },
              valueColumn: { type: 'string', description: '值列' },
              column: { type: 'string', description: '分析列 (distribution)' },
              groupColumn: { type: 'string', description: '分组列 (comparison)' },
              aggregation: { type: 'string', description: '聚合函数 (comparison): SUM/AVG/COUNT/MIN/MAX' }
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
