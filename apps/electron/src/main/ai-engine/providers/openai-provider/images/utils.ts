import { t } from '../../../../i18n/main-i18n.js'
import { isDallEModel, isGptImageModel } from '../runtime/models.js'
import type {
  ImageGenerationResult,
  ImagesGenerationsBody,
  ImagesGenerationsResponse
} from '../types.js'

export function outputFormatToMime (format?: 'png' | 'jpeg' | 'webp'): string {
  switch (format) {
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'png':
    default: return 'image/png'
  }
}

export function normalizeImageQuality (
  model: string,
  quality?: 'auto' | 'low' | 'medium' | 'high'
): ImagesGenerationsBody['quality'] | undefined {
  if (!quality) return undefined
  if (isDallEModel(model)) {
    return quality === 'high' ? 'hd' : undefined
  }
  return quality
}

export function shouldUseImageResponseFormat (model: string): boolean {
  return !isGptImageModel(model)
}

export function shouldIncludeImageOutputFormat (model: string, outputFormat?: 'png' | 'jpeg' | 'webp'): outputFormat is 'png' | 'jpeg' | 'webp' {
  return Boolean(outputFormat) && !isDallEModel(model)
}

export function isUnsupportedImageParameterError (error: Error, params: string[]): boolean {
  const message = error.message.toLowerCase()
  return params.some(param => message.includes(param.toLowerCase())) &&
    (message.includes('unknown') ||
      message.includes('unsupported') ||
      message.includes('not supported') ||
      message.includes('unrecognized') ||
      message.includes('invalid') ||
      message.includes('extra'))
}

/** Extract image URLs (and an optional revised prompt) from an /images/* response. */
export function extractImagesResult (data: ImagesGenerationsResponse, outputFormat?: 'png' | 'jpeg' | 'webp'): ImageGenerationResult {
  const images: string[] = []
  let revisedPrompt: string | undefined
  const mime = outputFormatToMime(outputFormat)

  for (const item of data.data ?? []) {
    if (item.revised_prompt && !revisedPrompt) {
      revisedPrompt = item.revised_prompt
    }
    if (item.b64_json) {
      images.push(`data:${mime};base64,${item.b64_json}`)
    } else if (item.url) {
      images.push(item.url)
    }
  }

  return { images, revisedPrompt }
}

/** Decode a `data:<mime>;base64,<data>` URL into a Blob for multipart upload. */
export function dataUrlToBlob (dataUrl: string): { blob: Blob; ext: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) {
    throw new Error(t('mainDialog.providerUnsupportedImageDataBase64'))
  }
  const mimeType = match[1]
  const bytes = Buffer.from(match[2], 'base64')
  const ext = mimeType.includes('jpeg') || mimeType.includes('jpg')
    ? 'jpg'
    : mimeType.includes('webp')
      ? 'webp'
      : 'png'
  return { blob: new Blob([bytes], { type: mimeType }), ext }
}
