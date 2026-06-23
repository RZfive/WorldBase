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
export const FALLBACK_SYSTEM_FONTS: readonly string[] = [
  'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'SimHei', 'STSong',
  'Source Han Sans SC', 'Noto Sans CJK SC', 'Heiti SC', 'STHeiti',
  'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Verdana',
  'Tahoma', 'Trebuchet MS', 'Courier New'
]

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
      const families = new Set<string>()
      for (const font of fonts) {
        const family = font?.family?.trim()
        if (family) families.add(family)
      }
      const list = Array.from(families).sort((a, b) => a.localeCompare(b, 'zh-CN'))
      if (list.length > 0) return list
    }
  } catch {
    // Permission denied or API error — fall through to the curated list.
  }
  return [...FALLBACK_SYSTEM_FONTS]
}
