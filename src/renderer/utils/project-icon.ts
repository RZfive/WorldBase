export function getProjectIcon (type?: string): string {
  if (type === 'frontend') return '🎨'
  if (type === 'backend') return '⚙️'
  if (type === 'fullstack') return '🚀'
  return '📦'
}
