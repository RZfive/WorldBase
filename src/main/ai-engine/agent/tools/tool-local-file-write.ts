import fs from 'node:fs/promises'
import path from 'node:path'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback, SessionState } from '../agent-core.js'
import type { BrowserWindow } from 'electron'
import { requestUserAuth } from './user-auth.js'
import { writeExcelFile, writeWordFile, writePptxFile } from './office-utils.js'

/** Maximum characters for office file preview content. */
const MAX_PREVIEW_LENGTH = 8000

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
export function toolLocalWriteFile (services: ToolServices, getSessionState?: () => SessionState): Tool {
  return {
    definition: {
      name: 'local_write_file',
      description: '在用户本地电脑创建或写入文件。执行前需要用户授权。支持创建办公文件（.xlsx, .docx, .pptx），也支持写入普通文本文件。',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '文件保存的绝对路径，例如 /Users/xxx/Documents/report.xlsx'
          },
          content: {
            type: 'string',
            description: '文本文件的内容。如果是办公文件格式，请使用 office_data 参数'
          },
          office_data: {
            type: 'object',
            description: '办公文件的结构化数据。type 指定文件类型（xlsx/docx/pptx）',
            properties: {
              type: {
                type: 'string',
                enum: ['xlsx', 'docx', 'pptx'],
                description: '办公文件类型'
              },
              sheets: {
                type: 'array',
                description: 'Excel 工作表数据，每个元素包含 name（表名）、headers（列标题数组）和 rows（数据行二维数组）',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    headers: { type: 'array', items: { type: 'string' } },
                    rows: { type: 'array', items: { type: 'array' } }
                  }
                }
              },
              paragraphs: {
                type: 'array',
                description: 'Word 文档段落，每个元素包含 text（文本）、heading（是否标题）和 bold（是否加粗）',
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
                description: 'PowerPoint 幻灯片，每个元素包含 title（标题）和 content（内容行数组）',
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
        'AI 请求写入本地文件',
        `AI 助手请求在以下路径创建文件:\n\n${resolvedPath}\n\n是否允许？`
      )

      if (!authorized) {
        return { error: '用户拒绝了文件写入请求', file_path: resolvedPath }
      }

      // Ensure parent directory exists
      const dir = path.dirname(resolvedPath)
      await fs.mkdir(dir, { recursive: true })

      if (office_data) {
        return await writeOfficeDocument(resolvedPath, office_data, onProgress)
      }

      // Plain text file
      if (content === undefined || content === null) {
        throw new Error('必须提供 content（文本内容）或 office_data（办公文件数据）')
      }

      onProgress?.('📝 写入文本文件...', resolvedPath)
      await fs.writeFile(resolvedPath, content, 'utf-8')
      onProgress?.('✅ 文件写入完成', resolvedPath)

      return {
        success: true,
        file_path: resolvedPath,
        size: Buffer.byteLength(content, 'utf-8'),
        message: `文件已保存: ${resolvedPath}`
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
        throw new Error('Excel 文件需要提供 sheets 数据')
      }
      onProgress?.('📊 生成 Excel 文件...', filePath)
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
        throw new Error('Word 文件需要提供 paragraphs 数据')
      }
      onProgress?.('📄 生成 Word 文件...', filePath)
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
        throw new Error('PowerPoint 文件需要提供 slides 数据')
      }
      onProgress?.('📊 生成 PowerPoint 文件...', filePath)
      await writePptxFile(filePath, data.slides)

      // Emit a text preview of the PPT content
      if (onProgress) {
        const previewText = formatPptxPreview(data.slides)
        emitFilePreview(onProgress, filePath, previewText)
      }
      break
    }

    default:
      throw new Error(`不支持的办公文件类型: ${data.type}。支持的类型: xlsx, docx, pptx`)
  }

  const stat = await fs.stat(filePath)
  onProgress?.('✅ 办公文件已生成', `${(stat.size / 1024).toFixed(1)} KB`)

  return {
    success: true,
    file_path: filePath,
    file_type: data.type,
    size: stat.size,
    message: `${data.type.toUpperCase()} 文件已保存: ${filePath}`
  }
}

function emitFilePreview (onProgress: ProgressCallback, filePath: string, content: string): void {
  const truncated = content.length > MAX_PREVIEW_LENGTH
  onProgress({ type: 'file_preview_start', filePath, truncated })
  // Send in a single chunk for simplicity
  onProgress({ type: 'file_preview_chunk', filePath, content: truncated ? content.substring(0, MAX_PREVIEW_LENGTH) : content })
  onProgress({ type: 'file_preview_end', filePath, truncated })
}

function formatExcelPreview (sheets: Array<{ name: string; headers: string[]; rows: unknown[][] }>): string {
  const lines: string[] = []
  for (const sheet of sheets) {
    lines.push(`📊 工作表: ${sheet.name}`)
    lines.push('| ' + sheet.headers.join(' | ') + ' |')
    lines.push('|' + sheet.headers.map(() => '---').join('|') + '|')
    const maxRows = Math.min(sheet.rows.length, 20)
    for (let i = 0; i < maxRows; i++) {
      lines.push('| ' + sheet.rows[i].map(v => String(v ?? '')).join(' | ') + ' |')
    }
    if (sheet.rows.length > maxRows) {
      lines.push(`... 共 ${sheet.rows.length} 行`)
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
    lines.push(`--- 幻灯片 ${i + 1}: ${slides[i].title} ---`)
    for (const line of slides[i].content) {
      lines.push(`  • ${line}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
