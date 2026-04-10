export interface ResolvedProjectIcon {
  kind: 'text' | 'image'
  value: string
}

export function isImageIconSource (value?: string): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return /^(https?:\/\/|data:image\/|file:|blob:)/i.test(trimmed)
}

export function resolveProjectIcon (type?: string, customIcon?: string): ResolvedProjectIcon {
  if (typeof customIcon === 'string' && customIcon.trim()) {
    const trimmed = customIcon.trim()
    if (isImageIconSource(trimmed)) {
      return { kind: 'image', value: trimmed }
    }
    return { kind: 'text', value: trimmed }
  }

  return { kind: 'text', value: getProjectIcon(type) }
}

export function getProjectIcon (type?: string, customIcon?: string): string {
  if (typeof customIcon === 'string' && customIcon.trim()) return customIcon.trim()
  if (type === 'browser') return '🌐'
  if (type === 'frontend') return '🎨'
  if (type === 'backend') return '⚙️'
  if (type === 'fullstack') return '🚀'
  return '📦'
}
