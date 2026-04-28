import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AgentMemoryScope, MemoryEntry, MemorySearchScope, MemoryType } from '../../../shared/agent-workspace-types.js'

const nodeRequire = createRequire(import.meta.url)

interface SqliteStatement {
  run (...params: unknown[]): { changes: number, lastInsertRowid?: number | bigint }
  all (...params: unknown[]): Array<Record<string, unknown>>
  get (...params: unknown[]): Record<string, unknown> | undefined
}

interface SqliteDatabase {
  prepare (sql: string): SqliteStatement
  exec (sql: string): void
  close (): void
}

type BetterSqliteDatabaseCtor = new (path: string) => SqliteDatabase

function normalizeStringArray (value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const normalized = item.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

function parseStringArrayJson (value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    return normalizeStringArray(JSON.parse(value) as unknown[])
  } catch {
    return []
  }
}

function escapeFtsPhrase (value: string): string {
  return value.replace(/"/g, '""')
}

function escapeLikePattern (value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function buildFtsQuery (value: string): string | null {
  const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!normalized) return null

  const rawTerms = normalized.match(/[\p{L}\p{N}_-]+/gu) || []
  const seen = new Set<string>()
  const terms: string[] = []

  for (const rawTerm of rawTerms) {
    const term = rawTerm.replace(/^[-_]+|[-_]+$/g, '')
    if (!term) continue

    const key = term.toLocaleLowerCase()
    if (seen.has(key)) continue

    seen.add(key)
    terms.push(term)
    if (terms.length >= 8) break
  }

  if (terms.length === 0) return null

  return terms.map(term => `"${escapeFtsPhrase(term)}"`).join(' AND ')
}

function mapRowToMemoryEntry (row: Record<string, unknown>): MemoryEntry {
  return {
    id: String(row.id || ''),
    scopeType: String(row.scope_type || 'user') as AgentMemoryScope,
    scopeId: String(row.scope_id || ''),
    memoryType: String(row.memory_type || 'knowledge') as MemoryType,
    title: String(row.title || ''),
    summary: String(row.summary || ''),
    details: row.details == null ? undefined : String(row.details),
    tags: parseStringArrayJson(row.tags_json),
    sourceConversationId: row.source_conversation_id == null ? undefined : String(row.source_conversation_id),
    sourceSessionId: row.source_session_id == null ? undefined : String(row.source_session_id),
    sourceMessageIds: parseStringArrayJson(row.source_message_ids_json),
    importance: Number(row.importance || 0),
    confidence: Number(row.confidence || 0),
    pinned: Number(row.pinned || 0) === 1,
    lastUsedAt: row.last_used_at == null ? undefined : String(row.last_used_at),
    createdAt: String(row.created_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString())
  }
}

export interface MemorySearchOptions {
  query?: string
  scopes?: MemorySearchScope[]
  memoryTypes?: MemoryType[]
  limit?: number
}

export class MemoryStore {
  private db: SqliteDatabase
  private dbPath: string

  constructor (userDataPath: string) {
    const dir = path.join(userDataPath, 'agent-memory')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this.dbPath = path.join(dir, 'memory.sqlite')
    const Database = nodeRequire('better-sqlite3') as BetterSqliteDatabaseCtor
    this.db = new Database(this.dbPath)
    this.initialize()
  }

  private initialize (): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        source_conversation_id TEXT,
        source_session_id TEXT,
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.5,
        pinned INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(scope_type, scope_id);
      CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memory_last_used ON memory_entries(last_used_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
        id UNINDEXED,
        title,
        summary,
        details,
        tags
      );
    `)
  }

  private buildWhereClauses (
    alias: string,
    scopes: MemorySearchScope[],
    memoryTypes: MemoryType[],
    params: unknown[]
  ): string[] {
    const clauses: string[] = []
    const prefix = alias ? `${alias}.` : ''

    if (scopes.length > 0) {
      const scopeClauses = scopes.map((scope) => {
        params.push(scope.scopeType, scope.scopeId)
        return `(${prefix}scope_type = ? AND ${prefix}scope_id = ?)`
      })
      clauses.push(`(${scopeClauses.join(' OR ')})`)
    }

    if (memoryTypes.length > 0) {
      const placeholders = memoryTypes.map(() => '?').join(', ')
      params.push(...memoryTypes)
      clauses.push(`${prefix}memory_type IN (${placeholders})`)
    }

    return clauses
  }

  upsert (entry: MemoryEntry): MemoryEntry {
    const normalized: MemoryEntry = {
      ...entry,
      tags: normalizeStringArray(entry.tags),
      sourceMessageIds: normalizeStringArray(entry.sourceMessageIds ?? []),
      createdAt: entry.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    this.db.prepare(`
      INSERT INTO memory_entries (
        id, scope_type, scope_id, memory_type, title, summary, details,
        tags_json, source_conversation_id, source_session_id, source_message_ids_json,
        importance, confidence, pinned, last_used_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        scope_type = excluded.scope_type,
        scope_id = excluded.scope_id,
        memory_type = excluded.memory_type,
        title = excluded.title,
        summary = excluded.summary,
        details = excluded.details,
        tags_json = excluded.tags_json,
        source_conversation_id = excluded.source_conversation_id,
        source_session_id = excluded.source_session_id,
        source_message_ids_json = excluded.source_message_ids_json,
        importance = excluded.importance,
        confidence = excluded.confidence,
        pinned = excluded.pinned,
        last_used_at = excluded.last_used_at,
        updated_at = excluded.updated_at
    `).run(
      normalized.id,
      normalized.scopeType,
      normalized.scopeId,
      normalized.memoryType,
      normalized.title,
      normalized.summary,
      normalized.details ?? null,
      JSON.stringify(normalized.tags),
      normalized.sourceConversationId ?? null,
      normalized.sourceSessionId ?? null,
      JSON.stringify(normalized.sourceMessageIds ?? []),
      normalized.importance,
      normalized.confidence,
      normalized.pinned ? 1 : 0,
      normalized.lastUsedAt ?? null,
      normalized.createdAt,
      normalized.updatedAt
    )

    this.db.prepare('DELETE FROM memory_entries_fts WHERE id = ?').run(normalized.id)
    this.db.prepare('INSERT INTO memory_entries_fts (id, title, summary, details, tags) VALUES (?, ?, ?, ?, ?)').run(
      normalized.id,
      normalized.title,
      normalized.summary,
      normalized.details ?? '',
      normalized.tags.join(' ')
    )

    return normalized
  }

  upsertMany (entries: MemoryEntry[]): MemoryEntry[] {
    const result: MemoryEntry[] = []
    for (const entry of entries) {
      result.push(this.upsert(entry))
    }
    return result
  }

  get (id: string): MemoryEntry | null {
    const row = this.db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id)
    return row ? mapRowToMemoryEntry(row) : null
  }

  private searchByLike (scopes: MemorySearchScope[], memoryTypes: MemoryType[], rawQuery: string, limit: number): MemoryEntry[] {
    const params: unknown[] = []
    const whereClauses = this.buildWhereClauses('', scopes, memoryTypes, params)
    const escapedQuery = `%${escapeLikePattern(rawQuery)}%`

    whereClauses.push(`(
      title LIKE ? ESCAPE '\\'
      OR summary LIKE ? ESCAPE '\\'
      OR COALESCE(details, '') LIKE ? ESCAPE '\\'
      OR tags_json LIKE ? ESCAPE '\\'
    )`)

    const sql = `
      SELECT *
      FROM memory_entries
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY pinned DESC, importance DESC, confidence DESC, COALESCE(last_used_at, updated_at) DESC
      LIMIT ?
    `

    params.push(escapedQuery, escapedQuery, escapedQuery, escapedQuery, limit)
    return this.db.prepare(sql).all(...params).map(mapRowToMemoryEntry)
  }

  search (options: MemorySearchOptions): MemoryEntry[] {
    const params: unknown[] = []
    const scopes = options.scopes || []
    const memoryTypes = options.memoryTypes || []
    const limit = Math.max(1, Math.min(100, options.limit || 20))
    const rawQuery = typeof options.query === 'string' ? options.query.trim() : ''

    if (rawQuery) {
      const ftsQuery = buildFtsQuery(rawQuery)
      if (!ftsQuery) {
        return this.searchByLike(scopes, memoryTypes, rawQuery, limit)
      }

      const whereClauses = this.buildWhereClauses('e', scopes, memoryTypes, params)
      const sql = `
        SELECT e.*
        FROM memory_entries e
        JOIN memory_entries_fts ON e.id = memory_entries_fts.id
        WHERE ${whereClauses.length > 0 ? `${whereClauses.join(' AND ')} AND ` : ''}memory_entries_fts MATCH ?
        ORDER BY e.pinned DESC, e.importance DESC, e.confidence DESC, COALESCE(e.last_used_at, e.updated_at) DESC
        LIMIT ?
      `

      params.push(ftsQuery)
      params.push(limit)
      try {
        return this.db.prepare(sql).all(...params).map(mapRowToMemoryEntry)
      } catch {
        return this.searchByLike(scopes, memoryTypes, rawQuery, limit)
      }
    }

    const whereClauses = this.buildWhereClauses('', scopes, memoryTypes, params)
    const sql = `
      SELECT *
      FROM memory_entries
      ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
      ORDER BY pinned DESC, importance DESC, confidence DESC, COALESCE(last_used_at, updated_at) DESC
      LIMIT ?
    `
    params.push(limit)
    return this.db.prepare(sql).all(...params).map(mapRowToMemoryEntry)
  }

  listByScope (scopeType: AgentMemoryScope, scopeId: string, limit = 50): MemoryEntry[] {
    return this.search({ scopes: [{ scopeType, scopeId }], limit })
  }

  touch (id: string, usedAt = new Date().toISOString()): boolean {
    const result = this.db.prepare('UPDATE memory_entries SET last_used_at = ?, updated_at = ? WHERE id = ?').run(usedAt, usedAt, id)
    return result.changes > 0
  }

  pin (id: string, pinned: boolean): boolean {
    const updatedAt = new Date().toISOString()
    const result = this.db.prepare('UPDATE memory_entries SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, updatedAt, id)
    return result.changes > 0
  }

  delete (id: string): boolean {
    this.db.prepare('DELETE FROM memory_entries_fts WHERE id = ?').run(id)
    const result = this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id)
    return result.changes > 0
  }

  close (): void {
    this.db.close()
  }

  getDatabasePath (): string {
    return this.dbPath
  }
}