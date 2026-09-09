import type { BuilderService } from '../../../project-runtime/builder-service.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'

interface ToolServices {
  builderService: BuilderService
}

interface RebuildProjectArgs {
  project_id: string
  clean_install?: boolean
  cleanup_dependencies_after_success?: boolean
  cleanup_build_cache_after_success?: boolean
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

export function toolRebuildProject (services: ToolServices): Tool {
  return {
    definition: {
      name: 'rebuild_project',
      description: 'Rebuild and restart a project. By default this preserves installed dependencies and build caches so iterative development stays fast. Use clean_install only when you need a full reinstall, and use cleanup_*_after_success only when finalizing a project and you explicitly want to reclaim disk space afterwards.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          clean_install: {
            type: 'boolean',
            description: 'When true, remove node_modules and build cache before reinstalling dependencies. Leave false for normal hot-update rebuilds.'
          },
          cleanup_dependencies_after_success: {
            type: 'boolean',
            description: 'When true, remove node_modules after a successful rebuild/restart. Use only when the project is finalized and you no longer need fast iterative rebuilds.'
          },
          cleanup_build_cache_after_success: {
            type: 'boolean',
            description: 'When true, remove build caches such as .next/cache after a successful rebuild to save disk space.'
          }
        },
        required: ['project_id']
      }
    },
    handler: async (args, onProgress) => {
      const {
        project_id,
        clean_install,
        cleanup_dependencies_after_success,
        cleanup_build_cache_after_success
      } = args as unknown as RebuildProjectArgs

      onProgress?.('🧹 正在执行原子重建流程...', project_id)
      const result = await services.builderService.rebuild(project_id, {
        cleanInstall: clean_install === true,
        cleanupDependenciesAfterSuccess: cleanup_dependencies_after_success === true,
        cleanupBuildCacheAfterSuccess: cleanup_build_cache_after_success === true
      })

      if (result.success) {
        onProgress?.('✅ 重建完成', `耗时 ${Math.round(result.duration / 1000)}s`)
      } else {
        onProgress?.('❌ 重建失败', result.error || 'unknown error')
      }

      return result
    }
  }
}
