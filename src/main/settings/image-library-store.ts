import fs from 'node:fs'
import path from 'node:path'
import type { ImageLibraryEntry, ImageStudioMode } from '../../shared/image-studio-types.js'

export type { ImageLibraryEntry, ImageStudioMode } from '../../shared/image-studio-types.js'

/** Persisted metadata for a single generated/edited image (without inline data URLs). */
export interface ImageLibraryRecord {
  id: string
  createdAt: string
  mode: ImageStudioMode
  providerId: string
  model: string
  prompt: string
  negativePrompt?: string
  /** Aspect ratio preset label, e.g. '1:1'. */
  aspectRatio?: string
  /** Final pixel size sent to the provider, e.g. '1024x1024'. */
  size: string
  /** Stored image file name (<id>.<ext>). */
  fileName: string
  /** Stored source image file names (edit mode inputs). */
  sourceImageFileNames?: string[]
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

function guessExtensionFromMime (mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
  if (normalized.includes('webp')) return 'webp'
  if (normalized.includes('gif')) return 'gif'
  if (normalized.includes('svg')) return 'svg'
  return 'png'
}

/**
 * ImageLibraryStore — 绘制工作台图片库持久化。
 * 每张图片落盘为 userData/image-library/<id>.<ext>，元数据为 <id>.json。
 */
export class ImageLibraryStore {
  private dir: string

  constructor (userDataPath: string) {
    this.dir = path.join(userDataPath, 'image-library')
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true })
    }
  }

  private sanitizeId (id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, '')
  }

  private metaPath (id: string): string {
    return path.join(this.dir, `${this.sanitizeId(id)}.json`)
  }

  /** Decode a data URL and write it to disk under <id>(-<suffix>).<ext>. Returns the file name. */
  private writeImage (id: string, dataUrl: string, suffix = ''): string {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) {
      throw new Error('不支持的图片数据格式')
    }
    const ext = guessExtensionFromMime(match[1])
    const fileName = `${this.sanitizeId(id)}${suffix}.${ext}`
    fs.writeFileSync(path.join(this.dir, fileName), Buffer.from(match[2], 'base64'))
    return fileName
  }

  /** Read a stored image file back as a data URL, or null if missing. */
  private readImageDataUrl (fileName: string): string | null {
    const fp = path.join(this.dir, path.basename(fileName))
    if (!fs.existsSync(fp)) return null
    try {
      const ext = path.extname(fp).slice(1).toLowerCase()
      const mime = MIME_BY_EXT[ext] || 'image/png'
      return `data:${mime};base64,${fs.readFileSync(fp).toString('base64')}`
    } catch {
      return null
    }
  }

  /** Absolute path to a stored image file (for save-to-file flows). */
  resolveFilePath (fileName: string): string {
    return path.join(this.dir, path.basename(fileName))
  }

  /**
   * Persist a newly generated/edited image plus its metadata.
   * `imageDataUrl` is the generated image; `sourceDataUrls` are edit-mode inputs.
   */
  save (
    record: Omit<ImageLibraryRecord, 'fileName' | 'sourceImageFileNames'>,
    imageDataUrl: string,
    sourceDataUrls?: string[]
  ): ImageLibraryEntry {
    const id = this.sanitizeId(record.id)
    const fileName = this.writeImage(id, imageDataUrl)

    const sourceImageFileNames: string[] = []
    if (sourceDataUrls?.length) {
      sourceDataUrls.forEach((dataUrl, index) => {
        try {
          sourceImageFileNames.push(this.writeImage(id, dataUrl, `-src${index}`))
        } catch {
          // skip unreadable source image
        }
      })
    }

    const fullRecord: ImageLibraryRecord = {
      ...record,
      id,
      fileName,
      sourceImageFileNames: sourceImageFileNames.length ? sourceImageFileNames : undefined
    }

    fs.writeFileSync(this.metaPath(id), JSON.stringify(fullRecord, null, 2), 'utf-8')

    return {
      ...fullRecord,
      dataUrl: imageDataUrl,
      sourceDataUrls: sourceDataUrls?.length ? sourceDataUrls : undefined
    }
  }

  /** List all library entries (newest first), each enriched with data URLs. */
  list (): ImageLibraryEntry[] {
    if (!fs.existsSync(this.dir)) return []
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))
    const entries: ImageLibraryEntry[] = []

    for (const file of files) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as ImageLibraryRecord
        const dataUrl = this.readImageDataUrl(record.fileName)
        if (!dataUrl) continue
        const sourceDataUrls = record.sourceImageFileNames
          ?.map(name => this.readImageDataUrl(name))
          .filter((value): value is string => Boolean(value))
        entries.push({
          ...record,
          dataUrl,
          sourceDataUrls: sourceDataUrls?.length ? sourceDataUrls : undefined
        })
      } catch {
        // skip corrupted records
      }
    }

    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Delete a single record (metadata + image + source images). */
  delete (id: string): boolean {
    const safe = this.sanitizeId(id)
    const metaPath = this.metaPath(safe)
    if (!fs.existsSync(metaPath)) return false

    try {
      const record = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ImageLibraryRecord
      const fileNames = [record.fileName, ...(record.sourceImageFileNames || [])]
      for (const name of fileNames) {
        const fp = this.resolveFilePath(name)
        if (fs.existsSync(fp)) fs.unlinkSync(fp)
      }
    } catch {
      // best-effort cleanup of image files
    }

    fs.unlinkSync(metaPath)
    return true
  }

  /** Delete many records; returns the number successfully removed. */
  deleteMany (ids: string[]): number {
    let removed = 0
    for (const id of ids) {
      if (this.delete(id)) removed += 1
    }
    return removed
  }
}
