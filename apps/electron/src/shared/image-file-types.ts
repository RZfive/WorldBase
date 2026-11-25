/** Browser-renderable image formats shared by workspace and document previews. */
export const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
}

export function getImageMimeType (filePath: string): string | undefined {
  const name = filePath.trim().replace(/\\/g, '/').split('/').pop() || ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return undefined
  return IMAGE_MIME_BY_EXTENSION[name.slice(dot).toLowerCase()]
}

export function isImageFilePath (filePath: string): boolean {
  return Boolean(getImageMimeType(filePath))
}
