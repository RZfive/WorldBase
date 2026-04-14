import type { BuilderService } from '../../../project-runtime/builder-service.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'

interface ToolServices {
  builderService: BuilderService
}

interface RebuildProjectArgs {
  project_id: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

export function toolRebuildProject (services: ToolServices): Tool {
  return {
    definition: {
      name: 'rebuild_project',
      description: 'Atomically stop the project server, reinstall dependencies, rebuild the project, and start a fresh server.',
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
      const { project_id } = args as unknown as RebuildProjectArgs

      onProgress?.('🧹 正在执行原子重建流程...', project_id)
      const result = await services.builderService.rebuild(project_id)

      if (result.success) {
        onProgress?.('✅ 重建完成', `耗时 ${Math.round(result.duration / 1000)}s`)
      } else {
        onProgress?.('❌ 重建失败', result.error || 'unknown error')
      }

      return result
    }
  }
}
