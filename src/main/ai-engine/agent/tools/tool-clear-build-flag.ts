import type { BuilderService } from '../../../project-runtime/builder-service.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'

interface ToolServices {
  builderService: BuilderService
}

interface ClearBuildFlagArgs {
  project_id: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/**
 * Tool: clear_project_build_flag — 清除项目的重建标记
 *
 * When the AI has manually performed a successful build via run_project_command
 * (e.g. `npm install && npm run build`) but get_project_status still reports
 * stale `needs_rebuild: true` or `node_modules_present: false`, this tool
 * forces the platform to re-sync its cached build state from the actual disk
 * contents.  This prevents the AI from entering an unnecessary rebuild loop.
 */
export function toolClearProjectBuildFlag (services: ToolServices): Tool {
  return {
    definition: {
      name: 'clear_project_build_flag',
      description: 'Force the platform to re-sync its cached build state from disk after a successful manual build. Use this when get_project_status still reports needs_rebuild or missing node_modules even though you have already built the project manually via run_project_command.',
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
      const { project_id } = args as unknown as ClearBuildFlagArgs
      onProgress?.('🔄 正在同步构建状态...', project_id)

      const syncResult = await services.builderService.syncManualBuildState(project_id)

      if (syncResult.synced) {
        onProgress?.('✅ 构建状态已同步', project_id)
        return {
          success: true,
          project_id,
          message: `Build state for project ${project_id} has been synced from disk. The needs_rebuild flag should now reflect the actual state.`
        }
      }

      const reason = syncResult.reason || 'unknown'
      onProgress?.('⚠️ 状态同步未完成', reason)
      return {
        success: false,
        project_id,
        reason,
        message: `Could not fully sync build state: ${reason}. The standalone build output may be missing — try running npm run build first.`
      }
    }
  }
}
