import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import type {
  ImageLibraryData,
  ImageLibraryEntry,
  ImageLibraryFolderCard,
  ImageLibraryItem,
  ImageLibraryPage,
  ImageLibraryQuery,
  ImageStudioMode
} from '../../shared/image-studio-types.js'
import { t } from '../i18n/main-i18n.js'
import { ImageIndex, type ImageIndexRow } from './image-index.js'
import { generateThumbnailFromFile, readImageDimensionsFromFile } from './image-thumbnailer.js'

export type {
  ImageLibraryEntry,
  ImageLibraryItem,
  ImageLibraryPage,
  ImageLibraryQuery,
  ImageLibraryData,
  ImageLibraryFolderCard,
  ImageLibraryFolder,
  ImageStudioMode
} from '../../shared/image-studio-types.js'

/** URL scheme used by the custom protocol that streams library images. */
export const STUDIO_IMAGE_SCHEME = 'studio-img'
export type ImageVariant = 'thumb' | 'full'

/** Persisted metadata for a single generated/edited image (durable .json mirror). */
export interface ImageLibraryRecord {
  id: string
  createdAt: string
  mode: ImageStudioMode
  providerId: string
  model: string
  prompt: string
  negativePrompt?: string
  aspectRatio?: string
  size: string
  quality?: ImageLibraryEntry['quality']
  outputFormat?: ImageLibraryEntry['outputFormat']
  fileName: string
  sourceImageFileNames?: string[]
  /** Cached thumbnail file name (<id>.thumb.webp). */
  thumbName?: string
  folder?: string
  tags?: string[]
  width?: number
  height?: number
}

/**
 * Metadata emitted by the Rust harness after it has generated an image in
 * the shared user-data image-library directory. The image bytes are already
 * durable; Electron only needs to add its gallery metadata/index entry.
 */
export interface ExternalImageLibraryRecord {
  id: string
  createdAt: string
  mode: ImageStudioMode
  providerId: string
  model: string
  prompt: string
  negativePrompt?: string
  aspectRatio?: string
  size?: string
  quality?: ImageLibraryEntry['quality']
  outputFormat?: ImageLibraryEntry['outputFormat']
  fileName: string
  /** Source files persisted by Rust for edit-mode results. */
  sourceImageFileNames?: string[]
  folder?: string
  tags?: string[]
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml'
}

function guessExtensionFromMime (mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
  if (normalized.includes('webp')) return 'webp'
  if (normalized.includes('gif')) return 'gif'
  if (normalized.includes('svg')) return 'svg'
  return 'png'
}

function parseImageDataUrl (dataUrl: string): { mimeType: string; base64: string } | null {
  if (!dataUrl.startsWith('data:')) return null
  const marker = ';base64,'
  const markerIndex = dataUrl.indexOf(marker)
  if (markerIndex <= 'data:'.length) return null
  return {
    mimeType: dataUrl.slice('data:'.length, markerIndex),
    base64: dataUrl.slice(markerIndex + marker.length)
  }
}

/** Build a studio-img:// URL addressing an image by id + variant. */
export function buildStudioImageUrl (id: string, variant: ImageVariant): string {
  return `${STUDIO_IMAGE_SCHEME}://i/${id}/${variant}`
}

/**
 * ImageLibraryStore — 绘制工作台图片库持久化。
 *
 * 磁盘：每张图片 userData/image-library/<id>.<ext>（原图）、<id>.thumb.webp（缩略图）、
 * <id>.json（耐久元数据）。查询走 SQLite 索引（index.db），索引是从 .json 派生的缓存，
 * 缺失/不一致时从 .json 重建。图片字节经自定义协议按 URL 流式提供，渲染层不再持有 base64。
 */
export class ImageLibraryStore {
  private dir: string
  private index: ImageIndex

  constructor (userDataPath: string) {
    this.dir = path.join(userDataPath, 'image-library')
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true })
    }
    this.index = new ImageIndex(path.join(this.dir, 'index.db'))
    this.migrateFromDisk()
  }

  /* ---- Disk helpers ---- */

  private sanitizeId (id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, '')
  }

  private metaPath (id: string): string {
    return path.join(this.dir, `${this.sanitizeId(id)}.json`)
  }

  private metaFiles (): string[] {
    if (!fs.existsSync(this.dir)) return []
    return fs.readdirSync(this.dir).filter(f => f.endsWith('.json') && f !== 'folders.json')
  }

  /** Absolute path to a stored file (for save-to-file / export / protocol). */
  resolveFilePath (fileName: string): string {
    return path.join(this.dir, path.basename(fileName))
  }

  private async writeImage (id: string, dataUrl: string, suffix = ''): Promise<string> {
    const parsed = parseImageDataUrl(dataUrl)
    if (!parsed) {
      throw new Error(t('mainDialog.unsupportedImageData'))
    }
    const ext = guessExtensionFromMime(parsed.mimeType)
    const fileName = `${this.sanitizeId(id)}${suffix}.${ext}`
    await fsp.writeFile(path.join(this.dir, fileName), parsed.base64, 'base64')
    return fileName
  }

  private readImageDataUrl (fileName: string): string | null {
    const fp = this.resolveFilePath(fileName)
    if (!fs.existsSync(fp)) return null
    try {
      const ext = path.extname(fp).slice(1).toLowerCase()
      const mime = MIME_BY_EXT[ext] || 'image/png'
      return `data:${mime};base64,${fs.readFileSync(fp).toString('base64')}`
    } catch {
      return null
    }
  }

  /** Generate + persist the thumbnail for an original file. Returns name + original dims, or null. */
  private async writeThumbnail (id: string, originalFileName: string): Promise<{ name: string; width?: number; height?: number } | null> {
    const originalPath = this.resolveFilePath(originalFileName)
    if (!fs.existsSync(originalPath)) return null
    try {
      const result = await generateThumbnailFromFile(originalPath)
      if (!result) return null
      const name = `${this.sanitizeId(id)}.thumb.webp`
      await fsp.writeFile(this.resolveFilePath(name), result.buffer)
      return { name, width: result.width, height: result.height }
    } catch {
      return null
    }
  }

  /* ---- Record <-> index row mapping ---- */

  private recordToRow (record: ImageLibraryRecord): ImageIndexRow {
    return {
      id: record.id,
      created_at: record.createdAt,
      mode: record.mode,
      provider_id: record.providerId ?? null,
      model: record.model ?? null,
      prompt: record.prompt ?? null,
      negative_prompt: record.negativePrompt ?? null,
      aspect_ratio: record.aspectRatio ?? null,
      size: record.size ?? null,
      quality: record.quality ?? null,
      output_format: record.outputFormat ?? null,
      file_name: record.fileName,
      thumb_name: record.thumbName ?? null,
      source_file_names: record.sourceImageFileNames?.length ? JSON.stringify(record.sourceImageFileNames) : null,
      folder: record.folder ?? null,
      tags: record.tags?.length ? JSON.stringify(record.tags) : null,
      width: record.width ?? null,
      height: record.height ?? null
    }
  }

  private rowToItem (row: ImageIndexRow): ImageLibraryItem {
    return {
      id: row.id,
      createdAt: row.created_at,
      mode: (row.mode as ImageStudioMode) || 'generate',
      providerId: row.provider_id ?? '',
      model: row.model ?? '',
      prompt: row.prompt ?? '',
      negativePrompt: row.negative_prompt ?? undefined,
      aspectRatio: row.aspect_ratio ?? undefined,
      size: row.size ?? '',
      quality: row.quality as ImageLibraryItem['quality'] ?? undefined,
      outputFormat: row.output_format as ImageLibraryItem['outputFormat'] ?? undefined,
      folder: row.folder ?? undefined,
      tags: parseJsonStringArray(row.tags),
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      thumbUrl: buildStudioImageUrl(row.id, 'thumb'),
      fullUrl: buildStudioImageUrl(row.id, 'full')
    }
  }

  private readRecord (id: string): ImageLibraryRecord | null {
    const fp = this.metaPath(id)
    if (!fs.existsSync(fp)) return null
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8')) as ImageLibraryRecord
    } catch {
      return null
    }
  }

  private writeRecord (record: ImageLibraryRecord): void {
    fs.writeFileSync(this.metaPath(record.id), JSON.stringify(record, null, 2), 'utf-8')
    this.index.upsert(this.recordToRow(record))
    this.writeFolderMirror()
  }

  /** Keep the Rust/TS handoff registry durable for empty folders too. */
  private writeFolderMirror (): void {
    const names = this.index.listFolders()
      .map(folder => folder.name)
    fs.writeFileSync(path.join(this.dir, 'folders.json'), JSON.stringify(names, null, 2), 'utf-8')
  }

  /* ---- Migration: rebuild disposable index from durable JSON mirrors ---- */

  private migrateFromDisk (): void {
    this.rebuildIndexFromMirrors()
  }

  /**
   * Recreate Electron's derived SQLite index from the image JSON mirrors.
   * Rust mode writes these mirrors directly, so count-based upserts are not
   * sufficient: equal row counts can still hide deletions, moves, or retags.
   */
  rebuildIndexFromMirrors (): void {
    const folderNames: string[] = []
    const foldersPath = path.join(this.dir, 'folders.json')
    let loadedFolderMirror = false
    if (fs.existsSync(foldersPath)) {
      try {
        const names = JSON.parse(fs.readFileSync(foldersPath, 'utf-8'))
        if (Array.isArray(names)) {
          folderNames.push(...names.filter((name): name is string => typeof name === 'string' && name.trim().length > 0))
          loadedFolderMirror = true
        }
      } catch {
        // Ignore a partial/corrupt mirror and retain folders derived from rows.
      }
    }
    // Older Electron installs did not write folders.json. Preserve their
    // registry exactly once; once a Rust mirror exists it is authoritative.
    if (!loadedFolderMirror) folderNames.push(...this.index.listRegistryFolders())

    const rows: ImageIndexRow[] = []
    for (const file of this.metaFiles()) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as ImageLibraryRecord
        if (record?.id && record.fileName) rows.push(this.recordToRow(record))
      } catch {
        // skip corrupted records
      }
    }
    this.index.replaceFromMirrors(rows, folderNames)
  }

  /* ---- Save ---- */

  async save (
    record: Omit<ImageLibraryRecord, 'fileName' | 'sourceImageFileNames' | 'thumbName' | 'width' | 'height'>,
    imageDataUrl: string,
    sourceDataUrls?: string[]
  ): Promise<ImageLibraryEntry> {
    const id = this.sanitizeId(record.id)
    const fileName = await this.writeImage(id, imageDataUrl)

    const sourceImageFileNames: string[] = []
    if (sourceDataUrls?.length) {
      for (const [index, dataUrl] of sourceDataUrls.entries()) {
        try {
          sourceImageFileNames.push(await this.writeImage(id, dataUrl, `-src${index}`))
        } catch {
          // skip unreadable source image
        }
      }
    }

    const thumb = await this.writeThumbnail(id, fileName)
    let width = thumb?.width
    let height = thumb?.height
    if (width === undefined || height === undefined) {
      const dims = await this.readDimsFromOriginal(fileName)
      width = width ?? dims?.width
      height = height ?? dims?.height
    }

    const fullRecord: ImageLibraryRecord = {
      ...record,
      id,
      fileName,
      sourceImageFileNames: sourceImageFileNames.length ? sourceImageFileNames : undefined,
      thumbName: thumb?.name,
      width,
      height
    }
    this.writeRecord(fullRecord)

    return {
      ...fullRecord,
      thumbUrl: buildStudioImageUrl(id, 'thumb'),
      fullUrl: buildStudioImageUrl(id, 'full')
    }
  }

  /**
   * Register an image produced by the Rust harness without copying it. Rust
   * and Electron deliberately share `userData/image-library`, so retaining
   * the original file keeps Rust's own index and Electron's gallery in sync.
   */
  async importExternalImage (record: ExternalImageLibraryRecord): Promise<ImageLibraryEntry | null> {
    const id = this.sanitizeId(record.id)
    const fileName = path.basename(record.fileName)
    if (!id || !fileName) return null

    const sourcePath = this.resolveFilePath(fileName)
    if (!fs.existsSync(sourcePath)) return null

    const existing = this.readRecord(id)
    if (existing?.fileName === fileName) {
      return {
        ...existing,
        thumbUrl: buildStudioImageUrl(id, 'thumb'),
        fullUrl: buildStudioImageUrl(id, 'full')
      }
    }

    const thumb = await this.writeThumbnail(id, fileName)
    const dimensions = thumb ?? await this.readDimsFromOriginal(fileName)
    const imported: ImageLibraryRecord = {
      id,
      createdAt: record.createdAt || new Date().toISOString(),
      mode: record.mode === 'edit' ? 'edit' : 'generate',
      providerId: record.providerId || '',
      model: record.model || '',
      prompt: record.prompt || '',
      negativePrompt: record.negativePrompt,
      aspectRatio: record.aspectRatio,
      size: record.size || '',
      quality: record.quality,
      outputFormat: record.outputFormat,
      fileName,
      sourceImageFileNames: record.sourceImageFileNames?.length ? record.sourceImageFileNames : undefined,
      thumbName: thumb?.name,
      folder: record.folder,
      tags: record.tags?.length ? record.tags : undefined,
      width: dimensions?.width,
      height: dimensions?.height
    }
    this.writeRecord(imported)
    return {
      ...imported,
      thumbUrl: buildStudioImageUrl(id, 'thumb'),
      fullUrl: buildStudioImageUrl(id, 'full')
    }
  }

  private safeReadFile (fileName: string): Buffer {
    try {
      return fs.readFileSync(this.resolveFilePath(fileName))
    } catch {
      return Buffer.alloc(0)
    }
  }

  private async readDimsFromOriginal (fileName: string): Promise<{ width?: number; height?: number } | undefined> {
    const fp = this.resolveFilePath(fileName)
    if (!fs.existsSync(fp)) return undefined
    return readImageDimensionsFromFile(fp)
  }

  /* ---- Query (paginated, metadata-only) ---- */

  query (opts: ImageLibraryQuery): ImageLibraryPage {
    const limit = Math.max(1, Math.min(opts.limit ?? 60, 200))
    const offset = Math.max(0, opts.offset ?? 0)
    const { rows, total } = this.index.query({ ...opts, limit, offset })
    const items = rows.map(row => this.rowToItem(row))
    const consumed = offset + items.length
    return { items, total, nextOffset: consumed < total ? consumed : null }
  }

  /** On-demand full bytes for edit-input / save-to-file / regenerate flows. */
  getImageData (id: string): ImageLibraryData | null {
    const record = this.readRecord(id)
    if (!record) return null
    const dataUrl = this.readImageDataUrl(record.fileName)
    if (!dataUrl) return null
    const sourceDataUrls = record.sourceImageFileNames
      ?.map(name => this.readImageDataUrl(name))
      .filter((value): value is string => Boolean(value))
    return { dataUrl, sourceDataUrls: sourceDataUrls?.length ? sourceDataUrls : undefined }
  }

  /* ---- Custom-protocol resolution (with lazy thumbnail generation) ---- */

  /**
   * Resolve a studio-img:// URL to an absolute file path to stream. Thumbnails are
   * generated eagerly at save time, so this is a pure metadata + disk lookup — it
   * never runs sharp on the protocol thread. A missing thumbnail simply falls back
   * to the original. Returns null if the id is unknown or the file is gone.
   */
  async resolveImageRequest (rawUrl: string): Promise<string | null> {
    let id = ''
    let variant: ImageVariant = 'full'
    try {
      const url = new URL(rawUrl)
      const parts = url.pathname.split('/').filter(Boolean) // ['<id>', '<variant>']
      id = this.sanitizeId(decodeURIComponent(parts[0] ?? ''))
      variant = parts[1] === 'thumb' ? 'thumb' : 'full'
    } catch {
      return null
    }
    if (!id) return null

    const row = this.index.getById(id)
    if (!row) return null

    if (variant === 'thumb' && row.thumb_name) {
      const thumbPath = this.resolveFilePath(row.thumb_name)
      if (fs.existsSync(thumbPath)) return thumbPath
    }
    // thumb missing (thumbnailer unavailable at save) or a full request → original.
    const fullPath = this.resolveFilePath(row.file_name)
    return fs.existsSync(fullPath) ? fullPath : null
  }

  /* ---- Mutations (json mirror + index in lock-step) ---- */

  delete (id: string): boolean {
    const safe = this.sanitizeId(id)
    const record = this.readRecord(safe)
    const row = this.index.getById(safe)
    if (!record && !row) return false

    const fileNames = new Set<string>()
    if (record) {
      fileNames.add(record.fileName)
      if (record.thumbName) fileNames.add(record.thumbName)
      record.sourceImageFileNames?.forEach(n => fileNames.add(n))
    }
    if (row) {
      fileNames.add(row.file_name)
      if (row.thumb_name) fileNames.add(row.thumb_name)
      parseJsonStringArray(row.source_file_names)?.forEach(n => fileNames.add(n))
    }
    for (const name of fileNames) {
      const fp = this.resolveFilePath(name)
      if (fs.existsSync(fp)) {
        try { fs.unlinkSync(fp) } catch { /* best effort */ }
      }
    }

    const metaPath = this.metaPath(safe)
    if (fs.existsSync(metaPath)) {
      try { fs.unlinkSync(metaPath) } catch { /* best effort */ }
    }
    this.index.deleteById(safe)
    this.writeFolderMirror()
    return true
  }

  deleteMany (ids: string[]): number {
    let removed = 0
    for (const id of ids) {
      if (this.delete(id)) removed += 1
    }
    return removed
  }

  setFolder (ids: string[], folder: string | undefined): number {
    let updated = 0
    for (const id of ids) {
      const record = this.readRecord(id)
      if (!record) continue
      record.folder = folder || undefined
      this.writeRecord(record)
      updated += 1
    }
    return updated
  }

  setTags (id: string, tags: string[]): boolean {
    const record = this.readRecord(id)
    if (!record) return false
    record.tags = tags.length ? tags : undefined
    this.writeRecord(record)
    return true
  }

  /* ---- Folders ---- */

  createFolder (name: string): ImageLibraryFolderCard[] {
    const trimmed = name.trim()
    if (trimmed) this.index.addRegistryFolder(trimmed)
    this.writeFolderMirror()
    return this.listFolders()
  }

  listFolders (): ImageLibraryFolderCard[] {
    return this.index.listFolders().map(({ name, count }) => ({
      name,
      count,
      coverThumbUrls: this.index.folderCoverIds(name, 4).map(coverId => buildStudioImageUrl(coverId, 'thumb'))
    }))
  }

  renameFolder (oldName: string, newName: string): number {
    const next = newName.trim()
    if (!next || next === oldName) return 0
    const ids = this.index.idsByFolder(oldName)
    for (const id of ids) {
      const record = this.readRecord(id)
      if (!record) continue
      record.folder = next
      try { fs.writeFileSync(this.metaPath(id), JSON.stringify(record, null, 2), 'utf-8') } catch { /* best effort */ }
    }
    const updated = this.index.renameFolderEverywhere(oldName, next)
    this.writeFolderMirror()
    return updated
  }

  deleteFolder (folderName: string): number {
    const ids = this.index.idsByFolder(folderName)
    for (const id of ids) {
      const record = this.readRecord(id)
      if (!record) continue
      record.folder = undefined
      try { fs.writeFileSync(this.metaPath(id), JSON.stringify(record, null, 2), 'utf-8') } catch { /* best effort */ }
    }
    const updated = this.index.clearFolderEverywhere(folderName)
    this.writeFolderMirror()
    return updated
  }

  listAllTags (): string[] {
    return this.index.listTags()
  }

  /** Absolute paths of generated images in a folder ('' = unfiled), for export. */
  folderImagePaths (folderName: string): string[] {
    return this.index.folderFileNames(folderName)
      .map(name => this.resolveFilePath(name))
      .filter(fp => fs.existsSync(fp))
  }
}

function parseJsonStringArray (value: string | null | undefined): string[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) {
      const list = parsed.filter((item): item is string => typeof item === 'string')
      return list.length ? list : undefined
    }
  } catch {
    // ignore
  }
  return undefined
}
