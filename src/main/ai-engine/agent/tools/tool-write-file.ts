import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import { streamFilePreview } from './file-preview-progress.js'

interface ToolServices {
  projectFS: ProjectFS
}

interface WriteFileArgs {
  project_id: string
  file_path: string
  content: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/**
 * Tool: write_project_file — 修改指定项目的文件
 */
export function toolWriteFile (services: ToolServices): Tool {
  return {
    definition: {
      name: 'write_project_file',
      description: 'Modify a file in the specified project. A backup is created automatically.',
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
          },
          content: {
            type: 'string',
            description: 'Full file content'
          }
        },
        required: ['project_id', 'file_path', 'content']
      }
    },
    handler: async (args, onProgress) => {
      const { project_id, file_path, content } = args as unknown as WriteFileArgs
      await streamFilePreview(file_path, content, onProgress)
      onProgress?.('📝 正在写入文件...', file_path)
      await services.projectFS.writeFile(project_id, file_path, content)
      onProgress?.('✅ 文件已保存', file_path)
      return { success: true, file_path, message: `File ${file_path} written successfully` }
    }
  }
}
