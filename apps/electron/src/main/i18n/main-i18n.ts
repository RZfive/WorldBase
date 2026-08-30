/**
 * Electron main-process i18n. The renderer uses vue-i18n, but the main process
 * surfaces user-visible strings too (IPC errors, OS notifications, permission
 * dialog reasons, file-dialog titles). This lightweight `t()` reads the same
 * catalog under `src/locales` so there is a single source of truth.
 *
 * Only UI display strings belong here — AI prompts, tool descriptions sent to
 * the model, and document labels fed to the AI are intentionally NOT localized.
 */
import { app } from 'electron'
import { messages, DEFAULT_LOCALE, resolveLocale, type Locale, type LanguagePreference } from '../../locales/index.js'

let currentLocale: Locale = DEFAULT_LOCALE

/** Resolve the system locale from Electron on demand. */
function systemTag (): string | undefined {
  try {
    return app.getLocale()
  } catch {
    return undefined
  }
}

/** Set the active locale from a stored preference (which may be `'system'`). */
export function setMainLocale (preference: LanguagePreference): Locale {
  currentLocale = resolveLocale(preference, systemTag())
  return currentLocale
}

/** Set the active locale directly. */
export function setMainLocaleResolved (locale: Locale): void {
  currentLocale = locale
}

export function getMainLocale (): Locale {
  return currentLocale
}

/** Look up a dotted key path on a nested messages object. */
function lookup (obj: unknown, path: string): unknown {
  const segments = path.split('.')
  let current: unknown = obj
  for (const segment of segments) {
    if (current && typeof current === 'object' && segment in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return current
}

/** Replace `{name}` placeholders with provided params. */
function interpolate (template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key]
    return value !== undefined ? String(value) : match
  })
}

/**
 * Translate a dotted message key, falling back to zh-CN then to the key itself
 * so a missing entry is always visible (never an empty string).
 */
export function t (key: string, params?: Record<string, string | number>): string {
  const localized = lookup(messages[currentLocale], key)
  if (typeof localized === 'string') return interpolate(localized, params)

  const fallback = lookup(messages[DEFAULT_LOCALE], key)
  if (typeof fallback === 'string') return interpolate(fallback, params)

  return key
}
