/**
 * Locale catalog barrel — the single source of UI strings shared by the
 * renderer (vue-i18n) and the electron main process (lightweight `t()`).
 */
import type { Locale } from './types'
import { DEFAULT_LOCALE } from './types'
import zhCN from './zh-CN/index'
import enUS from './en-US/index'

export type { Locale, LanguagePreference } from './types'
export { DEFAULT_LOCALE, resolveLocale, tagToLocale } from './types'
export type { MessageSchema } from './schema'

export const messages: Record<Locale, typeof zhCN> = {
  'zh-CN': zhCN,
  'en-US': enUS
}

export const SUPPORTED_LOCALES: Locale[] = ['zh-CN', 'en-US']
