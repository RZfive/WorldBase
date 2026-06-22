import type { LanguagePreference, Locale } from '../../locales'
import { resolveLocale, tagToLocale } from '../../locales'

export const STORAGE_KEY = 'the-world:locale-preference'

const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = 'system'

function normalizeLanguagePreference (value: unknown): LanguagePreference {
  if (value === 'zh-CN' || value === 'en-US' || value === 'system') {
    return value
  }
  return DEFAULT_LANGUAGE_PREFERENCE
}

/** Read the cached preference from localStorage (synchronous, for first paint). */
export function readLocalLocale (): LanguagePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_LANGUAGE_PREFERENCE
    return normalizeLanguagePreference(JSON.parse(raw))
  } catch {
    return DEFAULT_LANGUAGE_PREFERENCE
  }
}

/** Renderer-side system tag source (navigator.language). */
export function resolveSystemTag (): string | undefined {
  return typeof navigator !== 'undefined' ? navigator.language : undefined
}

/** BCP-47 tag for the currently active locale, for `toLocaleString`/`localeCompare`. */
export function activeBcp47 (): string {
  return resolveLocale(readLocalLocale(), resolveSystemTag())
}

export { resolveLocale, tagToLocale }

export type { LanguagePreference, Locale }

/**
 * Load the persisted language preference. Prefers the Electron-backed store
 * (authoritative across windows) and mirrors it into localStorage so the next
 * cold start can paint in the right language synchronously.
 */
export async function loadLocalePreference (): Promise<LanguagePreference> {
  if (!window.electronAPI?.getLocalePreference) {
    return readLocalLocale()
  }

  try {
    const preference = normalizeLanguagePreference(await window.electronAPI.getLocalePreference())
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference))
    } catch {
      // Ignore mirror failures; the in-memory locale is already correct.
    }
    return preference
  } catch {
    return readLocalLocale()
  }
}

/**
 * Persist the language preference to the Electron store and mirror it to
 * localStorage. The caller is responsible for calling `setLocale()` to update
 * the reactive locale — this function only handles storage.
 */
export async function persistLocalePreference (preference: LanguagePreference): Promise<void> {
  const normalized = normalizeLanguagePreference(preference)
  if (window.electronAPI?.saveLocalePreference) {
    await window.electronAPI.saveLocalePreference(normalized)
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Ignore localStorage write failures.
  }
}
