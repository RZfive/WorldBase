/**
 * Thumbnail generation for the image library, backed by sharp.
 *
 * sharp is a native module loaded lazily via dynamic import so that a missing or
 * ABI-mismatched binary degrades gracefully (no thumbnail) instead of crashing
 * the whole main process. Callers treat a null result as "no thumbnail" and fall
 * back to serving the original image.
 */

// sharp is a CommonJS `export =` module: type it via its namespace members so we
// don't depend on default-import interop, and resolve the callable at runtime.
type SharpInstance = import('sharp').Sharp
type SharpOptions = import('sharp').SharpOptions
type SharpInput = Buffer | string
type SharpFactory = (input?: SharpInput, options?: SharpOptions) => SharpInstance

/** Long-edge size of generated thumbnails (square-bounded, never upscaled). */
export const THUMB_MAX_DIMENSION = 320

let sharpLoader: Promise<SharpFactory | null> | null = null

function loadSharp (): Promise<SharpFactory | null> {
  const loader = sharpLoader ?? (sharpLoader = import('sharp')
    .then((mod) => {
      const factory = (mod as unknown as { default?: SharpFactory }).default
        ?? (mod as unknown as SharpFactory)
      return typeof factory === 'function' ? factory : null
    })
    .catch((err) => {
      console.error('[image-thumbnailer] sharp unavailable — thumbnails disabled:', (err as Error).message)
      return null
    }))
  return loader
}

export interface ThumbnailResult {
  /** WebP-encoded thumbnail bytes. */
  buffer: Buffer
  /** Original image dimensions (pre-resize). */
  width?: number
  height?: number
}

/** Whether sharp is usable in this runtime. */
export async function isThumbnailerAvailable (): Promise<boolean> {
  return (await loadSharp()) !== null
}

async function generateThumbnailFromInput (input: SharpInput): Promise<ThumbnailResult | null> {
  const sharp = await loadSharp()
  if (!sharp) return null

  try {
    const image = sharp(input, { failOn: 'none', animated: false })
    const meta = await image.metadata()
    const buffer = await image
      .rotate() // honor EXIF orientation
      .resize({
        width: THUMB_MAX_DIMENSION,
        height: THUMB_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 68, effort: 2 })
      .toBuffer()
    return { buffer, width: meta.width, height: meta.height }
  } catch (err) {
    console.error('[image-thumbnailer] thumbnail generation failed:', (err as Error).message)
    return null
  }
}

/**
 * Generate a WebP thumbnail (long edge ≤ THUMB_MAX_DIMENSION) from original
 * image bytes. Returns null when sharp is unavailable or the input is undecodable.
 */
export async function generateThumbnail (input: Buffer): Promise<ThumbnailResult | null> {
  return generateThumbnailFromInput(input)
}

/**
 * Generate a thumbnail directly from a file path. This avoids reading large PNG
 * originals into the main-process JS heap before handing them to sharp.
 */
export async function generateThumbnailFromFile (filePath: string): Promise<ThumbnailResult | null> {
  return generateThumbnailFromInput(filePath)
}

async function readImageDimensionsFromInput (input: SharpInput): Promise<{ width?: number; height?: number }> {
  const sharp = await loadSharp()
  if (!sharp) return {}

  try {
    const meta = await sharp(input, { failOn: 'none' }).metadata()
    return { width: meta.width, height: meta.height }
  } catch {
    return {}
  }
}

/** Read original image dimensions without producing a thumbnail. */
export async function readImageDimensions (input: Buffer): Promise<{ width?: number; height?: number }> {
  return readImageDimensionsFromInput(input)
}

/** Read original image dimensions directly from a file path. */
export async function readImageDimensionsFromFile (filePath: string): Promise<{ width?: number; height?: number }> {
  return readImageDimensionsFromInput(filePath)
}
