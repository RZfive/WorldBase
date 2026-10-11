/**
 * Excel (xlsx) → self-contained HTML preview generator.
 *
 * Renders any OOXML spreadsheet (produced by Excel, WPS, LibreOffice, or this
 * app's own ExcelJS writer): multi-sheet tab strip (CSS-only switching, no
 * scripts so the output survives the renderer's sanitizer), merged cells,
 * column widths / row heights, cell fonts, fills, borders, alignment, number
 * results, and theme colours resolved against the workbook's own theme part.
 *
 * Charts, embedded images, slicers, and conditional formatting are outside
 * HTML table fidelity and are not rendered (cell data stays complete).
 * Output is cached on disk exactly like the Word mammoth preview, so restored
 * tabs re-display instantly without re-parsing the workbook.
 */
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { t } from '../i18n/main-i18n.js'
import { applyXlsxTint, normalizeHex } from './color-utils.js'
import {
  escapeHtml,
  fileExists,
  resolveHtmlPreviewCachePath,
  writeHtmlPreviewCache,
  wrapHtmlPreviewDocument
} from './preview-cache.js'

const MAX_ROWS = 10000
const MAX_COLS = 256
/** Hard ceiling on rendered cells so pathological sheets cannot hang the renderer. */
const MAX_CELLS = 600_000
const DEFAULT_COLUMN_CHARS = 8.43

/**
 * clrScheme slot order used for palette lookups: [dk1, lt1, dk2, lt2, accent1..6].
 * Style `theme` indices follow the UI order (0=bg1/lt1, 1=tx1/dk1, 2=bg2/lt2,
 * 3=tx2/dk2, 4..9=accent1..6), so the first four are swapped.
 */
const THEME_INDEX_TO_PALETTE = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9]

const BORDER_STYLE_CSS: Record<string, string> = {
  thin: '1px solid',
  medium: '2px solid',
  thick: '3px solid',
  hair: '1px solid',
  dotted: '1px dotted',
  dashed: '1px dashed',
  dashDot: '1px dashed',
  dashDotDot: '1px dashed',
  mediumDashed: '2px dashed',
  mediumDashDot: '2px dashed',
  mediumDashDotDot: '2px dashed',
  slantDashDot: '2px dashed',
  double: '3px double'
}

interface RunView {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  size?: number
  name?: string
}

interface SheetRender {
  name: string
  html: string
  truncated: boolean
}

type XmlElement = import('@xmldom/xmldom').Element

function firstElementByTag (root: XmlElement | null, tag: string): XmlElement | null {
  if (!root) return null
  const found = root.getElementsByTagName(tag)
  return found.length > 0 ? found[0] : null
}

function readSchemeColor (entry: XmlElement): string {
  const srgb = firstElementByTag(entry, 'a:srgbClr')
  const srgbVal = srgb?.getAttribute('val')
  if (srgbVal) return srgbVal
  const sys = firstElementByTag(entry, 'a:sysClr')
  const sysVal = sys?.getAttribute('lastClr')
  if (sysVal) return sysVal
  return ''
}

/** Reads the workbook theme palette (xl/theme/theme1.xml) for theme-colour fills/fonts. */
async function readThemePalette (buffer: Buffer): Promise<string[] | null> {
  try {
    const zip = await JSZip.loadAsync(buffer)
    const themeFile = zip.file('xl/theme/theme1.xml')
    if (!themeFile) return null
    const doc = new DOMParser().parseFromString(await themeFile.async('string'), 'application/xml')
    const scheme = firstElementByTag(doc.documentElement, 'a:clrScheme')
    if (!scheme) return null
    const slots = ['a:dk1', 'a:lt1', 'a:dk2', 'a:lt2', 'a:accent1', 'a:accent2', 'a:accent3', 'a:accent4', 'a:accent5', 'a:accent6']
    return slots.map(slot => {
      const entry = firstElementByTag(scheme, slot)
      return entry ? readSchemeColor(entry) : ''
    })
  } catch {
    return null
  }
}

function colorToCss (color: Partial<ExcelJS.Color> | undefined, palette: string[] | null): string | undefined {
  if (!color) return undefined
  const tint = typeof (color as { tint?: number }).tint === 'number' ? (color as { tint?: number }).tint! : 0
  if (typeof color.theme === 'number' && palette) {
    const slot = THEME_INDEX_TO_PALETTE[color.theme]
    const base = slot !== undefined ? palette[slot] : ''
    if (base) return `#${applyXlsxTint(base, tint)}`
  }
  const raw = typeof color.argb === 'string'
    ? color.argb
    : typeof (color as { rgb?: string }).rgb === 'string' ? (color as { rgb: string }).rgb : undefined
  const hex = raw ? normalizeHex(raw.slice(-6)) : null
  if (!hex) return undefined
  return tint ? `#${applyXlsxTint(hex, tint)}` : `#${hex}`
}

function formatCellValue (value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    const iso = value.toISOString()
    return value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0
      ? iso.split('T')[0]
      : iso.replace('T', ' ').slice(0, 19)
  }
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map(run => run.text).join('')
    }
    if ('formula' in value || 'sharedFormula' in value) {
      return String((value as { result?: unknown }).result ?? '')
    }
    if ('hyperlink' in value) {
      return String((value as { text?: unknown }).text ?? '')
    }
    if ('error' in value) {
      return String((value as { error?: unknown }).error ?? '')
    }
    if ('text' in value) {
      return String((value as { text?: unknown }).text ?? '')
    }
    return ''
  }
  return String(value)
}

function isNumericLike (value: ExcelJS.CellValue): boolean {
  return typeof value === 'number' || value instanceof Date ||
    (typeof value === 'object' && value !== null && ('formula' in value || 'sharedFormula' in value) &&
      typeof (value as { result?: unknown }).result === 'number')
}

/** Visible text runs for a cell: richText segments when present, otherwise one plain run. */
function cellRunViews (cell: ExcelJS.Cell): { text: string; runs: RunView[] } {
  const rich = typeof cell.value === 'object' && cell.value !== null && 'richText' in cell.value
    ? (cell.value as { richText?: ExcelJS.RichText[] }).richText
    : undefined
  if (rich && rich.length > 0) {
    const runs: RunView[] = rich.map(run => ({
      text: run.text ?? '',
      bold: run.font?.bold ?? cell.font?.bold,
      italic: run.font?.italic ?? cell.font?.italic,
      underline: run.font?.underline ? true : undefined,
      strike: run.font?.strike ?? cell.font?.strike
    }))
    return { text: runs.map(run => run.text).join(''), runs }
  }
  const text = formatCellValue(cell.value)
  return { text, runs: text ? [{ text }] : [] }
}

function colNameToIndex (name: string): number {
  let index = 0
  for (const ch of name.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64)
  }
  return index
}

interface MergePlan {
  anchorToSpan: Map<string, { rowspan: number; colspan: number }>
  covered: Set<string>
}

function collectMerges (sheet: ExcelJS.Worksheet): MergePlan {
  const merges: string[] = (sheet as unknown as { model?: { merges?: string[] } }).model?.merges ?? []
  const anchorToSpan = new Map<string, { rowspan: number; colspan: number }>()
  const covered = new Set<string>()
  const pattern = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/
  for (const merge of merges) {
    const match = pattern.exec(merge.trim())
    if (!match) continue
    const c1 = colNameToIndex(match[1])
    const r1 = Number(match[2])
    const c2 = colNameToIndex(match[3])
    const r2 = Number(match[4])
    if (c2 < c1 || r2 < r1) continue
    anchorToSpan.set(`${r1}:${c1}`, { rowspan: r2 - r1 + 1, colspan: c2 - c1 + 1 })
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r !== r1 || c !== c1) covered.add(`${r}:${c}`)
      }
    }
  }
  return { anchorToSpan, covered }
}

function columnWidthPx (sheet: ExcelJS.Worksheet, colNumber: number): number {
  const column = sheet.columns?.[colNumber - 1]
  const chars = typeof column?.width === 'number' && column.width > 0 ? column.width : DEFAULT_COLUMN_CHARS
  return Math.min(600, Math.max(24, Math.round(chars * 7 + 5)))
}

function runViewHtml (run: RunView): string {
  const styles: string[] = []
  if (run.bold) styles.push('font-weight:700')
  if (run.italic) styles.push('font-style:italic')
  if (run.underline) styles.push('text-decoration:underline')
  if (run.strike) styles.push('text-decoration:line-through')
  const style = styles.join(';')
  return style
    ? `<span style="${style}">${escapeHtml(run.text)}</span>`
    : escapeHtml(run.text)
}

function buildSheetHtml (sheet: ExcelJS.Worksheet, palette: string[] | null, sheetIndex: number): SheetRender {
  const { anchorToSpan, covered } = collectMerges(sheet)

  let lastRow = Math.max(sheet.rowCount, sheet.actualRowCount)
  let lastCol = Math.max(sheet.columnCount, sheet.actualColumnCount)
  for (const [key, span] of anchorToSpan.entries()) {
    const [r, c] = key.split(':').map(Number)
    lastRow = Math.max(lastRow, r + span.rowspan - 1)
    lastCol = Math.max(lastCol, c + span.colspan - 1)
  }
  lastRow = Math.max(1, lastRow)
  lastCol = Math.max(1, lastCol)

  let truncated = false
  if (lastCol > MAX_COLS) {
    lastCol = MAX_COLS
    truncated = true
  }
  if (lastRow * lastCol > MAX_CELLS) {
    lastRow = Math.max(1, Math.floor(MAX_CELLS / lastCol))
    truncated = true
  }
  if (lastRow > MAX_ROWS) {
    lastRow = MAX_ROWS
    truncated = true
  }

  const parts: string[] = ['<table class="wb-xlsx-table">']
  parts.push('<colgroup>')
  parts.push(`<col style="width:42px">`)
  for (let c = 1; c <= lastCol; c++) {
    parts.push(`<col style="width:${columnWidthPx(sheet, c)}px">`)
  }
  parts.push('</colgroup>')

  for (let r = 1; r <= lastRow; r++) {
    const row = sheet.getRow(r)
    const rowStyles: string[] = []
    if (typeof row.height === 'number' && row.height > 0) {
      rowStyles.push(`height:${Math.round(row.height * 4 / 3)}px`)
    }
    if (row.hidden) rowStyles.push('display:none')
    parts.push(`<tr${rowStyles.length ? ` style="${rowStyles.join(';')}"` : ''}>`)
    parts.push(`<td class="wb-xlsx-gutter">${r}</td>`)

    for (let c = 1; c <= lastCol; c++) {
      const anchor = anchorToSpan.get(`${r}:${c}`)
      if (covered.has(`${r}:${c}`)) continue
      const cell = row.getCell(c)
      const { runs } = cellRunViews(cell)
      const attrs: string[] = []
      const styles: string[] = []

      if (anchor) {
        if (anchor.rowspan > 1) attrs.push(`rowspan="${anchor.rowspan}"`)
        if (anchor.colspan > 1) attrs.push(`colspan="${anchor.colspan}"`)
      }

      const font = cell.font
      if (font?.name) styles.push(`font-family:'${font.name.replace(/'/g, '')}',sans-serif`)
      if (font?.size) styles.push(`font-size:${font.size}pt`)
      if (font?.bold) styles.push('font-weight:700')
      if (font?.italic) styles.push('font-style:italic')
      if (font?.underline) styles.push('text-decoration:underline')
      if (font?.strike) styles.push('text-decoration:line-through')
      const fontColor = colorToCss(font?.color, palette)
      if (fontColor) styles.push(`color:${fontColor}`)

      const fill = cell.fill
      if (fill && typeof fill === 'object' && fill.type === 'pattern' && fill.pattern === 'solid') {
        const fillColor = colorToCss(fill.fgColor, palette)
        if (fillColor) styles.push(`background:${fillColor}`)
      }

      const alignment = cell.alignment
      const horizontal = alignment?.horizontal
      if (horizontal === 'left' || horizontal === 'center' || horizontal === 'right' || horizontal === 'justify' || horizontal === 'distributed') {
        styles.push(`text-align:${horizontal === 'distributed' ? 'center' : horizontal === 'justify' ? 'left' : horizontal}`)
      } else if (isNumericLike(cell.value)) {
        styles.push('text-align:right')
      }
      const vertical = alignment?.vertical
      if (vertical === 'top') styles.push('vertical-align:top')
      else if (vertical === 'middle') styles.push('vertical-align:middle')
      else if (vertical === 'bottom' || vertical === 'justify' || vertical === 'distributed') styles.push('vertical-align:bottom')

      if (alignment?.wrapText) styles.push('white-space:pre-wrap')
      if (alignment?.textRotation === 90 || alignment?.textRotation === 255) styles.push('writing-mode:vertical-rl')

      const border = cell.border
      const sideToCss = (side?: Partial<ExcelJS.Border>) => {
        if (!side?.style) return undefined
        const borderCss = BORDER_STYLE_CSS[side.style]
        if (!borderCss) return undefined
        const borderColor = colorToCss(side.color, palette)
        return borderColor ? `${borderCss} ${borderColor}` : borderCss
      }
      const top = sideToCss(border?.top)
      const right = sideToCss(border?.right)
      const bottom = sideToCss(border?.bottom)
      const left = sideToCss(border?.left)
      if (top) styles.push(`border-top:${top}`)
      if (right) styles.push(`border-right:${right}`)
      if (bottom) styles.push(`border-bottom:${bottom}`)
      if (left) styles.push(`border-left:${left}`)

      const styleAttr = styles.length ? ` style="${styles.join(';')}"` : ''
      const content = runs.length
        ? runs.map(runViewHtml).join('')
        : ''
      parts.push(`<td${attrs.length ? ' ' + attrs.join(' ') : ''}${styleAttr}>${content}</td>`)
    }
    parts.push('</tr>')
  }
  parts.push('</table>')

  if (truncated) {
    parts.push(`<div class="wb-xlsx-notice">${escapeHtml(t('mainDialog.excelPreviewTruncated', { rows: lastRow, cols: lastCol }))}</div>`)
  }

  return { name: sheet.name || `Sheet${sheetIndex + 1}`, html: parts.join(''), truncated }
}

const XLSX_PREVIEW_CSS = `
.wb-xlsx{font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:11pt;color:#111827}
.wb-xlsx-radio{position:absolute;opacity:0;pointer-events:none}
.wb-xlsx-tabs{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 10px}
.wb-xlsx-tab{padding:4px 14px;border:1px solid #cbd5e1;border-radius:6px 6px 0 0;background:#f1f5f9;cursor:pointer;font-size:12px;color:#475569;user-select:none}
.wb-xlsx-tab:hover{background:#e2e8f0}
.wb-xlsx-pane{display:none;overflow:auto;border:1px solid #cbd5e1;border-radius:0 6px 6px 6px;background:#fff}
.wb-xlsx-single .wb-xlsx-pane{display:block;border-radius:6px}
.wb-xlsx-table{border-collapse:collapse;table-layout:fixed}
.wb-xlsx-table td{border:1px solid #e2e8f0;padding:1px 6px;overflow:hidden;white-space:pre;vertical-align:bottom;word-break:break-all}
.wb-xlsx-gutter{background:#f8fafc;color:#94a3b8;text-align:center !important;font-size:10px}
.wb-xlsx-notice{padding:8px 12px;margin-top:10px;color:#92400e;background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;font-size:12px}
`

/** Builds (or reuses from cache) a self-contained HTML preview of an xlsx workbook. */
export async function buildExcelHtmlPreview (filePath: string): Promise<string> {
  const outputPath = await resolveHtmlPreviewCachePath(filePath)
  if (await fileExists(outputPath)) return outputPath

  const buffer = await fs.readFile(filePath)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as never)
  const palette = await readThemePalette(buffer)

  const rendered: SheetRender[] = []
  workbook.worksheets.forEach(sheet => {
    if (sheet.state === 'hidden' || sheet.state === 'veryHidden') return
    rendered.push(buildSheetHtml(sheet, palette, rendered.length))
  })

  let body: string
  if (rendered.length === 0) {
    body = `<div class="wb-xlsx wb-xlsx-single" data-preview-kind="workbook"><div class="wb-xlsx-pane"><div style="padding:24px;color:#64748b">${escapeHtml(t('mainDialog.emptyDocumentPreviewText').replace(/<[^>]+>/g, ''))}</div></div></div>`
  } else if (rendered.length === 1) {
    body = `<div class="wb-xlsx wb-xlsx-single" data-preview-kind="workbook"><div class="wb-xlsx-pane">${rendered[0].html}</div></div>`
  } else {
    const instanceId = `wbx${Math.random().toString(36).slice(2, 8)}`
    const radios = rendered.map((sheet, index) =>
      `<input class="wb-xlsx-radio" type="radio" name="${instanceId}" id="${instanceId}s${index}"${index === 0 ? ' checked' : ''}>`
    ).join('')
    const tabs = rendered.map((sheet, index) =>
      `<label class="wb-xlsx-tab" for="${instanceId}s${index}">${escapeHtml(sheet.name)}</label>`
    ).join('')
    const rules = rendered.map((_, index) =>
      `#${instanceId}s${index}:checked ~ .wb-xlsx-tabs label[for="${instanceId}s${index}"]{background:#fff;color:#0f172a;font-weight:600}` +
      `#${instanceId}s${index}:checked ~ .wb-xlsx-panes .wb-xlsx-pane:nth-child(${index + 1}){display:block}`
    ).join('\n')
    const panes = rendered.map(sheet => `<div class="wb-xlsx-pane">${sheet.html}</div>`).join('')
    body = `<div class="wb-xlsx" data-preview-kind="workbook">${radios}<div class="wb-xlsx-tabs">${tabs}</div><div class="wb-xlsx-panes">${panes}</div><style>${rules}</style></div>`
  }

  const html = wrapHtmlPreviewDocument(path.basename(filePath), body, XLSX_PREVIEW_CSS)
  await writeHtmlPreviewCache(outputPath, html)
  return outputPath
}
