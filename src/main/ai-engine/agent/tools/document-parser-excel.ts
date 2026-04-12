/**
 * Excel → DocumentNode[] parser.
 * Extracts sheets as top-level nodes with table rows as children.
 */
import ExcelJS from 'exceljs'
import type { DocumentNode } from './document-types.js'

const MAX_PREVIEW_ROWS = 200

let nodeCounter = 0
function nextId (): string {
  return `xls_${++nodeCounter}`
}

function formatCellValue (cell: ExcelJS.Cell): string {
  if (cell.value === null || cell.value === undefined) return ''
  if (typeof cell.value === 'object') {
    if ('result' in cell.value) return String((cell.value as { result?: unknown }).result ?? '')
    if ('text' in cell.value) return String((cell.value as { text?: string }).text ?? '')
    if (cell.value instanceof Date) return cell.value.toISOString().split('T')[0]
    return JSON.stringify(cell.value)
  }
  return String(cell.value)
}

export async function parseExcelToNodes (filePath: string): Promise<DocumentNode[]> {
  nodeCounter = 0
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)

  const nodes: DocumentNode[] = []

  workbook.worksheets.forEach((worksheet, sheetIdx) => {
    // Collect header names from first row before building the sheet meta.
    const headers: string[] = []
    const firstRow = worksheet.getRow(1)
    if (firstRow) {
      firstRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        headers[colNumber - 1] = formatCellValue(cell)
      })
    }

    const sheetNode: DocumentNode = {
      id: nextId(),
      type: 'sheet',
      text: worksheet.name || `Sheet${sheetIdx + 1}`,
      level: 0,
      pageIndex: sheetIdx + 1,
      children: [],
      meta: { rowCount: worksheet.rowCount, columnCount: worksheet.columnCount, headers }
    }

    let rowNum = 0
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNum >= MAX_PREVIEW_ROWS) return
      rowNum++

      const cells: string[] = []
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cells[colNumber - 1] = formatCellValue(cell)
      })

      const rowText = cells.map((val, i) => {
        const header = headers[i]
        return header ? `${header}: ${val || ''}` : (val || '')
      }).filter(Boolean).join(' | ')

      sheetNode.children!.push({
        id: nextId(),
        type: 'table_row',
        text: rowText,
        level: 1,
        pageIndex: sheetIdx + 1,
        meta: { rowNumber, cells }
      })
    })

    if (worksheet.rowCount > MAX_PREVIEW_ROWS) {
      sheetNode.children!.push({
        id: nextId(),
        type: 'paragraph',
        text: `... 省略余下 ${worksheet.rowCount - MAX_PREVIEW_ROWS} 行`,
        level: 1,
        pageIndex: sheetIdx + 1
      })
    }

    nodes.push(sheetNode)
  })

  return nodes
}
