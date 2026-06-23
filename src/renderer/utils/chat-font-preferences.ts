/**
 * Chat message font customization — preference persistence, CSS application,
 * and system-font enumeration.
 *
 * Mirrors the theme/locale preference pattern: the Electron store is
 * authoritative (shared across windows), with a localStorage mirror so a cold
 * start can paint in the right font synchronously before IPC resolves.
 */

import { CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, DEFAULT_CHAT_FONT_SIZE } from '../../shared/chat-font-preferences'

export { CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, DEFAULT_CHAT_FONT_SIZE }

const STORAGE_KEY = 'the-world:chat-font-preferences'

const DEFAULT_CHAT_FONT_PREFERENCES: ChatFontPreferences = {
  fontFamily: '',
  fontSize: DEFAULT_CHAT_FONT_SIZE
}

/**
 * Recommended snap points on the size slider (px). These mirror the previous
 * small/medium/large buckets so migrated installs land on a familiar value, and
 * render as labelled ticks on the slider. Values outside this set are allowed —
 * the slider moves continuously across [CHAT_FONT_SIZE_MIN, CHAT_FONT_SIZE_MAX].
 */
export const CHAT_FONT_SIZE_RECOMMENDED: readonly number[] = [14, 16, 18]

export interface ChatFontSizeTick {
  px: number
  labelKey: string
}

/** Labelled ticks rendered on the slider track. */
export const CHAT_FONT_SIZE_TICKS: readonly ChatFontSizeTick[] = [
  { px: 14, labelKey: 'settings.general.font.tickSmall' },
  { px: 16, labelKey: 'settings.general.font.tickMedium' },
  { px: 18, labelKey: 'settings.general.font.tickLarge' }
]

/** Percentage position of a px value along the slider track. */
export function chatFontSizeToPercent (px: number): number {
  if (px <= CHAT_FONT_SIZE_MIN) return 0
  if (px >= CHAT_FONT_SIZE_MAX) return 100
  return ((px - CHAT_FONT_SIZE_MIN) / (CHAT_FONT_SIZE_MAX - CHAT_FONT_SIZE_MIN)) * 100
}

/**
 * The app's default system font stack — used when no family is chosen, and as a
 * fallback after any chosen family so the text still renders if that font isn't
 * installed.
 */
export const DEFAULT_CHAT_FONT_STACK = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif`

/**
 * Curated fallback shown when the Local Font Access API is unavailable or the
 * `local-fonts` permission was denied. Cross-platform, CJK-first ordering.
 */
const CJK_SYSTEM_FONT_CANDIDATES: ReadonlyArray<{ family: string; displayName: string; aliases: readonly string[] }> = [
  { family: 'PingFang SC', displayName: '苹方', aliases: ['苹方-简', '平方'] },
  { family: 'Hiragino Sans GB', displayName: '冬青黑体', aliases: ['冬青黑体简体中文'] },
  { family: 'Heiti SC', displayName: '黑体-简', aliases: ['黑体'] },
  { family: 'STHeiti', displayName: '华文黑体', aliases: ['黑体'] },
  { family: 'Songti SC', displayName: '宋体-简', aliases: ['宋体'] },
  { family: 'STSong', displayName: '华文宋体', aliases: ['宋体'] },
  { family: 'Kaiti SC', displayName: '楷体-简', aliases: ['楷体'] },
  { family: 'STKaiti', displayName: '华文楷体', aliases: ['楷体'] },
  { family: 'STFangsong', displayName: '华文仿宋', aliases: ['仿宋'] },
  { family: 'Microsoft YaHei', displayName: '微软雅黑', aliases: ['雅黑'] },
  { family: 'Microsoft JhengHei', displayName: '微软正黑体', aliases: [] },
  { family: 'SimHei', displayName: '黑体', aliases: [] },
  { family: 'SimSun', displayName: '宋体', aliases: [] },
  { family: 'NSimSun', displayName: '新宋体', aliases: [] },
  { family: 'KaiTi', displayName: '楷体', aliases: [] },
  { family: 'FangSong', displayName: '仿宋', aliases: [] },
  { family: 'DengXian', displayName: '等线', aliases: [] },
  { family: 'Source Han Sans SC', displayName: '思源黑体', aliases: ['思源黑体简体中文'] },
  { family: 'Source Han Serif SC', displayName: '思源宋体', aliases: ['思源宋体简体中文'] },
  { family: 'Noto Sans CJK SC', displayName: 'Noto Sans 简体中文', aliases: ['思源黑体'] },
  { family: 'Noto Serif CJK SC', displayName: 'Noto Serif 简体中文', aliases: ['思源宋体'] },
  { family: 'WenQuanYi Micro Hei', displayName: '文泉驿微米黑', aliases: [] },
  { family: 'WenQuanYi Zen Hei', displayName: '文泉驿正黑', aliases: [] },
  { family: 'LXGW WenKai', displayName: '霞鹜文楷', aliases: [] },
  { family: 'MiSans', displayName: '小米兰亭', aliases: [] }
]

const FALLBACK_LATIN_FONTS: readonly string[] = [
  'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Verdana',
  'Tahoma', 'Trebuchet MS', 'Courier New'
]

export const FALLBACK_SYSTEM_FONTS: readonly string[] = [
  ...CJK_SYSTEM_FONT_CANDIDATES.map(font => font.family),
  ...FALLBACK_LATIN_FONTS
]

const CJK_FONT_ORDER = new Map(CJK_SYSTEM_FONT_CANDIDATES.map((font, index) => [font.family, index]))
const FONT_DETECTION_SAMPLE = 'mmmmmmmmmm 你好世界 中文字体 AaBb 1234567890'
const FONT_DETECTION_BASES = ['monospace', 'serif', 'sans-serif'] as const
let fontDetectionContext: CanvasRenderingContext2D | null | undefined

function clampChatFontSize (value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CHAT_FONT_SIZE
  const rounded = Math.round(value)
  if (rounded < CHAT_FONT_SIZE_MIN) return CHAT_FONT_SIZE_MIN
  if (rounded > CHAT_FONT_SIZE_MAX) return CHAT_FONT_SIZE_MAX
  return rounded
}

function normalizeChatFontPreferences (value: unknown): ChatFontPreferences {
  const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  const rawFamily = typeof input.fontFamily === 'string' ? input.fontFamily.trim() : ''
  // Strip stray quotes/commas so the stored value is always a bare family name.
  const fontFamily = rawFamily.replace(/["',]/g, '').trim()
  const fontSize = clampChatFontSize(typeof input.fontSize === 'number'
    ? input.fontSize
    : Number.parseFloat(input.fontSize as string))
  return { fontFamily, fontSize }
}

function cleanFontFamilyName (value: unknown): string {
  return typeof value === 'string' ? value.replace(/["',]/g, '').trim() : ''
}

function createFontSet (fonts: Iterable<string>): Set<string> {
  const families = new Set<string>()
  for (const font of fonts) {
    const family = cleanFontFamilyName(font)
    if (family) families.add(family)
  }
  return families
}

function getFontDetectionContext (): CanvasRenderingContext2D | null {
  if (fontDetectionContext !== undefined) return fontDetectionContext
  try {
    fontDetectionContext = document.createElement('canvas').getContext('2d')
  } catch {
    fontDetectionContext = null
  }
  return fontDetectionContext
}

function quoteFontFamilyForCss (family: string): string {
  return `"${family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function measureFontWidth (family: string): number | null {
  const context = getFontDetectionContext()
  if (!context) return null

  const widths = FONT_DETECTION_BASES.map((base) => {
    context.font = `72px ${family ? `${quoteFontFamilyForCss(family)}, ` : ''}${base}`
    return context.measureText(FONT_DETECTION_SAMPLE).width
  })
  return widths.reduce((sum, width) => sum + width, 0)
}

function isFontProbablyAvailable (family: string): boolean {
  const familyWidth = measureFontWidth(family)
  if (familyWidth == null) return false

  const baselineWidths = FONT_DETECTION_BASES
    .map(base => measureFontWidth(base))
    .filter((width): width is number => typeof width === 'number')

  return baselineWidths.length > 0 && baselineWidths.some(width => Math.abs(width - familyWidth) > 0.5)
}

function mergeDetectedCjkFonts (families: Set<string>): Set<string> {
  const merged = new Set(families)
  for (const font of CJK_SYSTEM_FONT_CANDIDATES) {
    if (families.has(font.family) || isFontProbablyAvailable(font.family)) {
      merged.add(font.family)
    }
  }
  return merged
}

function sortFontFamilies (families: Iterable<string>): string[] {
  const list = Array.from(createFontSet(families))
  return list.sort((left, right) => {
    const leftOrder = CJK_FONT_ORDER.get(left)
    const rightOrder = CJK_FONT_ORDER.get(right)
    if (leftOrder !== undefined || rightOrder !== undefined) {
      return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER)
    }
    return left.localeCompare(right, 'zh-CN')
  })
}

function readLocalChatFontPreferences (): ChatFontPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_CHAT_FONT_PREFERENCES
    return normalizeChatFontPreferences(JSON.parse(raw))
  } catch {
    return DEFAULT_CHAT_FONT_PREFERENCES
  }
}

function writeLocalChatFontPreferences (preferences: ChatFontPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Ignore mirror failures; the in-memory preference is already applied.
  }
}

export async function loadChatFontPreferences (): Promise<ChatFontPreferences> {
  if (!window.electronAPI?.getChatFontPreferences) {
    return readLocalChatFontPreferences()
  }

  try {
    const preferences = normalizeChatFontPreferences(await window.electronAPI.getChatFontPreferences())
    writeLocalChatFontPreferences(preferences)
    return preferences
  } catch {
    return readLocalChatFontPreferences()
  }
}

export async function persistChatFontPreferences (preferences: ChatFontPreferences): Promise<void> {
  const normalized = normalizeChatFontPreferences(preferences)

  if (window.electronAPI?.saveChatFontPreferences) {
    await window.electronAPI.saveChatFontPreferences(normalized)
  }

  writeLocalChatFontPreferences(normalized)
}

/** Build the CSS font-family value for the chosen preference. */
export function resolveChatFontFamilyValue (fontFamily: string): string {
  const trimmed = fontFamily.trim()
  if (!trimmed) return DEFAULT_CHAT_FONT_STACK
  // Quote the chosen family so multi-word names (e.g. "PingFang SC") stay intact,
  // then fall back to the default stack if that family isn't installed.
  return `"${trimmed}", ${DEFAULT_CHAT_FONT_STACK}`
}

export function getChatFontSearchText (fontFamily: string): string {
  const known = CJK_SYSTEM_FONT_CANDIDATES.find(font => font.family === fontFamily)
  return [fontFamily, known?.displayName, ...(known?.aliases || [])]
    .filter((item): item is string => Boolean(item))
    .join(' ')
    .toLowerCase()
}

export function getChatFontDisplayName (fontFamily: string): string {
  return CJK_SYSTEM_FONT_CANDIDATES.find(font => font.family === fontFamily)?.displayName || fontFamily
}

export function getChatFontSecondaryName (fontFamily: string): string {
  const displayName = getChatFontDisplayName(fontFamily)
  return displayName === fontFamily ? '' : fontFamily
}

/** Apply the chat font preferences to the document root as CSS variables. */
export function applyChatFontPreferences (preferences: ChatFontPreferences): void {
  const root = document.documentElement
  root.style.setProperty('--chat-font-family', resolveChatFontFamilyValue(preferences.fontFamily))
  root.style.setProperty('--chat-font-size', `${clampChatFontSize(preferences.fontSize)}px`)
}

/**
 * Enumerate system font families via the Local Font Access API. Returns a
 * sorted, de-duplicated list. Falls back to a curated preset list when the API is
 * missing or the user denied the `local-fonts` permission.
 */
export async function loadSystemFonts (): Promise<string[]> {
  try {
    if (typeof window.queryLocalFonts === 'function') {
      const fonts = await window.queryLocalFonts()
      const families = createFontSet([])
      for (const font of fonts) {
        const family = cleanFontFamilyName(font?.family)
        if (family) families.add(family)
      }
      const list = sortFontFamilies(mergeDetectedCjkFonts(families))
      if (list.length > 0) return list
    }
  } catch {
    // Permission denied or API error — fall through to the curated list.
  }
  return sortFontFamilies(FALLBACK_SYSTEM_FONTS)
}
