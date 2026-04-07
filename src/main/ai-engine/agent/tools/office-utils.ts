import fs from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import mammoth from 'mammoth'

export type OfficeFileType = 'xlsx' | 'docx' | 'pptx' | 'unknown'

const OFFICE_EXTENSIONS: Record<string, OfficeFileType> = {
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.docx': 'docx',
  '.doc': 'docx',
  '.pptx': 'pptx',
  '.ppt': 'pptx'
}

/**
 * Detect if a file is an office document by extension.
 */
export function detectOfficeType (filePath: string): OfficeFileType {
  const ext = path.extname(filePath).toLowerCase()
  return OFFICE_EXTENSIONS[ext] || 'unknown'
}

/**
 * Check if a file is a supported office document.
 */
export function isOfficeFile (filePath: string): boolean {
  return detectOfficeType(filePath) !== 'unknown'
}

/**
 * Read an Excel file and return a structured text summary.
 */
export async function readExcelFile (filePath: string): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)

  const result: string[] = []
  result.push(`📊 Excel 文件: ${path.basename(filePath)}`)
  result.push(`工作表数量: ${workbook.worksheets.length}\n`)

  for (const worksheet of workbook.worksheets) {
    result.push(`--- 工作表: ${worksheet.name} ---`)
    result.push(`行数: ${worksheet.rowCount}, 列数: ${worksheet.columnCount}`)

    if (worksheet.rowCount === 0) {
      result.push('(空工作表)\n')
      continue
    }

    // Limit to first 100 rows for preview
    const maxRows = Math.min(worksheet.rowCount, 100)
    const rows: string[][] = []
    const colWidths: number[] = []

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > maxRows) return

      const cells: string[] = []
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const value = formatCellValue(cell)
        cells[colNumber - 1] = value
        colWidths[colNumber - 1] = Math.max(colWidths[colNumber - 1] || 0, Math.min(value.length, 30))
      })
      rows.push(cells)
    })

    // Format as table
    if (rows.length > 0) {
      const maxCol = Math.max(...rows.map(r => r.length))

      // Header row
      const headerRow = rows[0] || []
      const header = Array.from({ length: maxCol }, (_, i) => {
        const val = headerRow[i] || ''
        return val.substring(0, 30).padEnd(colWidths[i] || 2)
      })
      result.push('| ' + header.join(' | ') + ' |')
      result.push('|' + header.map((_, i) => '-'.repeat((colWidths[i] || 2) + 2)).join('|') + '|')

      // Data rows
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r]
        const formatted = Array.from({ length: maxCol }, (_, i) => {
          const val = (row[i] || '').substring(0, 30)
          return val.padEnd(colWidths[i] || 2)
        })
        result.push('| ' + formatted.join(' | ') + ' |')
      }
    }

    if (worksheet.rowCount > maxRows) {
      result.push(`\n... 已省略 ${worksheet.rowCount - maxRows} 行`)
    }
    result.push('')
  }

  return result.join('\n')
}

function formatCellValue (cell: ExcelJS.Cell): string {
  if (cell.value === null || cell.value === undefined) return ''
  if (typeof cell.value === 'object') {
    if ('result' in cell.value) {
      return String((cell.value as { result?: unknown }).result ?? '')
    }
    if ('text' in cell.value) {
      return String((cell.value as { text?: string }).text ?? '')
    }
    if (cell.value instanceof Date) {
      return cell.value.toISOString().split('T')[0]
    }
    return JSON.stringify(cell.value)
  }
  return String(cell.value)
}

/**
 * Read a Word (.docx) file and return text content.
 */
export async function readWordFile (filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  const result = await mammoth.extractRawText({ buffer })

  const lines: string[] = []
  lines.push(`📄 Word 文件: ${path.basename(filePath)}`)
  lines.push('')

  const text = result.value || ''
  // Limit output
  if (text.length > 80000) {
    lines.push(text.substring(0, 80000))
    lines.push(`\n... 内容已截断 (共 ${text.length} 字符)`)
  } else {
    lines.push(text)
  }

  if (result.messages && result.messages.length > 0) {
    lines.push('\n[解析提示]:')
    for (const msg of result.messages.slice(0, 5)) {
      lines.push(`  - ${msg.message}`)
    }
  }

  return lines.join('\n')
}

/**
 * Read a PowerPoint (.pptx) file and extract slide text.
 * Uses a lightweight approach — reads XML inside the zip.
 */
export async function readPptxFile (filePath: string): Promise<string> {
  // pptx files are zip archives; we can read them with a simple approach
  const { createReadStream } = await import('node:fs')
  const { pipeline } = await import('node:stream/promises')
  const { createUnzip } = await import('node:zlib')

  // Use a simpler approach: read the file as a buffer and extract XML
  const buffer = await fs.readFile(filePath)

  const lines: string[] = []
  lines.push(`📊 PowerPoint 文件: ${path.basename(filePath)}`)
  lines.push('')

  try {
    // pptx is a zip file, try to extract slide XML contents
    // For simplicity, we'll use the exceljs zip dependency (jszip) if available,
    // or fall back to a basic extraction
    const JSZip = (await import('exceljs')).default
    // ExcelJS uses jszip internally; we can access it through a workaround
    // Instead, let's just try to use Node's built-in capabilities

    // Direct approach: pptx is a zip, slides are in ppt/slides/slide*.xml
    const { Readable } = await import('node:stream')
    const yauzl = await tryImportYauzl()
    if (yauzl) {
      const entries = await extractPptxSlides(filePath, yauzl)
      for (const entry of entries) {
        lines.push(entry)
      }
    } else {
      // Fallback: just note the file info
      lines.push(`文件大小: ${(buffer.length / 1024).toFixed(1)} KB`)
      lines.push('(PowerPoint 文件内容提取需要额外依赖，仅显示文件信息)')
    }
  } catch (err) {
    lines.push(`文件大小: ${(buffer.length / 1024).toFixed(1)} KB`)
    lines.push(`(解析 PowerPoint 文件时出错: ${(err as Error).message})`)
  }

  return lines.join('\n')
}

async function tryImportYauzl (): Promise<unknown | null> {
  try {
    return await import('yauzl')
  } catch {
    return null
  }
}

async function extractPptxSlides (_filePath: string, _yauzl: unknown): Promise<string[]> {
  // Placeholder - yauzl may not be available
  return ['(PowerPoint 幻灯片文本提取暂不可用)']
}

/**
 * Read any supported office file and return its text content.
 */
export async function readOfficeFile (filePath: string): Promise<{ content: string; type: OfficeFileType }> {
  const type = detectOfficeType(filePath)

  switch (type) {
    case 'xlsx':
      return { content: await readExcelFile(filePath), type }
    case 'docx':
      return { content: await readWordFile(filePath), type }
    case 'pptx':
      return { content: await readPptxFile(filePath), type }
    default:
      throw new Error(`不支持的文件格式: ${path.extname(filePath)}`)
  }
}

/**
 * Generate an Excel file from structured data.
 */
export async function writeExcelFile (
  filePath: string,
  sheets: Array<{ name: string; headers: string[]; rows: unknown[][] }>
): Promise<void> {
  const workbook = new ExcelJS.Workbook()

  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name)

    // Add header row with styling
    const headerRow = worksheet.addRow(sheet.headers)
    headerRow.font = { bold: true }
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' }
      }
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.alignment = { horizontal: 'center' }
    })

    // Add data rows
    for (const row of sheet.rows) {
      worksheet.addRow(row)
    }

    // Auto-fit column widths
    worksheet.columns.forEach((column) => {
      let maxWidth = 10
      column.eachCell?.({ includeEmpty: false }, (cell) => {
        const cellWidth = String(cell.value ?? '').length + 2
        maxWidth = Math.max(maxWidth, Math.min(cellWidth, 40))
      })
      column.width = maxWidth
    })
  }

  await workbook.xlsx.writeFile(filePath)
}

/**
 * Generate a Word (.docx) file.
 * Uses officegen for Word document generation.
 */
export async function writeWordFile (
  filePath: string,
  paragraphs: Array<{ text: string; heading?: boolean; bold?: boolean }>
): Promise<void> {
  // Dynamic import for officegen (no types available)
  const officegenModule = await import('officegen')
  const officegen = officegenModule.default || officegenModule

  return new Promise((resolve, reject) => {
    const docx = officegen('docx')

    for (const para of paragraphs) {
      const p = docx.createP()
      if (para.heading) {
        p.addText(para.text, { bold: true, font_size: 16 })
      } else if (para.bold) {
        p.addText(para.text, { bold: true })
      } else {
        p.addText(para.text)
      }
    }

    const { createWriteStream } = require('node:fs') as typeof import('node:fs')
    const out = createWriteStream(filePath)

    out.on('error', reject)
    out.on('close', () => resolve())

    docx.on('error', reject)
    docx.generate(out)
  })
}

/**
 * Generate a PowerPoint (.pptx) file.
 * Uses officegen for PPTX generation.
 */
export async function writePptxFile (
  filePath: string,
  slides: Array<{ title: string; content: string[] }>
): Promise<void> {
  const officegenModule = await import('officegen')
  const officegen = officegenModule.default || officegenModule

  return new Promise((resolve, reject) => {
    const pptx = officegen('pptx')

    for (const slide of slides) {
      const s = pptx.makeNewSlide()
      s.name = slide.title
      s.addText(slide.title, { x: 50, y: 30, cx: '80%', font_size: 28, bold: true })

      let yPos = 100
      for (const line of slide.content) {
        s.addText(line, { x: 50, y: yPos, cx: '80%', font_size: 16 })
        yPos += 40
      }
    }

    const { createWriteStream } = require('node:fs') as typeof import('node:fs')
    const out = createWriteStream(filePath)

    out.on('error', reject)
    out.on('close', () => resolve())

    pptx.on('error', reject)
    pptx.generate(out)
  })
}
