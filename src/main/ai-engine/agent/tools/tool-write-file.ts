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
      description: '修改指定项目的文件。会自动创建备份。用于修改项目代码。',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: '项目 ID'
          },
          file_path: {
            type: 'string',
            description: '相对于项目根目录的文件路径'
          },
          content: {
            type: 'string',
            description: '完整的文件内容'
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
