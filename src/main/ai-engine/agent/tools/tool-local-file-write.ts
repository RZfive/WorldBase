import fs from 'node:fs/promises'
import path from 'node:path'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback, SessionState } from '../agent-core.js'
import type { BrowserWindow } from 'electron'
import { requestUserAuth } from './user-auth.js'
import { writeExcelFile, writeWordFile, writePptxFile } from './office-utils.js'

interface ToolServices {
  getMainWindow?: () => BrowserWindow | null
}

interface LocalWriteFileArgs {
  file_path: string
  content?: string
  office_data?: OfficeData
}

interface OfficeData {
  type: 'xlsx' | 'docx' | 'pptx'
  /** For xlsx: array of sheet definitions */
  sheets?: Array<{
    name: string
    headers: string[]
    rows: unknown[][]
  }>
  /** For docx: array of paragraphs */
  paragraphs?: Array<{
    text: string
    heading?: boolean
    bold?: boolean
  }>
  /** For pptx: array of slides */
  slides?: Array<{
    title: string
    content: string[]
  }>
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/**
 * Tool: local_write_file — 在用户本地电脑写入文件（需要用户授权）
 * 支持生成办公文件格式: .xlsx, .docx, .pptx
 */
export function toolLocalWriteFile (services: ToolServices, getSessionState?: () => SessionState, getAbortSignal?: () => AbortSignal | undefined): Tool {
  return {
    definition: {
      name: 'local_write_file',
      description: "Create or write a file on the user's local computer. User approval is required. Supports office files and plain text files.",
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute save path, for example /Users/xxx/Documents/report.xlsx'
          },
          content: {
            type: 'string',
            description: 'Text file content. For office files, use office_data instead.'
          },
          office_data: {
            type: 'object',
            description: 'Structured office document data. type selects xlsx/docx/pptx.',
            properties: {
              type: {
                type: 'string',
                enum: ['xlsx', 'docx', 'pptx'],
                description: 'Office file type'
              },
              sheets: {
                type: 'array',
                description: 'Excel sheet data. Each item includes name, headers, and rows.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    headers: { type: 'array', items: { type: 'string' } },
                    rows: {
                      type: 'array',
                      items: {
                        type: 'array',
                        items: {
                          type: 'string',
                          description: 'Cell value as text. Convert numbers, dates, and other values to strings before writing.'
                        }
                      }
                    }
                  }
                }
              },
              paragraphs: {
                type: 'array',
                description: 'Word document paragraphs. Each item includes text, heading, and bold.',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                    heading: { type: 'boolean' },
                    bold: { type: 'boolean' }
                  }
                }
              },
              slides: {
                type: 'array',
                description: 'PowerPoint slides. Each item includes title and content.',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    content: { type: 'array', items: { type: 'string' } }
                  }
                }
              }
            }
          }
        },
        required: ['file_path']
      }
    },
    handler: async (args, onProgress) => {
      const { file_path, content, office_data } = args as unknown as LocalWriteFileArgs
      const resolvedPath = path.resolve(file_path)

      // Request user authorization
      const authorized = await requestUserAuth(
        services.getMainWindow,
        getSessionState,
        getAbortSignal,
        'AI requests a local file write',
        `The AI assistant wants to create a file at this path:\n\n${resolvedPath}\n\nAllow it?`
      )

      if (!authorized) {
        return { error: 'The user denied the local file write request.', file_path: resolvedPath }
      }

      // Ensure parent directory exists
      const dir = path.dirname(resolvedPath)
      await fs.mkdir(dir, { recursive: true })

      if (office_data) {
        return await writeOfficeDocument(resolvedPath, office_data, onProgress)
      }

      // Plain text file
      if (content === undefined || content === null) {
        throw new Error('You must provide either content for plain text or office_data for an office document.')
      }

      onProgress?.('📝 Writing text file...', resolvedPath)
      await fs.writeFile(resolvedPath, content, 'utf-8')
      onProgress?.('✅ File write complete', resolvedPath)

      return {
        success: true,
        file_path: resolvedPath,
        size: Buffer.byteLength(content, 'utf-8'),
        message: `File saved: ${resolvedPath}`
      }
    }
  }
}

async function writeOfficeDocument (
  filePath: string,
  data: OfficeData,
  onProgress?: ProgressCallback
): Promise<unknown> {
  switch (data.type) {
    case 'xlsx': {
      if (!data.sheets || data.sheets.length === 0) {
        throw new Error('Excel files require sheets data.')
      }
      onProgress?.('📊 Creating Excel file...', filePath)
      await writeExcelFile(filePath, data.sheets)

      // Emit a text preview of the Excel data
      if (onProgress) {
        const previewText = formatExcelPreview(data.sheets)
        emitFilePreview(onProgress, filePath, previewText)
      }
      break
    }

    case 'docx': {
      if (!data.paragraphs || data.paragraphs.length === 0) {
        throw new Error('Word files require paragraphs data.')
      }
      onProgress?.('📄 Creating Word file...', filePath)
      await writeWordFile(filePath, data.paragraphs)

      // Emit a text preview of the Word content
      if (onProgress) {
        const previewText = formatWordPreview(data.paragraphs)
        emitFilePreview(onProgress, filePath, previewText)
      }
      break
    }

    case 'pptx': {
      if (!data.slides || data.slides.length === 0) {
        throw new Error('PowerPoint files require slides data.')
      }
      onProgress?.('📊 Creating PowerPoint file...', filePath)
      await writePptxFile(filePath, data.slides)

      // Emit a text preview of the PPT content
      if (onProgress) {
        const previewText = formatPptxPreview(data.slides)
        emitFilePreview(onProgress, filePath, previewText)
      }
      break
    }

    default:
      throw new Error(`Unsupported office file type: ${data.type}. Supported types: xlsx, docx, pptx.`)
  }

  const stat = await fs.stat(filePath)
  onProgress?.('✅ Office file created', `${(stat.size / 1024).toFixed(1)} KB`)

  return {
    success: true,
    file_path: filePath,
    file_type: data.type,
    size: stat.size,
    message: `${data.type.toUpperCase()} file saved: ${filePath}`
  }
}

function emitFilePreview (onProgress: ProgressCallback, filePath: string, content: string): void {
  // Report office-file generation as a compact status row (path + size) rather
  // than streaming the formatted preview body.
  const lineCount = content === '' ? 0 : content.replace(/\r\n/g, '\n').split('\n').length
  onProgress({ type: 'file_preview_start', filePath })
  onProgress({ type: 'file_preview_end', filePath, lineCount, added: lineCount, removed: 0 })
}

function formatExcelPreview (sheets: Array<{ name: string; headers: string[]; rows: unknown[][] }>): string {
  const lines: string[] = []
  for (const sheet of sheets) {
    lines.push(`📊 Sheet: ${sheet.name}`)
    lines.push('| ' + sheet.headers.join(' | ') + ' |')
    lines.push('|' + sheet.headers.map(() => '---').join('|') + '|')
    const maxRows = Math.min(sheet.rows.length, 20)
    for (let i = 0; i < maxRows; i++) {
      lines.push('| ' + sheet.rows[i].map(v => String(v ?? '')).join(' | ') + ' |')
    }
    if (sheet.rows.length > maxRows) {
      lines.push(`... ${sheet.rows.length} total rows`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function formatWordPreview (paragraphs: Array<{ text: string; heading?: boolean; bold?: boolean }>): string {
  return paragraphs
    .slice(0, 50)
    .map(p => {
      if (p.heading) return `# ${p.text}`
      if (p.bold) return `**${p.text}**`
      return p.text
    })
    .join('\n')
}

function formatPptxPreview (slides: Array<{ title: string; content: string[] }>): string {
  const lines: string[] = []
  for (let i = 0; i < slides.length; i++) {
    lines.push(`--- Slide ${i + 1}: ${slides[i].title} ---`)
    for (const line of slides[i].content) {
      lines.push(`  • ${line}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
