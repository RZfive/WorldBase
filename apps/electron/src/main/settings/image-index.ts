import type { ImageLibraryQuery } from '../../shared/image-studio-types.js'
import { openSqliteDatabase, type SqliteDatabase } from '../sqlite-database.js'

/** One row of the image index. File names are relative to the image-library dir. */
export interface ImageIndexRow {
  id: string
  created_at: string
  mode: string
  provider_id: string | null
  model: string | null
  prompt: string | null
  negative_prompt: string | null
  aspect_ratio: string | null
  size: string | null
  quality: string | null
  output_format: string | null
  file_name: string
  thumb_name: string | null
  /** JSON array of source image file names (edit mode), or null. */
  source_file_names: string | null
  folder: string | null
  /** JSON array of tags, or null. */
  tags: string | null
  width: number | null
  height: number | null
}

const SELECT_COLUMNS =
  'id, created_at, mode, provider_id, model, prompt, negative_prompt, aspect_ratio, size, quality, output_format, file_name, thumb_name, source_file_names, folder, tags, width, height'

/**
 * SQLite-backed metadata index for the image library. The image bytes stay on
 * disk; this table only holds queryable metadata + file names so listing,
 * folder counts, tag facets and search are indexed operations instead of an
 * O(N) scan of one-json-per-image. The index is derived data — it can be rebuilt
 * from the durable per-image .json files at any time (see ImageLibraryStore).
 */
export class ImageIndex {
  private db: SqliteDatabase

  constructor (dbPath: string) {
    this.db = openSqliteDatabase(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'generate',
        provider_id TEXT,
        model TEXT,
        prompt TEXT,
        negative_prompt TEXT,
        aspect_ratio TEXT,
        size TEXT,
        quality TEXT,
        output_format TEXT,
        file_name TEXT NOT NULL,
        thumb_name TEXT,
        source_file_names TEXT,
        folder TEXT,
        tags TEXT,
        width INTEGER,
        height INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder);
      CREATE TABLE IF NOT EXISTS folders ( name TEXT PRIMARY KEY );
    `)
    this.ensureColumn('quality', 'TEXT')
    this.ensureColumn('output_format', 'TEXT')
  }

  private ensureColumn (name: string, type: string): void {
    const rows = this.db.prepare('PRAGMA table_info(images)').all() as Array<{ name: string }>
    if (!rows.some(row => row.name === name)) {
      this.db.prepare(`ALTER TABLE images ADD COLUMN ${name} ${type}`).run()
    }
  }

  count (): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM images').get() as { c: number }).c
  }

  upsert (row: ImageIndexRow): void {
    this.db.prepare(`
      INSERT INTO images (${SELECT_COLUMNS})
      VALUES (@id, @created_at, @mode, @provider_id, @model, @prompt, @negative_prompt, @aspect_ratio, @size, @quality, @output_format, @file_name, @thumb_name, @source_file_names, @folder, @tags, @width, @height)
      ON CONFLICT(id) DO UPDATE SET
        created_at=excluded.created_at, mode=excluded.mode, provider_id=excluded.provider_id,
        model=excluded.model, prompt=excluded.prompt, negative_prompt=excluded.negative_prompt,
        aspect_ratio=excluded.aspect_ratio, size=excluded.size, quality=excluded.quality,
        output_format=excluded.output_format, file_name=excluded.file_name, thumb_name=excluded.thumb_name, source_file_names=excluded.source_file_names,
        folder=excluded.folder, tags=excluded.tags, width=excluded.width, height=excluded.height
    `).run(row)
  }

  /** Bulk upsert inside a single transaction (used by migration / rebuild). */
  upsertMany (rows: ImageIndexRow[]): void {
    const insert = this.db.prepare(`
      INSERT INTO images (${SELECT_COLUMNS})
      VALUES (@id, @created_at, @mode, @provider_id, @model, @prompt, @negative_prompt, @aspect_ratio, @size, @quality, @output_format, @file_name, @thumb_name, @source_file_names, @folder, @tags, @width, @height)
      ON CONFLICT(id) DO UPDATE SET
        created_at=excluded.created_at, mode=excluded.mode, provider_id=excluded.provider_id,
        model=excluded.model, prompt=excluded.prompt, negative_prompt=excluded.negative_prompt,
        aspect_ratio=excluded.aspect_ratio, size=excluded.size, quality=excluded.quality,
        output_format=excluded.output_format, file_name=excluded.file_name, thumb_name=excluded.thumb_name, source_file_names=excluded.source_file_names,
        folder=excluded.folder, tags=excluded.tags, width=excluded.width, height=excluded.height
    `)
    const tx = this.db.transaction((items: ImageIndexRow[]) => {
      for (const item of items) insert.run(item)
    })
    tx(rows)
  }

  /**
   * Replace this disposable cache from the durable image-library mirrors.
   * This is used when moving back from Rust mode, where Rust owns mutations
   * and Electron's index may contain stale rows for moved/deleted images.
   */
  replaceFromMirrors (rows: ImageIndexRow[], folderNames: string[]): void {
    const insertImage = this.db.prepare(`
      INSERT INTO images (${SELECT_COLUMNS})
      VALUES (@id, @created_at, @mode, @provider_id, @model, @prompt, @negative_prompt, @aspect_ratio, @size, @quality, @output_format, @file_name, @thumb_name, @source_file_names, @folder, @tags, @width, @height)
    `)
    const insertFolder = this.db.prepare('INSERT OR IGNORE INTO folders (name) VALUES (?)')
    const tx = this.db.transaction((items: ImageIndexRow[], folders: string[]) => {
      this.db.prepare('DELETE FROM images').run()
      this.db.prepare('DELETE FROM folders').run()
      for (const item of items) insertImage.run(item)
      for (const folder of folders) {
        const name = folder.trim()
        if (name) insertFolder.run(name)
      }
    })
    tx(rows, folderNames)
  }

  /** Update only the thumbnail file name (used by lazy thumbnail generation). */
  setThumbName (id: string, thumbName: string): void {
    this.db.prepare('UPDATE images SET thumb_name = ? WHERE id = ?').run(thumbName, id)
  }

  getById (id: string): ImageIndexRow | undefined {
    return this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM images WHERE id = ?`).get(id) as ImageIndexRow | undefined
  }

  deleteById (id: string): ImageIndexRow | undefined {
    const row = this.getById(id)
    if (row) this.db.prepare('DELETE FROM images WHERE id = ?').run(id)
    return row
  }

  setFolder (ids: string[], folder: string | undefined): number {
    if (ids.length === 0) return 0
    const stmt = this.db.prepare('UPDATE images SET folder = ? WHERE id = ?')
    const tx = this.db.transaction((list: string[]) => {
      let n = 0
      for (const id of list) n += stmt.run(folder ?? null, id).changes
      return n
    })
    return tx(ids) as number
  }

  setTags (id: string, tags: string[]): boolean {
    const value = tags.length ? JSON.stringify(tags) : null
    return this.db.prepare('UPDATE images SET tags = ? WHERE id = ?').run(value, id).changes > 0
  }

  /**
   * Build the WHERE clause + bound params for a query. When `search` is present
   * it spans all images (folder scope is ignored, matching the gallery's flat
   * search); otherwise the scope is: undefined → unfiled, '*' → all, name → that
   * folder.
   */
  private buildWhere (opts: ImageLibraryQuery): { clause: string; params: Record<string, unknown> } {
    const conditions: string[] = []
    const params: Record<string, unknown> = {}
    const search = opts.search?.trim()

    if (search) {
      params.like = `%${search}%`
      conditions.push('(prompt LIKE @like OR negative_prompt LIKE @like OR tags LIKE @like OR folder LIKE @like)')
    } else if (opts.folder === '*') {
      // all images, no folder filter
    } else if (opts.folder === undefined || opts.folder === null || opts.folder === '') {
      conditions.push('folder IS NULL')
    } else {
      conditions.push('folder = @folder')
      params.folder = opts.folder
    }

    // Tag facet (AND across the requested tags). Tags are stored as a JSON array
    // string, so a substring match on the quoted token is a good-enough filter.
    const tags = (opts.tags ?? []).filter(Boolean)
    tags.forEach((tag, i) => {
      const key = `tag${i}`
      params[key] = `%${JSON.stringify(tag)}%`
      conditions.push(`tags LIKE @${key}`)
    })

    return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params }
  }

  query (opts: ImageLibraryQuery): { rows: ImageIndexRow[]; total: number } {
    const { clause, params } = this.buildWhere(opts)
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM images ${clause}`).get(params) as { c: number }).c
    const limit = Math.max(1, Math.min(opts.limit ?? 60, 200))
    const offset = Math.max(0, opts.offset ?? 0)
    const rows = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM images ${clause} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit, offset }) as unknown as ImageIndexRow[]
    return { rows, total }
  }

  /** File names of generated images in a folder ('' = unfiled), newest first. */
  folderFileNames (folder: string): string[] {
    const rows = folder === ''
      ? this.db.prepare('SELECT file_name FROM images WHERE folder IS NULL ORDER BY created_at DESC').all()
      : this.db.prepare('SELECT file_name FROM images WHERE folder = ? ORDER BY created_at DESC').all(folder)
    return (rows as Array<{ file_name: string }>).map(r => r.file_name)
  }

  /** Folder name → image count (derived from images; excludes unfiled). */
  private folderCounts (): Map<string, number> {
    const rows = this.db.prepare(
      "SELECT folder, COUNT(*) AS c FROM images WHERE folder IS NOT NULL AND folder <> '' GROUP BY folder"
    ).all() as Array<{ folder: string; c: number }>
    return new Map(rows.map(r => [r.folder, r.c]))
  }

  /** Up to `n` newest image ids in a folder, for cover thumbnails. */
  folderCoverIds (folder: string, n: number): string[] {
    return (this.db.prepare(
      'SELECT id FROM images WHERE folder = ? ORDER BY created_at DESC LIMIT ?'
    ).all(folder, n) as Array<{ id: string }>).map(r => r.id)
  }

  /** All image ids assigned to a folder (for syncing durable json on folder ops). */
  idsByFolder (folder: string): string[] {
    return (this.db.prepare('SELECT id FROM images WHERE folder = ?').all(folder) as Array<{ id: string }>).map(r => r.id)
  }

  /* ---- Folder registry (persists empty folders too) ---- */

  listRegistryFolders (): string[] {
    return (this.db.prepare('SELECT name FROM folders').all() as Array<{ name: string }>).map(r => r.name)
  }

  addRegistryFolder (name: string): void {
    const trimmed = name.trim()
    if (trimmed) this.db.prepare('INSERT OR IGNORE INTO folders (name) VALUES (?)').run(trimmed)
  }

  renameRegistryFolder (oldName: string, newName: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM folders WHERE name = ?').run(oldName)
      this.db.prepare('INSERT OR IGNORE INTO folders (name) VALUES (?)').run(newName)
    })
    tx()
  }

  removeRegistryFolder (name: string): void {
    this.db.prepare('DELETE FROM folders WHERE name = ?').run(name)
  }

  /** All folder names (registry ∪ derived) with counts. Empty folders show 0. */
  listFolders (): Array<{ name: string; count: number }> {
    const counts = this.folderCounts()
    const names = new Set<string>([...this.listRegistryFolders(), ...counts.keys()])
    return Array.from(names)
      .map(name => ({ name, count: counts.get(name) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  renameFolderEverywhere (oldName: string, newName: string): number {
    const updated = this.db.prepare('UPDATE images SET folder = ? WHERE folder = ?').run(newName, oldName).changes
    this.renameRegistryFolder(oldName, newName)
    return updated
  }

  clearFolderEverywhere (folderName: string): number {
    const updated = this.db.prepare('UPDATE images SET folder = NULL WHERE folder = ?').run(folderName).changes
    this.removeRegistryFolder(folderName)
    return updated
  }

  listTags (): string[] {
    const rows = this.db.prepare("SELECT tags FROM images WHERE tags IS NOT NULL AND tags <> ''").all() as Array<{ tags: string }>
    const set = new Set<string>()
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.tags)
        if (Array.isArray(parsed)) parsed.forEach(t => typeof t === 'string' && set.add(t))
      } catch {
        // skip malformed
      }
    }
    return Array.from(set).sort()
  }
}
