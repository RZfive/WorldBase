import { existsSync } from 'node:fs'
import { openSqliteDatabase, type SqliteDatabase } from '../../sqlite-database.js'

interface TableColumn {
  name: string
  type: string
  notNull: boolean
  primaryKey: boolean
  defaultValue: unknown
}

interface TableSchema {
  name: string
  columns: TableColumn[]
}

/**
 * SqliteAdapter — SQLite 数据库适配器
 * 使用 Node/Electron 内置的 node:sqlite 进行同步查询。
 *
 * Keeping this adapter synchronous matches the existing data-access contract,
 * while avoiding a native npm module tied to Electron's Node ABI.
 */
export class SqliteAdapter {
  private _connections = new Map<string, SqliteDatabase>()

  /**
   * Get or create a database connection.
   */
  _getDb (dbPath: string): SqliteDatabase {
    if (this._connections.has(dbPath)) {
      return this._connections.get(dbPath)!
    }

    const db = openSqliteDatabase(dbPath)
    this._connections.set(dbPath, db)
    return db
  }

  /**
   * Execute a read-only query and return all rows.
   */
  query (dbPath: string, sql: string, params: unknown[] = []): Record<string, unknown>[] {
    if (!existsSync(dbPath)) {
      throw new Error(`Database file not found: ${dbPath}`)
    }
    const db = this._getDb(dbPath)
    const stmt = db.prepare(sql)
    return stmt.all(...params) as Record<string, unknown>[]
  }

  /**
   * Execute a write query and return mutation metadata.
   */
  execute (dbPath: string, sql: string, params: unknown[] = []): { changes: number, lastInsertRowid?: number | bigint } {
    const db = this._getDb(dbPath)
    const stmt = db.prepare(sql)
    return stmt.run(...params)
  }

  /**
   * List all tables in the database.
   */
  listTables (dbPath: string): string[] {
    const rows = this.query(
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    return rows.map(r => r.name as string)
  }

  /**
   * Get schema information for all tables.
   */
  getSchema (dbPath: string): TableSchema[] {
    const tables = this.listTables(dbPath)
    const schema: TableSchema[] = []

    for (const tableName of tables) {
      const columns = this.query(dbPath, `PRAGMA table_info("${tableName}")`)
      schema.push({
        name: tableName,
        columns: columns.map(col => ({
          name: col.name as string,
          type: col.type as string,
          notNull: col.notnull === 1,
          primaryKey: col.pk === 1,
          defaultValue: col.dflt_value
        }))
      })
    }

    return schema
  }

  /**
   * Close a specific database connection.
   */
  close (dbPath: string): void {
    const db = this._connections.get(dbPath)
    if (db) {
      db.close()
      this._connections.delete(dbPath)
    }
  }

  /**
   * Close all database connections.
   */
  closeAll (): void {
    for (const [, db] of this._connections) {
      db.close()
    }
    this._connections.clear()
  }
}
