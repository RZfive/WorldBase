export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const MEDIA_QUERY = '(prefers-color-scheme: dark)'

function getSystemTheme (): ResolvedTheme {
  return window.matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light'
}

export function resolveThemePreference (preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? getSystemTheme() : preference
}

export function getAppliedThemePreference (): ThemePreference {
  const current = document.documentElement.dataset.themePreference
  if (current === 'light' || current === 'dark' || current === 'system') {
    return current
  }
  return 'system'
}

export function applyThemePreference (preference: ThemePreference): ResolvedTheme {
  const resolved = resolveThemePreference(preference)
  document.documentElement.dataset.themePreference = preference
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
  return resolved
}

export function watchSystemThemeChange (callback: () => void): () => void {
  const mediaQuery = window.matchMedia(MEDIA_QUERY)
  const handler = () => callback()

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }

  mediaQuery.addListener(handler)
  return () => mediaQuery.removeListener(handler)
}