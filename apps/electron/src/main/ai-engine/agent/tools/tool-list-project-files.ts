import type { ProjectFS, DirEntry } from '../../../project-fs/project-fs.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'

interface ToolServices {
  projectFS: ProjectFS
}

interface ListProjectFilesArgs {
  project_id: string
  dir_path?: string
}

interface ListProjectFilesResult {
  dir_path: string
  entries: DirEntry[]
  total_entries: number
  truncated: boolean
}

const MAX_ENTRIES = 200

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/**
 * Tool: list_project_files — 列出项目目录内容
 */
export function toolListProjectFiles (services: ToolServices): Tool {
  return {
    definition: {
      name: 'list_project_files',
      description: 'List files and folders in the specified project directory.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          dir_path: {
            type: 'string',
            description: 'Directory path relative to the project root. Defaults to the root directory.'
          }
        },
        required: ['project_id']
      }
    },
    handler: async (args, onProgress): Promise<ListProjectFilesResult> => {
      const { project_id, dir_path } = args as unknown as ListProjectFilesArgs
      const relativePath = (dir_path || '').trim()

      onProgress?.('📂 正在列出项目目录...', relativePath || '.')

      const entries = await services.projectFS.listDir(project_id, relativePath, false)
      const limitedEntries = entries.slice(0, MAX_ENTRIES)

      onProgress?.('✅ 目录读取完成', `${limitedEntries.length}/${entries.length} 项`)

      return {
        dir_path: relativePath,
        entries: limitedEntries,
        total_entries: entries.length,
        truncated: entries.length > limitedEntries.length
      }
    }
  }
}