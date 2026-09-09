import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'

interface ToolServices {
  projectFS: ProjectFS
}

interface DeleteFileArgs {
  project_id: string
  file_path: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/**
 * Tool: delete_project_file — 删除指定项目中的单个文件
 */
export function toolDeleteFile (services: ToolServices): Tool {
  return {
    definition: {
      name: 'delete_project_file',
      description: 'Delete a single file from the specified project.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          file_path: {
            type: 'string',
            description: 'File path relative to the project root'
          }
        },
        required: ['project_id', 'file_path']
      }
    },
    handler: async (args, onProgress) => {
      const { project_id, file_path } = args as unknown as DeleteFileArgs

      onProgress?.('🗑️ 正在删除文件...', file_path)

      const exists = await services.projectFS.fileExists(project_id, file_path)
      if (!exists) {
        onProgress?.('ℹ️ 文件不存在，跳过删除', file_path)
        return {
          success: true,
          skipped: true,
          file_path,
          message: `File ${file_path} does not exist`
        }
      }

      await services.projectFS.deleteFile(project_id, file_path)
      onProgress?.('✅ 文件已删除', file_path)

      return {
        success: true,
        file_path,
        message: `File ${file_path} deleted successfully`
      }
    }
  }
}