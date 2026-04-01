import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'

interface ToolServices {
  projectFS: ProjectFS
}

interface ReadFileArgs {
  project_id: string
  file_path: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

/**
 * Tool: read_project_file — 读取指定项目的文件内容
 */
export function toolReadFile (services: ToolServices): Tool {
  return {
    definition: {
      name: 'read_project_file',
      description: '读取指定项目的文件内容。用于理解项目代码结构。',
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
          }
        },
        required: ['project_id', 'file_path']
      }
    },
    handler: async (args) => {
      const { project_id, file_path } = args as unknown as ReadFileArgs
      const content = await services.projectFS.readFile(project_id, file_path)
      return { file_path, content }
    }
  }
}
