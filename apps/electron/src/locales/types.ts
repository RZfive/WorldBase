/**
 * Shared locale types & helpers — imported by both the renderer (vue-i18n)
 * and the electron main process (lightweight `t()`), so the catalog is the
 * single source of truth for UI strings.
 */

export type Locale = 'zh-CN' | 'en-US'

/**
 * Persisted language preference. `'system'` resolves at runtime from the
 * platform locale (renderer: `navigator.language`, main: `app.getLocale()`).
 */
export type LanguagePreference = Locale | 'system'

export const DEFAULT_LOCALE: Locale = 'zh-CN'

/**
 * Map an arbitrary BCP-47 tag (e.g. `navigator.language`, `app.getLocale()`)
 * to one of our supported locales, falling back to the default.
 */
export function tagToLocale (tag: string | undefined): Locale {
  if (!tag) return DEFAULT_LOCALE
  const lower = tag.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en-US'
  return DEFAULT_LOCALE
}

/**
 * Resolve a stored `LanguagePreference` (which may be `'system'`) to a concrete
 * locale. The caller supplies the system tag since the source differs between
 * renderer (`navigator.language`) and main (`app.getLocale()`).
 */
export function resolveLocale (
  preference: LanguagePreference,
  systemTag: string | undefined
): Locale {
  if (preference === 'system') return tagToLocale(systemTag)
  return preference
}
