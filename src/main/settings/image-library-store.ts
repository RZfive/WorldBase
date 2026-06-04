import fs from 'node:fs'
import path from 'node:path'
import type { ImageLibraryEntry, ImageLibraryFolder, ImageStudioMode } from '../../shared/image-studio-types.js'

export type { ImageLibraryEntry, ImageLibraryFolder, ImageStudioMode } from '../../shared/image-studio-types.js'

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
  /** Folder/group name for organizing images. */
  folder?: string
  /** Tags for searching/filtering images. */
  tags?: string[]
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
  /** Registry of folder names, including empty folders that hold no images yet. */
  private foldersFile: string

  constructor (userDataPath: string) {
    this.dir = path.join(userDataPath, 'image-library')
    this.foldersFile = path.join(this.dir, 'folders.json')
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true })
    }
  }

  private readFolderRegistry (): string[] {
    if (!fs.existsSync(this.foldersFile)) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(this.foldersFile, 'utf-8'))
      return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : []
    } catch {
      return []
    }
  }

  private writeFolderRegistry (names: string[]): void {
    const unique = Array.from(new Set(names.map(n => n.trim()).filter(Boolean)))
    try {
      fs.writeFileSync(this.foldersFile, JSON.stringify(unique, null, 2), 'utf-8')
    } catch {
      // ignore write failures — registry is best-effort
    }
  }

  /** Metadata json files only (excludes the folders.json registry). */
  private metaFiles (): string[] {
    if (!fs.existsSync(this.dir)) return []
    return fs.readdirSync(this.dir).filter(f => f.endsWith('.json') && f !== 'folders.json')
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
   * Absolute paths of the generated images in a folder, for packaging/export.
   * `folderName === ''` selects unfiled images. Returns existing files only.
   */
  folderImagePaths (folderName: string): string[] {
    const paths: string[] = []
    for (const file of this.metaFiles()) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as ImageLibraryRecord
        const matches = folderName === '' ? !record.folder : record.folder === folderName
        if (!matches) continue
        const fp = this.resolveFilePath(record.fileName)
        if (fs.existsSync(fp)) paths.push(fp)
      } catch {
        // skip
      }
    }
    return paths
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
    const files = this.metaFiles()
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

  /** Update folder assignment for given image IDs. */
  setFolder (ids: string[], folder: string | undefined): number {
    let updated = 0
    for (const id of ids) {
      const safe = this.sanitizeId(id)
      const metaPath = this.metaPath(safe)
      if (!fs.existsSync(metaPath)) continue
      try {
        const record = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ImageLibraryRecord
        record.folder = folder || undefined
        fs.writeFileSync(metaPath, JSON.stringify(record, null, 2), 'utf-8')
        updated += 1
      } catch {
        // skip
      }
    }
    return updated
  }

  /** Update tags for a single image. */
  setTags (id: string, tags: string[]): boolean {
    const safe = this.sanitizeId(id)
    const metaPath = this.metaPath(safe)
    if (!fs.existsSync(metaPath)) return false
    try {
      const record = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ImageLibraryRecord
      record.tags = tags.length ? tags : undefined
      fs.writeFileSync(metaPath, JSON.stringify(record, null, 2), 'utf-8')
      return true
    } catch {
      return false
    }
  }

  /** Create an empty folder (persisted in the registry). Returns updated folder list. */
  createFolder (name: string): ImageLibraryFolder[] {
    const trimmed = name.trim()
    if (trimmed) {
      this.writeFolderRegistry([...this.readFolderRegistry(), trimmed])
    }
    return this.listFolders()
  }

  /**
   * Get all folder names with image counts. Merges the persisted registry
   * (so empty folders still appear, with count 0) with folders derived from images.
   */
  listFolders (): ImageLibraryFolder[] {
    const folderMap = new Map<string, number>()
    for (const name of this.readFolderRegistry()) {
      folderMap.set(name, 0)
    }

    for (const file of this.metaFiles()) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as ImageLibraryRecord
        if (record.folder) {
          folderMap.set(record.folder, (folderMap.get(record.folder) ?? 0) + 1)
        }
      } catch {
        // skip
      }
    }

    return Array.from(folderMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Get all unique tags across all images. */
  listAllTags (): string[] {
    const tagSet = new Set<string>()

    for (const file of this.metaFiles()) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as ImageLibraryRecord
        if (record.tags) {
          record.tags.forEach(t => tagSet.add(t))
        }
      } catch {
        // skip
      }
    }

    return Array.from(tagSet).sort()
  }

  /** Rename a folder across all images and in the registry. */
  renameFolder (oldName: string, newName: string): number {
    let updated = 0

    for (const file of this.metaFiles()) {
      try {
        const fp = path.join(this.dir, file)
        const record = JSON.parse(fs.readFileSync(fp, 'utf-8')) as ImageLibraryRecord
        if (record.folder === oldName) {
          record.folder = newName
          fs.writeFileSync(fp, JSON.stringify(record, null, 2), 'utf-8')
          updated += 1
        }
      } catch {
        // skip
      }
    }

    const registry = this.readFolderRegistry()
    if (registry.includes(oldName)) {
      this.writeFolderRegistry(registry.map(n => (n === oldName ? newName : n)))
    }

    return updated
  }

  /** Delete a folder (unassign from all images and drop it from the registry). */
  deleteFolder (folderName: string): number {
    let updated = 0

    for (const file of this.metaFiles()) {
      try {
        const fp = path.join(this.dir, file)
        const record = JSON.parse(fs.readFileSync(fp, 'utf-8')) as ImageLibraryRecord
        if (record.folder === folderName) {
          record.folder = undefined
          fs.writeFileSync(fp, JSON.stringify(record, null, 2), 'utf-8')
          updated += 1
        }
      } catch {
        // skip
      }
    }

    this.writeFolderRegistry(this.readFolderRegistry().filter(n => n !== folderName))

    return updated
  }
}
