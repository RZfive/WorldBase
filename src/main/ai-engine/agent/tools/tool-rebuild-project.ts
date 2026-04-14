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
      description: 'Clean node_modules and the Next.js cache, then reinstall dependencies and rebuild the project.',
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

      onProgress?.('🧹 正在清理依赖和构建缓存...', project_id)
      const result = await services.builderService.rebuild(project_id)

      if (result.success) {
        onProgress?.('✅ 重新编译完成', `耗时 ${Math.round(result.duration / 1000)}s`)
      } else {
        onProgress?.('❌ 重新编译失败', result.error || 'unknown error')
      }

      return result
    }
  }
}
