import fs from 'node:fs/promises'
import path from 'node:path'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback, SessionState } from '../agent-core.js'
import type { BrowserWindow } from 'electron'
import { requestUserAuth } from './user-auth.js'
import { isOfficeFile, readOfficeFile, detectOfficeType } from './office-utils.js'

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
 * 支持办公文件格式: .xlsx, .docx, .pptx（自动解析内容）
 */
export function toolLocalFileRead (services: ToolServices, getSessionState?: () => SessionState): Tool {
  return {
    definition: {
      name: 'local_read_file',
      description: "Read a file from the user's local computer. User approval is required. Office files are parsed automatically.",
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute file path, for example /Users/xxx/Documents/file.txt or /Users/xxx/report.xlsx'
          },
          encoding: {
            type: 'string',
            description: 'File encoding. Defaults to utf-8; office formats are handled automatically.'
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
        getSessionState,
        'AI requests a local file read',
        `The AI assistant wants to read this file:\n\n${resolvedPath}\n\nAllow it?`
      )

      if (!authorized) {
        return { error: 'The user denied the local file read request.', file_path: resolvedPath }
      }

      onProgress?.('📄 Reading local file...', resolvedPath)

      // Verify path exists and is a file
      const stat = await fs.stat(resolvedPath)
      if (!stat.isFile()) {
          throw new Error(`Path is not a file: ${resolvedPath}`)
      }

      // Limit file size to 10 MB
      if (stat.size > 10 * 1024 * 1024) {
        throw new Error(`File is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Maximum supported size is 10 MB.`)
      }

      // Check if it's an office file
      if (isOfficeFile(resolvedPath)) {
        const officeType = detectOfficeType(resolvedPath)
        onProgress?.('📊 Parsing office file...', `Type: ${officeType}`)

        const result = await readOfficeFile(resolvedPath)

        onProgress?.('✅ Office file parsed', `${result.content.length} characters`)

        return {
          file_path: resolvedPath,
          size: stat.size,
          file_type: result.type,
          content: result.content.substring(0, 100000) // limit to 100k chars
        }
      }

      // Regular text file
      const content = await fs.readFile(resolvedPath, { encoding: (encoding || 'utf-8') as BufferEncoding })

      onProgress?.('✅ File read complete', `${content.length} characters`)

      return {
        file_path: resolvedPath,
        size: stat.size,
        content: content.substring(0, 100000) // limit to 100k chars
      }
    }
  }
}
