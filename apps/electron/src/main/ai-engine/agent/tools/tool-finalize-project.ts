import type { BuilderService } from '../../../project-runtime/builder-service.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'

interface ToolServices {
  builderService: BuilderService
}

interface FinalizeProjectArgs {
  project_id: string
  clean_install?: boolean
  cleanup_dependencies?: boolean
  cleanup_build_cache?: boolean
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

export function toolFinalizeProject (services: ToolServices): Tool {
  return {
    definition: {
      name: 'finalize_project',
      description: 'Finalize a project after development is complete. This performs a rebuild/restart and then reclaims disk space by cleaning dependencies and build caches when safe. Use this only at the end of delivery, not for normal iterative development.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          clean_install: {
            type: 'boolean',
            description: 'When true, perform a full clean install before the final rebuild. Leave false unless you specifically need a fresh dependency reinstall.'
          },
          cleanup_dependencies: {
            type: 'boolean',
            description: 'When true, remove node_modules after the final successful rebuild when the runtime can continue without them. Defaults to true.'
          },
          cleanup_build_cache: {
            type: 'boolean',
            description: 'When true, remove build caches such as .next/cache after the final successful rebuild. Defaults to true.'
          }
        },
        required: ['project_id']
      }
    },
    handler: async (args, onProgress) => {
      const {
        project_id,
        clean_install,
        cleanup_dependencies,
        cleanup_build_cache
      } = args as unknown as FinalizeProjectArgs

      const cleanupDependencies = cleanup_dependencies !== false
      const cleanupBuildCache = cleanup_build_cache !== false

      onProgress?.('🏁 正在执行项目收尾流程...', project_id)
      const result = await services.builderService.rebuild(project_id, {
        cleanInstall: clean_install === true,
        cleanupDependenciesAfterSuccess: cleanupDependencies,
        cleanupBuildCacheAfterSuccess: cleanupBuildCache
      })

      if (result.success) {
        const cleanupSummary = [
          cleanupDependencies ? '依赖清理已请求' : '保留依赖',
          cleanupBuildCache ? '构建缓存清理已请求' : '保留构建缓存'
        ].join('，')
        onProgress?.('✅ 项目收尾完成', cleanupSummary)
      } else {
        onProgress?.('❌ 项目收尾失败', result.error || 'unknown error')
      }

      return {
        ...result,
        finalized: result.success,
        cleanup_dependencies: cleanupDependencies,
        cleanup_build_cache: cleanupBuildCache
      }
    }
  }
}