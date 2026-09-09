import { createI18n } from 'vue-i18n'
import { messages, DEFAULT_LOCALE, resolveLocale, type Locale, type LanguagePreference } from '../locales'
import { STORAGE_KEY, readLocalLocale, resolveSystemTag } from './utils/locale'

export { STORAGE_KEY } from './utils/locale'
export type { Locale, LanguagePreference } from '../locales'

/**
 * Initial locale is resolved synchronously from the localStorage cache so the
 * very first paint matches the user's last choice (avoids a flash of the wrong
 * language before the async IPC load completes). The GeneralSettingsPanel /
 * App.vue later reconciles against the persisted Electron preference.
 */
function readInitialLocale (): Locale {
  const pref = readLocalLocale()
  return resolveLocale(pref, resolveSystemTag())
}

export const i18n = createI18n({
  legacy: false,
  locale: readInitialLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  messages,
  globalInjection: true
})

/**
 * Apply a language preference everywhere: resolve `'system'`, switch the
 * active locale, and mirror to localStorage so the next cold start paints in
 * the right language without waiting for IPC.
 */
export function setLocale (preference: LanguagePreference): Locale {
  const resolved = resolveLocale(preference, resolveSystemTag())
  i18n.global.locale.value = resolved
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference))
  } catch {
    // Ignore localStorage write failures (private mode, etc.).
  }
  return resolved
}
