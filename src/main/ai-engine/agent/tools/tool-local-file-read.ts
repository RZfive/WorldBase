import fs from 'node:fs/promises'
import path from 'node:path'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { BrowserWindow } from 'electron'
import { requestUserAuth } from './user-auth.js'

interface ToolServices {
  getMainWindow?: () => BrowserWindow | null
}

interface LocalReadFileArgs {
  file_path: string
  encoding?: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/**
 * Tool: local_read_file — 读取用户本地电脑上的任意文件（需要用户授权）
 */
export function toolLocalFileRead (services: ToolServices): Tool {
  return {
    definition: {
      name: 'local_read_file',
      description: '读取用户本地电脑上的文件内容。执行前需要用户授权。可以读取系统上任何位置的文件。',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '文件的绝对路径，例如 /Users/xxx/Documents/file.txt'
          },
          encoding: {
            type: 'string',
            description: '文件编码，默认 utf-8'
          }
        },
        required: ['file_path']
      }
    },
    handler: async (args, onProgress) => {
      const { file_path, encoding } = args as unknown as LocalReadFileArgs
      const resolvedPath = path.resolve(file_path)

      // Request user authorization
      const authorized = await requestUserAuth(
        services.getMainWindow,
        'AI 请求读取本地文件',
        `AI 助手请求读取以下文件:\n\n${resolvedPath}\n\n是否允许？`
      )

      if (!authorized) {
        return { error: '用户拒绝了文件读取请求', file_path: resolvedPath }
      }

      onProgress?.('📄 读取本地文件...', resolvedPath)

      // Verify path exists and is a file
      const stat = await fs.stat(resolvedPath)
      if (!stat.isFile()) {
        throw new Error(`路径不是一个文件: ${resolvedPath}`)
      }

      // Limit file size to 10 MB
      if (stat.size > 10 * 1024 * 1024) {
        throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)} MB)，最大支持 10 MB`)
      }

      const content = await fs.readFile(resolvedPath, { encoding: (encoding || 'utf-8') as BufferEncoding })

      onProgress?.('✅ 文件读取完成', `${content.length} 字符`)

      return {
        file_path: resolvedPath,
        size: stat.size,
        content: content.substring(0, 100000) // limit to 100k chars
      }
    }
  }
}
