/**
 * Excel → DocumentNode[] parser.
 * Extracts sheets as top-level nodes with table rows as children.
 */
import ExcelJS from 'exceljs'
import type { DocumentNode } from './document-types.js'

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

export async function parseExcelToNodes (input: string | Buffer): Promise<DocumentNode[]> {
  nodeCounter = 0
  const workbook = new ExcelJS.Workbook()
  if (typeof input === 'string') {
    await workbook.xlsx.readFile(input)
  } else {
    await workbook.xlsx.load(input as never)
  }

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

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
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

    nodes.push(sheetNode)
  })

  return nodes
}
