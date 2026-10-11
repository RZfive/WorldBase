/**
 * PowerPoint (pptx) → self-contained HTML preview generator.
 *
 * Renders decks produced by any authoring tool (PowerPoint, WPS, LibreOffice,
 * Keynote export, or this app's officegen writer) by walking the OOXML parts:
 * slide order from presentation.xml, placeholder geometry inherited through the
 * slideLayout → slideMaster chain, theme colours resolved against theme1.xml
 * (with lumMod/lumOff/tint/shade transforms), grouped shapes recursed with
 * their child coordinate systems, images inlined as data URLs, and tables from
 * a:tbl. Charts / SmartArt / OLE degrade to labelled placeholder boxes.
 *
 * Slides are laid out as aspect-correct canvases scaled purely with CSS
 * container-query units (cqw), so the output has no scripts and survives the
 * renderer's sanitizer. Like the Word/Excel previews the HTML is cached on
 * disk keyed by path/size/mtime and restores instantly after a restart.
 */
import JSZip from 'jszip'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { t } from '../i18n/main-i18n.js'
import { applyPptxColorMods, normalizeHex, type PptxColorMods } from './color-utils.js'
import {
  escapeHtml,
  fileExists,
  resolveHtmlPreviewCachePath,
  writeHtmlPreviewCache,
  wrapHtmlPreviewDocument
} from './preview-cache.js'

type XmlElement = import('@xmldom/xmldom').Element
type XmlNode = import('@xmldom/xmldom').Node
type XmlDocument = import('@xmldom/xmldom').Document

const EMU_PER_PT = 12700
const DEFAULT_SLIDE_W = 9144000
const DEFAULT_SLIDE_H = 6858000
const MAX_SLIDES = 500
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 48 * 1024 * 1024
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f]/
const COLOR_TAGS = new Set(['srgbClr', 'schemeClr', 'sysClr'])

type ThemePalette = Record<string, string>
type Transform = (xfrm: Xfrm) => Xfrm

interface Xfrm {
  x: number
  y: number
  cx: number
  cy: number
  rot?: number
}

interface PhRef {
  type: string
  idx: string
}

interface RunSpec {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  sizePt?: number
  fontFamily?: string
}

interface ParaSpec {
  runs: RunSpec[]
  align?: 'left' | 'center' | 'right'
  bullet?: string
  bulletNumber?: number
  indentEmu?: number
  lineRatio?: number
}

interface CategoryDefaults {
  sizePt?: number
  bold?: boolean
  color?: string
}

interface BodyInsets {
  l: number
  t: number
  r: number
  b: number
}

interface SlideRenderContext {
  zip: JSZip
  palette: ThemePalette
  slideW: number
  slideH: number
  rels: Map<string, string>
  layout: XmlDocument | null
  master: XmlDocument | null
  masterTextStyles: Map<string, Map<number, CategoryDefaults>> | null
  imageData: Map<string, string | null>
  imageBudget: { remaining: number }
}

// ---------------------------------------------------------------------------
// DOM helpers (namespace-agnostic)
// ---------------------------------------------------------------------------

function localName (node: XmlNode): string {
  const name = node.nodeName
  const idx = name.indexOf(':')
  return idx >= 0 ? name.slice(idx + 1) : name
}

function childEl (parent: XmlNode | null, name: string): XmlElement | null {
  if (!parent) return null
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && localName(node) === name) return node as XmlElement
  }
  return null
}

function childEls (parent: XmlNode | null, name: string): XmlElement[] {
  const result: XmlElement[] = []
  if (!parent) return result
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && localName(node) === name) result.push(node as XmlElement)
  }
  return result
}

/** All direct element children regardless of local name. */
function allChildEls (parent: XmlNode | null): XmlElement[] {
  const result: XmlElement[] = []
  if (!parent) return result
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) result.push(node as XmlElement)
  }
  return result
}

function descendantEl (parent: XmlElement | null, name: string): XmlElement | null {
  if (!parent) return null
  const found = parent.getElementsByTagName('*')
  for (let i = 0; i < found.length; i++) {
    if (localName(found[i]) === name) return found[i]
  }
  return null
}

function attrStr (el: XmlElement | null, name: string): string | undefined {
  if (!el) return undefined
  const value = el.getAttribute(name)
  return value === '' || value === null ? undefined : value
}

function attrNum (el: XmlElement | null, name: string): number | undefined {
  const value = attrStr(el, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function elText (el: XmlElement | null): string {
  return el?.textContent ?? ''
}

function parseXml (xml: string): XmlDocument {
  return new DOMParser().parseFromString(xml, 'application/xml') as unknown as XmlDocument
}

// ---------------------------------------------------------------------------
// Theme / colour resolution
// ---------------------------------------------------------------------------

function parseThemePalette (themeXml: XmlDocument | null): ThemePalette {
  const palette: ThemePalette = {}
  const scheme = descendantEl(themeXml?.documentElement ?? null, 'clrScheme')
  if (!scheme) return palette
  const slots = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
  for (const slot of slots) {
    const entry = childEl(scheme, slot)
    if (!entry) continue
    const hex = normalizeHex(
      attrStr(entry.getElementsByTagName('srgbClr')[0] ?? null, 'val') ??
      attrStr(entry.getElementsByTagName('sysClr')[0] ?? null, 'lastClr') ?? ''
    )
    if (hex) palette[slot] = hex
  }
  return palette
}

function resolveSchemeName (palette: ThemePalette, name: string): string | undefined {
  if (palette[name]) return palette[name]
  const aliases: Record<string, string> = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2', phClr: 'accent1' }
  const aliased = aliases[name]
  return aliased ? palette[aliased] : undefined
}

function modsOf (colorEl: XmlElement): PptxColorMods {
  const mods: PptxColorMods = {}
  for (const mod of allChildEls(colorEl)) {
    const name = localName(mod)
    const value = attrNum(mod, 'val')
    if (value === undefined) continue
    if (name === 'lumMod') mods.lumMod = value / 100000
    else if (name === 'lumOff') mods.lumOff = value / 100000
    else if (name === 'tint') mods.tint = value / 100000
    else if (name === 'shade') mods.shade = value / 100000
    else if (name === 'satMod') mods.satMod = value / 100000
  }
  return mods
}

/** Parses a colour element (srgbClr / schemeClr / sysClr) with its transforms; returns raw RRGGBB. */
function parseColorEl (colorEl: XmlElement, palette: ThemePalette): string | undefined {
  const tag = localName(colorEl)
  let base: string | undefined
  if (tag === 'srgbClr' || tag === 'sysClr') {
    base = normalizeHex(attrStr(colorEl, 'val') ?? attrStr(colorEl, 'lastClr') ?? '') ?? undefined
  } else if (tag === 'schemeClr') {
    base = resolveSchemeName(palette, attrStr(colorEl, 'val') ?? '')
  }
  if (!base) return undefined
  const mods = modsOf(colorEl)
  return Object.keys(mods).length ? applyPptxColorMods(base, mods) : base
}

/** First explicit colour under a fill container (solidFill / gradFill first stop); raw RRGGBB. */
function solidColorUnder (container: XmlElement | null, palette: ThemePalette): string | undefined {
  if (!container) return undefined
  const scan = (el: XmlElement): string | undefined => {
    const found = el.getElementsByTagName('*')
    for (let i = 0; i < found.length; i++) {
      if (COLOR_TAGS.has(localName(found[i]))) return parseColorEl(found[i], palette)
    }
    return undefined
  }
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType !== 1) continue
    const el = node as XmlElement
    const tag = localName(el)
    if (COLOR_TAGS.has(tag)) return parseColorEl(el, palette)
    if (tag === 'solidFill' || tag === 'gradFill' || tag === 'pattFill') return scan(el)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// zip / rels helpers
// ---------------------------------------------------------------------------

function resolveZipPath (baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const segments = `${baseDir}/${target}`.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

function zipRelsPath (zipPath: string): string {
  const dir = path.posix.dirname(zipPath)
  const base = path.posix.basename(zipPath)
  return `${dir}/_rels/${base}.rels`
}

async function loadRels (zip: JSZip, relsPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const file = zip.file(relsPath)
  if (!file) return map
  try {
    const doc = parseXml(await file.async('string'))
    const relationships = doc.getElementsByTagName('Relationship')
    const baseDir = path.posix.dirname(path.posix.dirname(relsPath))
    for (let i = 0; i < relationships.length; i++) {
      const rel = relationships[i]
      const id = attrStr(rel, 'Id')
      const target = attrStr(rel, 'Target')
      if (id && target) map.set(id, resolveZipPath(baseDir, target))
    }
  } catch {
    // missing/broken rels part → empty map, callers fall back to defaults
  }
  return map
}

async function zipXml (zip: JSZip, zipPath: string): Promise<XmlDocument | null> {
  const file = zip.file(zipPath)
  if (!file) return null
  try {
    return parseXml(await file.async('string'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// geometry / placeholders
// ---------------------------------------------------------------------------

const identityTransform: Transform = xfrm => xfrm

function composeGroupTransform (
  outer: Transform,
  group: Xfrm,
  chOff: { x: number; y: number },
  chExt: { cx: number; cy: number }
): Transform {
  const scaleX = chExt.cx > 0 ? group.cx / chExt.cx : 1
  const scaleY = chExt.cy > 0 ? group.cy / chExt.cy : 1
  return xfrm => outer({
    x: group.x + (xfrm.x - chOff.x) * scaleX,
    y: group.y + (xfrm.y - chOff.y) * scaleY,
    cx: xfrm.cx * scaleX,
    cy: xfrm.cy * scaleY,
    rot: xfrm.rot
  })
}

function parseXfrm (container: XmlElement | null): Xfrm | null {
  const xfrm = childEl(container, 'xfrm')
  if (!xfrm) return null
  const off = childEl(xfrm, 'off')
  const ext = childEl(xfrm, 'ext')
  if (!off && !ext) return null
  const rotRaw = attrNum(xfrm, 'rot')
  return {
    x: attrNum(off, 'x') ?? 0,
    y: attrNum(off, 'y') ?? 0,
    cx: attrNum(ext, 'cx') ?? 0,
    cy: attrNum(ext, 'cy') ?? 0,
    rot: rotRaw !== undefined ? rotRaw / 60000 : undefined
  }
}

function readPh (el: XmlElement): PhRef | null {
  const ph = descendantEl(el, 'ph')
  if (!ph) return null
  return { type: attrStr(ph, 'type') ?? 'body', idx: attrStr(ph, 'idx') ?? '0' }
}

const SAME_PLACEHOLDER_TYPES = new Set(['title', 'ctrTitle'])

/** Placeholder geometry lookup across the layout and master spTrees. */
function inheritPhXfrm (ph: PhRef | null, ctx: SlideRenderContext): Xfrm | null {
  if (!ph) return null
  for (const doc of [ctx.layout, ctx.master]) {
    const spTree = descendantEl(doc?.documentElement ?? null, 'spTree')
    if (!spTree) continue
    for (const sp of allChildEls(spTree)) {
      const tag = localName(sp)
      if (tag !== 'sp' && tag !== 'pic' && tag !== 'graphicFrame' && tag !== 'cxnSp') continue
      const candidate = readPh(sp)
      if (!candidate) continue
      const typeMatches = candidate.type === ph.type ||
        (SAME_PLACEHOLDER_TYPES.has(ph.type) && SAME_PLACEHOLDER_TYPES.has(candidate.type)) ||
        (ph.type === 'body' && candidate.type === 'obj' && candidate.idx === ph.idx)
      if (!typeMatches || candidate.idx !== ph.idx) continue
      const xfrm = parseXfrm(descendantEl(sp, 'spPr'))
      if (xfrm) return xfrm
    }
  }
  return null
}

function phCategory (ph: PhRef | null): 'title' | 'body' | 'other' {
  const type = ph?.type ?? 'body'
  if (type === 'title' || type === 'ctrTitle') return 'title'
  if (type === 'dt' || type === 'ftr' || type === 'sldNum') return 'other'
  return 'body'
}

function parseMasterTextStyles (
  master: XmlDocument | null,
  palette: ThemePalette
): Map<string, Map<number, CategoryDefaults>> | null {
  if (!master) return null
  const txStyles = descendantEl(master.documentElement, 'txStyles')
  if (!txStyles) return null
  const result = new Map<string, Map<number, CategoryDefaults>>()
  const categories: Array<{ key: string; tag: string }> = [
    { key: 'title', tag: 'titleStyle' },
    { key: 'body', tag: 'bodyStyle' },
    { key: 'other', tag: 'otherStyle' }
  ]
  for (const { key, tag } of categories) {
    const styleEl = childEl(txStyles, tag)
    if (!styleEl) continue
    const levels = new Map<number, CategoryDefaults>()
    for (let level = 0; level <= 8; level++) {
      const lvlPr = childEl(styleEl, `lvl${level + 1}pPr`)
      const defRPr = childEl(lvlPr, 'defRPr')
      if (!defRPr) continue
      const sizeRaw = attrNum(defRPr, 'sz')
      const defaults: CategoryDefaults = {}
      if (sizeRaw !== undefined) defaults.sizePt = sizeRaw / 100
      if (attrStr(defRPr, 'b') === '1') defaults.bold = true
      const color = solidColorUnder(defRPr, palette)
      if (color) defaults.color = `#${color}`
      levels.set(level, defaults)
    }
    result.set(key, levels)
  }
  return result.size > 0 ? result : null
}

// ---------------------------------------------------------------------------
// text parsing
// ---------------------------------------------------------------------------

function runFontFamily (rPr: XmlElement | null, text: string): string | undefined {
  const latin = attrStr(childEl(rPr, 'latin'), 'typeface')
  const ea = attrStr(childEl(rPr, 'ea'), 'typeface')
  if (ea && CJK_PATTERN.test(text)) return `'${ea.replace(/'/g, '')}', sans-serif`
  if (latin) return `'${latin.replace(/'/g, '')}', sans-serif`
  return undefined
}

function parseRun (run: XmlElement, ctx: SlideRenderContext, fallback: CategoryDefaults): RunSpec | null {
  const tag = localName(run)
  if (tag === 'br') return { text: '\n' }
  const text = elText(childEl(run, 't'))
  if (!text) return null

  const rPr = childEl(run, 'rPr')
  const sizeRaw = attrNum(rPr, 'sz')
  const spec: RunSpec = {
    text,
    sizePt: sizeRaw !== undefined ? sizeRaw / 100 : fallback.sizePt
  }
  if (!rPr) return spec
  if (attrStr(rPr, 'b') === '1' || (attrStr(rPr, 'b') === undefined && fallback.bold)) spec.bold = true
  if (attrStr(rPr, 'i') === '1') spec.italic = true
  const underline = attrStr(rPr, 'u')
  if (underline && underline !== 'none') spec.underline = true
  if (attrStr(rPr, 'strike') === 'sngStrike') spec.strike = true
  const color = solidColorUnder(rPr, ctx.palette)
  spec.color = color ? `#${color}` : fallback.color
  const family = runFontFamily(rPr, text)
  if (family) spec.fontFamily = family
  return spec
}

function parseTxBody (
  txBody: XmlElement | null,
  ctx: SlideRenderContext,
  ph: PhRef | null
): { paras: ParaSpec[]; anchor: string; fontScale?: number; insets: BodyInsets } {
  if (!txBody) {
    return { paras: [], anchor: 'flex-start', insets: { l: 91440, t: 45720, r: 91440, b: 45720 } }
  }
  const bodyPr = childEl(txBody, 'bodyPr')
  const anchorAttr = attrStr(bodyPr, 'anchor')
  const anchor = anchorAttr === 'ctr' ? 'center' : anchorAttr === 'b' ? 'flex-end' : 'flex-start'
  const fontScaleRaw = attrNum(descendantEl(bodyPr, 'normAutofit'), 'fontScale')
  const fontScale = fontScaleRaw !== undefined ? fontScaleRaw / 100000 : undefined
  const insets: BodyInsets = {
    l: attrNum(bodyPr, 'lIns') ?? 91440,
    t: attrNum(bodyPr, 'tIns') ?? 45720,
    r: attrNum(bodyPr, 'rIns') ?? 91440,
    b: attrNum(bodyPr, 'bIns') ?? 45720
  }

  const category = phCategory(ph)
  const lstStyle = childEl(txBody, 'lstStyle')
  const paras: ParaSpec[] = []
  let autoNumber = 0

  for (const p of childEls(txBody, 'p')) {
    const pPr = childEl(p, 'pPr')
    const levelRaw = attrNum(pPr, 'lvl')
    const level = levelRaw !== undefined ? Math.max(0, Math.min(8, Math.round(levelRaw))) : 0

    const masterDefaults = ctx.masterTextStyles?.get(category)?.get(level) ??
      ctx.masterTextStyles?.get(category)?.get(0) ?? {}
    const localPr = lstStyle ? childEl(lstStyle, `lvl${level + 1}pPr`) : null
    const localSize = attrNum(childEl(localPr, 'defRPr'), 'sz')
    const fallback: CategoryDefaults = {
      sizePt: localSize !== undefined ? localSize / 100 : masterDefaults.sizePt ?? (category === 'title' ? 40 : 18),
      bold: masterDefaults.bold,
      color: masterDefaults.color
    }

    const para: ParaSpec = { runs: [] }
    const algn = attrStr(pPr, 'algn')
    if (algn === 'l' || algn === 'ctr' || algn === 'r' || algn === 'just') {
      para.align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : 'left'
    }
    const marL = attrNum(pPr, 'marL')
    if (marL !== undefined && marL > 0) para.indentEmu = marL
    const buChar = childEl(pPr, 'buChar')
    const buAutoNum = childEl(pPr, 'buAutoNum')
    const buNone = childEl(pPr, 'buNone')
    if (!buNone) {
      if (buChar) para.bullet = attrStr(buChar, 'char') ?? '•'
      else if (buAutoNum) para.bulletNumber = ++autoNumber
      else if (marL !== undefined && marL > 0 && category === 'body') para.bullet = '•'
    }
    const lnSpc = descendantEl(pPr, 'spcPct')
    if (lnSpc) {
      const pctValue = attrNum(lnSpc, 'val')
      if (pctValue !== undefined) para.lineRatio = Math.max(0.5, Math.min(4, pctValue / 100000))
    }

    for (const node of Array.from(p.childNodes)) {
      if (node.nodeType !== 1) continue
      const el = node as XmlElement
      const tag = localName(el)
      if (tag !== 'r' && tag !== 'br' && tag !== 'fld') continue
      const run = parseRun(el, ctx, fallback)
      if (run) para.runs.push(run)
    }
    if (para.runs.length > 0) paras.push(para)
  }
  return { paras, anchor, fontScale, insets }
}

// ---------------------------------------------------------------------------
// element rendering
// ---------------------------------------------------------------------------

function pct (value: number, total: number): string {
  return `${(value / total * 100).toFixed(3)}%`
}

function cqwOf (emu: number, slideW: number): string {
  return `${(emu / slideW * 100).toFixed(3)}cqw`
}

function positionCss (xfrm: Xfrm, ctx: SlideRenderContext): string {
  const styles = [
    `left:${pct(xfrm.x, ctx.slideW)}`,
    `top:${pct(xfrm.y, ctx.slideH)}`,
    `width:${pct(xfrm.cx, ctx.slideW)}`,
    `height:${pct(xfrm.cy, ctx.slideH)}`
  ]
  if (xfrm.rot) styles.push(`transform:rotate(${xfrm.rot.toFixed(2)}deg)`)
  return styles.join(';')
}

function runCss (run: RunSpec, ctx: SlideRenderContext, fontScale?: number): string {
  const styles: string[] = []
  if (run.sizePt !== undefined) {
    styles.push(`font-size:${cqwOf(run.sizePt * (fontScale ?? 1) * EMU_PER_PT, ctx.slideW)}`)
  }
  if (run.bold) styles.push('font-weight:700')
  if (run.italic) styles.push('font-style:italic')
  const decorations: string[] = []
  if (run.underline) decorations.push('underline')
  if (run.strike) decorations.push('line-through')
  if (decorations.length) styles.push(`text-decoration:${decorations.join(' ')}`)
  if (run.color) styles.push(`color:${run.color}`)
  if (run.fontFamily) styles.push(`font-family:${run.fontFamily}`)
  return styles.join(';')
}

function renderTextBody (txBody: XmlElement | null, ctx: SlideRenderContext, ph: PhRef | null): string {
  const { paras, anchor, fontScale, insets } = parseTxBody(txBody, ctx, ph)
  if (paras.length === 0) return ''
  const paragraphs = paras.map(para => {
    const styles = ['margin:0']
    if (para.align) styles.push(`text-align:${para.align}`)
    if (para.indentEmu !== undefined) styles.push(`padding-left:${cqwOf(para.indentEmu, ctx.slideW)}`)
    if (para.lineRatio) styles.push(`line-height:${para.lineRatio.toFixed(2)}`)
    const prefix = para.bullet
      ? `<span>${escapeHtml(para.bullet)} </span>`
      : para.bulletNumber !== undefined
        ? `<span>${para.bulletNumber}. </span>`
        : ''
    const runs = para.runs.map(run => {
      const css = runCss(run, ctx, fontScale)
      const text = escapeHtml(run.text).replace(/\n/g, '<br>')
      return css ? `<span style="${css}">${text}</span>` : text
    }).join('')
    return `<p class="wb-pptx-p" style="${styles.join(';')}">${prefix}${runs}</p>`
  }).join('')
  const padding = `${cqwOf(insets.t, ctx.slideW)} ${cqwOf(insets.r, ctx.slideW)} ${cqwOf(insets.b, ctx.slideW)} ${cqwOf(insets.l, ctx.slideW)}`
  return `<div class="wb-pptx-text" style="justify-content:${anchor};padding:${padding}">${paragraphs}</div>`
}

async function imageDataUrl (ctx: SlideRenderContext, zipPath: string): Promise<string | null> {
  if (ctx.imageData.has(zipPath)) return ctx.imageData.get(zipPath) ?? null
  let result: string | null = null
  const file = ctx.zip.file(zipPath)
  if (file) {
    const bytes = await file.async('nodebuffer')
    if (bytes.length <= MAX_IMAGE_BYTES && bytes.length <= ctx.imageBudget.remaining) {
      const ext = path.posix.extname(zipPath).slice(1).toLowerCase()
      const mime = ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'svg'
          ? 'image/svg+xml'
          : ext === 'webp'
            ? 'image/webp'
            : ext === 'gif'
              ? 'image/gif'
              : ext === 'bmp'
                ? 'image/bmp'
                : 'image/png'
      result = `data:${mime};base64,${bytes.toString('base64')}`
      ctx.imageBudget.remaining -= bytes.length
    }
  }
  ctx.imageData.set(zipPath, result)
  return result
}

function degradedBoxCss (xfrm: Xfrm, ctx: SlideRenderContext): string {
  return `${positionCss(xfrm, ctx)};font-size:${cqwOf(1.4 * EMU_PER_PT, ctx.slideW)}`
}

async function renderSp (sp: XmlElement, ctx: SlideRenderContext, transform: Transform, isConnector: boolean): Promise<string | null> {
  const spPr = childEl(sp, 'spPr')
  const ph = readPh(sp)
  let xfrm = parseXfrm(spPr)
  if (!xfrm) xfrm = inheritPhXfrm(ph, ctx)
  if (!xfrm || xfrm.cx <= 0 || xfrm.cy <= 0) return null
  xfrm = transform(xfrm)

  const fill = childEl(spPr, 'noFill') ? undefined : solidColorUnder(spPr, ctx.palette)
  const ln = childEl(spPr, 'ln')
  const lineColor = ln && !childEl(ln, 'noFill') ? solidColorUnder(ln, ctx.palette) : undefined
  const lineW = attrNum(ln, 'w')
  const textHtml = renderTextBody(childEl(sp, 'txBody'), ctx, ph)

  const styles = ['position:absolute', 'box-sizing:border-box', positionCss(xfrm, ctx)]
  if (isConnector) {
    // connectors render as a thin bar in the line colour; curved paths degrade to the bounding box
    if (lineColor) styles.push(`background:#${lineColor}`)
    else styles.push('background:#94a3b8')
    if (lineW) styles.push(`min-height:${cqwOf(lineW, ctx.slideW)}`)
    return `<div class="wb-pptx-el" style="${styles.join(';')}"></div>`
  }
  if (fill) styles.push(`background:#${fill}`)
  if (lineColor) {
    const width = lineW !== undefined ? Math.max(1, Math.round(lineW / EMU_PER_PT)) : 1
    styles.push(`border:${width}px solid #${lineColor}`)
  }
  if (!textHtml && !fill && !lineColor) return null
  return `<div class="wb-pptx-el" style="${styles.join(';')}">${textHtml}</div>`
}

async function renderPic (pic: XmlElement, ctx: SlideRenderContext, transform: Transform): Promise<string | null> {
  const spPr = childEl(pic, 'spPr')
  const xfrmRaw = parseXfrm(spPr)
  if (!xfrmRaw || xfrmRaw.cx <= 0 || xfrmRaw.cy <= 0) return null
  const xfrm = transform(xfrmRaw)

  const blip = descendantEl(childEl(pic, 'blipFill'), 'blip')
  const rid = attrStr(blip, 'r:embed') ?? attrStr(blip, 'r:link')
  const zipPath = rid ? ctx.rels.get(rid) : undefined
  const dataUrl = zipPath ? await imageDataUrl(ctx, zipPath) : null

  if (!dataUrl) {
    const label = escapeHtml(t('mainDialog.pptxImageOversize'))
    return `<div class="wb-pptx-el wb-pptx-ph" style="${degradedBoxCss(xfrm, ctx)}">${label}</div>`
  }
  return `<div class="wb-pptx-el" style="position:absolute;${positionCss(xfrm, ctx)}"><img src="${dataUrl}" style="width:100%;height:100%;object-fit:fill;display:block;margin:0" alt=""></div>`
}

function renderTable (graphicFrame: XmlElement, xfrm: Xfrm, ctx: SlideRenderContext): string {
  const tbl = descendantEl(graphicFrame, 'tbl')
  if (!tbl) return ''
  const grid = childEls(descendantEl(tbl, 'tblGrid'), 'gridCol').map(col => attrNum(col, 'w') ?? 0)
  const totalGrid = grid.reduce((sum, w) => sum + w, 0) || 1

  const parts = ['<table class="wb-pptx-tbl" style="width:100%;height:100%;table-layout:fixed;border-collapse:collapse">']
  parts.push('<colgroup>')
  for (const w of grid) parts.push(`<col style="width:${(w / totalGrid * 100).toFixed(2)}%">`)
  parts.push('</colgroup>')

  for (const tr of childEls(tbl, 'tr')) {
    const height = attrNum(tr, 'h')
    parts.push(`<tr${height ? ` style="height:${pct(height, xfrm.cy)}"` : ''}>`)
    for (const tc of childEls(tr, 'tc')) {
      if (attrStr(tc, 'hMerge') === '1' || attrStr(tc, 'vMerge') === '1') continue
      const attrs: string[] = []
      const gridSpan = attrNum(tc, 'gridSpan')
      const rowSpan = attrNum(tc, 'rowSpan')
      if (gridSpan && gridSpan > 1) attrs.push(`colspan="${gridSpan}"`)
      if (rowSpan && rowSpan > 1) attrs.push(`rowspan="${rowSpan}"`)

      const tcPr = childEl(tc, 'tcPr')
      const styles = ['padding:0.6cqw', 'vertical-align:middle', 'word-break:break-word']
      if (tcPr && !childEl(tcPr, 'noFill')) {
        const fill = solidColorUnder(tcPr, ctx.palette)
        if (fill) styles.push(`background:#${fill}`)
        const lineColor = solidColorUnder(childEl(tcPr, 'lnL') ?? childEl(tcPr, 'lnT'), ctx.palette)
        if (lineColor) styles.push(`border:1px solid #${lineColor}`)
      }

      const textHtml = renderTextBody(childEl(tc, 'txBody'), ctx, null)
      parts.push(`<td${attrs.length ? ' ' + attrs.join(' ') : ''} style="${styles.join(';')}">${textHtml}</td>`)
    }
    parts.push('</tr>')
  }
  parts.push('</table>')
  return `<div class="wb-pptx-el" style="position:absolute;${positionCss(xfrm, ctx)}">${parts.join('')}</div>`
}

async function renderGraphicFrame (frame: XmlElement, ctx: SlideRenderContext, transform: Transform): Promise<string | null> {
  const xfrmRaw = parseXfrm(frame)
  if (!xfrmRaw || xfrmRaw.cx <= 0 || xfrmRaw.cy <= 0) return null
  const xfrm = transform(xfrmRaw)

  const graphicData = descendantEl(frame, 'graphicData')
  const uri = attrStr(graphicData, 'uri') ?? ''
  if (graphicData && descendantEl(graphicData, 'tbl')) {
    return renderTable(frame, xfrm, ctx)
  }

  let label = t('mainDialog.pptxUnsupportedMedia', { kind: uri.split('/').pop() || 'graphic' })
  if (uri.includes('chart')) {
    label = t('mainDialog.pptxChartPlaceholder')
    const chartPath = ctx.rels.get(attrStr(descendantEl(graphicData, 'chart'), 'r:id') ?? '')
    const chartFile = chartPath ? ctx.zip.file(chartPath) : undefined
    if (chartFile) {
      try {
        const chartDoc = parseXml(await chartFile.async('string'))
        const title = elText(descendantEl(descendantEl(chartDoc.documentElement, 'tx'), 'rich'))
          .replace(/\s+/g, ' ')
          .trim()
        if (title) label = `${label}：${title}`
      } catch {
        // chart title is cosmetic; keep the generic label
      }
    }
  }
  return `<div class="wb-pptx-el wb-pptx-ph" style="${degradedBoxCss(xfrm, ctx)}">${escapeHtml(label)}</div>`
}

async function renderGroup (grpSp: XmlElement, ctx: SlideRenderContext, transform: Transform): Promise<string | null> {
  const grpSpPr = childEl(grpSp, 'grpSpPr')
  const outer = parseXfrm(grpSpPr)
  const xfrmEl = childEl(grpSpPr, 'xfrm')
  if (!outer || !xfrmEl) return null
  const chOffEl = childEl(xfrmEl, 'chOff')
  const chExtEl = childEl(xfrmEl, 'chExt')
  const chOff = { x: attrNum(chOffEl, 'x') ?? 0, y: attrNum(chOffEl, 'y') ?? 0 }
  const chExt = { cx: attrNum(chExtEl, 'cx') ?? outer.cx, cy: attrNum(chExtEl, 'cy') ?? outer.cy }
  const inner = composeGroupTransform(transform, outer, chOff, chExt)
  return (await renderShapeChildren(grpSp, ctx, inner)) || null
}

async function renderShapeChildren (container: XmlElement, ctx: SlideRenderContext, transform: Transform): Promise<string> {
  const parts: string[] = []
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType !== 1) continue
    const el = node as XmlElement
    const tag = localName(el)
    let html: string | null = null
    try {
      if (tag === 'sp') html = await renderSp(el, ctx, transform, false)
      else if (tag === 'cxnSp') html = await renderSp(el, ctx, transform, true)
      else if (tag === 'pic') html = await renderPic(el, ctx, transform)
      else if (tag === 'graphicFrame') html = await renderGraphicFrame(el, ctx, transform)
      else if (tag === 'grpSp') html = await renderGroup(el, ctx, transform)
    } catch {
      // one broken shape must not take down the whole slide
    }
    if (html) parts.push(html)
  }
  return parts.join('')
}

function slideBackground (slideDoc: XmlDocument | null, ctx: SlideRenderContext): string {
  for (const doc of [slideDoc, ctx.layout, ctx.master]) {
    const bg = descendantEl(doc?.documentElement ?? null, 'bg')
    if (!bg) continue
    const bgPr = childEl(bg, 'bgPr')
    if (!bgPr || childEl(bgPr, 'noFill')) continue
    const color = solidColorUnder(bgPr, ctx.palette)
    if (color) return `#${color}`
  }
  return '#ffffff'
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

const PPTX_PREVIEW_CSS = `
.wb-pptx{padding:4px 0}
.wb-pptx-slide{margin:0 auto 26px;max-width:960px}
.wb-pptx-canvas{position:relative;width:100%;overflow:hidden;border-radius:6px;box-shadow:0 10px 30px rgba(15,23,42,.16);container-type:inline-size}
.wb-pptx-el{position:absolute;box-sizing:border-box}
.wb-pptx-text{display:flex;flex-direction:column;box-sizing:border-box;width:100%;height:100%;word-break:break-word}
.wb-pptx-p{margin:0}
.wb-pptx-ph{display:flex;align-items:center;justify-content:center;color:#475569;background:#f1f5f9;border:1px dashed #cbd5e1;text-align:center}
.wb-pptx-tbl td{font-size:1.3cqw}
.wb-pptx-page{text-align:center;color:#64748b;font-size:12px;margin-top:8px}
.wb-pptx-notice{padding:8px 12px;margin:0 auto 16px;max-width:960px;color:#92400e;background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;font-size:12px}
`

/** Builds (or reuses from cache) a self-contained HTML preview of a pptx deck. */
export async function buildPptxHtmlPreview (filePath: string): Promise<string> {
  const outputPath = await resolveHtmlPreviewCachePath(filePath)
  if (await fileExists(outputPath)) return outputPath

  const buffer = await fs.readFile(filePath)
  const zip = await JSZip.loadAsync(buffer)

  const presentation = await zipXml(zip, 'ppt/presentation.xml')
  const presRels = await loadRels(zip, 'ppt/_rels/presentation.xml.rels')

  let slideW = DEFAULT_SLIDE_W
  let slideH = DEFAULT_SLIDE_H
  const sldSz = presentation ? descendantEl(presentation.documentElement, 'sldSz') : null
  const szCx = attrNum(sldSz, 'cx')
  const szCy = attrNum(sldSz, 'cy')
  if (szCx && szCy) {
    slideW = szCx
    slideH = szCy
  }

  // Slide order from sldIdLst → presentation rels; fall back to numeric file order.
  let slidePaths: string[] = []
  const sldIdLst = presentation ? descendantEl(presentation.documentElement, 'sldIdLst') : null
  if (sldIdLst) {
    for (const sldId of childEls(sldIdLst, 'sldId')) {
      const target = presRels.get(attrStr(sldId, 'r:id') ?? '')
      if (target) slidePaths.push(target)
    }
  }
  if (slidePaths.length === 0) {
    slidePaths = Object.keys(zip.files)
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const na = Number(/slide(\d+)\.xml$/.exec(a)?.[1] ?? 0)
        const nb = Number(/slide(\d+)\.xml$/.exec(b)?.[1] ?? 0)
        return na - nb
      })
  }
  const totalSlides = slidePaths.length
  slidePaths = slidePaths.slice(0, MAX_SLIDES)

  // Theme: prefer the theme attached to the first slide master.
  const masterPath = Object.keys(zip.files).find(name => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name))
  const masterRels = masterPath ? await loadRels(zip, zipRelsPath(masterPath)) : new Map<string, string>()
  const themePath = [...masterRels.values()].find(target => /\/theme\/theme\d+\.xml$/.test(target)) ?? 'ppt/theme/theme1.xml'
  const palette = parseThemePalette(await zipXml(zip, themePath))

  const master = masterPath ? await zipXml(zip, masterPath) : null
  const masterTextStyles = parseMasterTextStyles(master, palette)

  const imageData = new Map<string, string | null>()
  const imageBudget = { remaining: MAX_TOTAL_IMAGE_BYTES }

  const slideSections: string[] = []
  for (let i = 0; i < slidePaths.length; i++) {
    const slidePath = slidePaths[i]
    const slideDoc = await zipXml(zip, slidePath)
    if (!slideDoc) continue
    const rels = await loadRels(zip, zipRelsPath(slidePath))
    const layoutPath = [...rels.values()].find(target => /\/slideLayouts\/slideLayout\d+\.xml$/.test(target))
    const layout = layoutPath ? await zipXml(zip, layoutPath) : null

    const ctx: SlideRenderContext = {
      zip,
      palette,
      slideW,
      slideH,
      rels,
      layout,
      master,
      masterTextStyles,
      imageData,
      imageBudget
    }

    const spTree = descendantEl(slideDoc.documentElement, 'spTree')
    const background = slideBackground(slideDoc, ctx)
    const bodyHtml = spTree ? await renderShapeChildren(spTree, ctx, identityTransform) : ''
    slideSections.push([
      '<section class="wb-pptx-slide">',
      `<div class="wb-pptx-canvas" style="aspect-ratio:${slideW}/${slideH};background:${background}">`,
      bodyHtml,
      '</div>',
      `<div class="wb-pptx-page">${i + 1} / ${slidePaths.length}</div>`,
      '</section>'
    ].join(''))
  }

  const notices = totalSlides > MAX_SLIDES
    ? `<div class="wb-pptx-notice">${escapeHtml(t('mainDialog.pptxSlidesTruncated', { count: MAX_SLIDES }))}</div>`
    : ''
  const emptyBody = slideSections.length === 0
    ? `<div class="wb-pptx-notice">${escapeHtml(t('mainDialog.emptyDocumentPreviewText').replace(/<[^>]+>/g, ''))}</div>`
    : ''
  const body = `<div class="wb-pptx" data-preview-kind="slides">${notices}${emptyBody}${slideSections.join('')}` + '</div>'

  const html = wrapHtmlPreviewDocument(path.basename(filePath), body, PPTX_PREVIEW_CSS)
  await writeHtmlPreviewCache(outputPath, html)
  return outputPath
}
