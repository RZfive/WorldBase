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
      description: '清理项目的 node_modules 和 Next.js 缓存后，重新安装依赖并重新编译。适用于打包失败、依赖变更或需要强制重新打包时。',
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
