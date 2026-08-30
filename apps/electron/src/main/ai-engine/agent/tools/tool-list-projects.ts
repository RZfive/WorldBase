import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { RuntimeManager } from '../../../project-runtime/runtime-manager.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'

interface ToolServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

/**
 * Tool: list_projects — 列出所有项目及状态
 */
export function toolListProjects (services: ToolServices): Tool {
  return {
    definition: {
      name: 'list_projects',
      description: 'List all created projects and their runtime status.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    handler: async () => {
      const projects = await services.projectFS.listProjects()

      // Enrich with runtime status
      const enriched = projects.map(project => {
        const status = services.runtimeManager.getStatus(project.id)
        return {
          ...project,
          runtime: status
        }
      })

      return { projects: enriched }
    }
  }
}
