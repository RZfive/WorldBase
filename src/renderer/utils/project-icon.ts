export function getProjectIcon (type?: string, customIcon?: string): string {
  if (typeof customIcon === 'string' && customIcon.trim()) return customIcon.trim()
  if (type === 'frontend') return '🎨'
  if (type === 'backend') return '⚙️'
  if (type === 'fullstack') return '🚀'
  return '📦'
}
