/**
 * BridgeAdapter — 外部数据库桥接适配器
 *
 * 通过外部壳提供的数据库接口访问数据，而不是自行安装和管理 SQLite。
 * 支持通过委托函数注入实际的数据库查询能力。
 *
 * 默认回退到文件系统级的 SQLite 只读查询（如果可用），
 * 但推荐通过 setDelegate() 注入外部数据库接口。
 */

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

export interface DatabaseDelegate {
  query: (dbPath: string, sql: string, params?: unknown[]) => Record<string, unknown>[]
  execute?: (dbPath: string, sql: string, params?: unknown[]) => { changes: number, lastInsertRowid?: number | bigint }
  listTables: (dbPath: string) => string[]
  getSchema: (dbPath: string) => TableSchema[]
  close?: (dbPath: string) => void
  closeAll?: () => void
}

/**
 * BridgeAdapter bridges database calls through a delegate interface.
 * This decouples the data access layer from a specific SQLite driver.
 */
export class BridgeAdapter {
  private _delegate: DatabaseDelegate | null = null

  /**
   * Set the external database delegate (injected from the shell / host).
   */
  setDelegate (delegate: DatabaseDelegate): void {
    this._delegate = delegate
  }

  get hasDelegate (): boolean {
    return this._delegate !== null
  }

  query (dbPath: string, sql: string, params?: unknown[]): Record<string, unknown>[] {
    if (!this._delegate) {
      throw new Error('No database delegate configured. Use setDelegate() to inject an external DB interface.')
    }
    return this._delegate.query(dbPath, sql, params)
  }

  execute (dbPath: string, sql: string, params?: unknown[]): { changes: number, lastInsertRowid?: number | bigint } {
    if (!this._delegate?.execute) {
      throw new Error('No writable database delegate configured.')
    }
    return this._delegate.execute(dbPath, sql, params)
  }

  listTables (dbPath: string): string[] {
    if (!this._delegate) {
      throw new Error('No database delegate configured.')
    }
    return this._delegate.listTables(dbPath)
  }

  getSchema (dbPath: string): TableSchema[] {
    if (!this._delegate) {
      throw new Error('No database delegate configured.')
    }
    return this._delegate.getSchema(dbPath)
  }

  close (dbPath: string): void {
    this._delegate?.close?.(dbPath)
  }

  closeAll (): void {
    this._delegate?.closeAll?.()
  }
}
