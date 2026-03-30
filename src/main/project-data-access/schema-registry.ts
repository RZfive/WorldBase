import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'

interface SchemaColumn {
  name: string
  type: string
  primaryKey?: boolean
  description?: string
}

interface SchemaTable {
  name: string
  description?: string
  columns?: SchemaColumn[]
}

interface DataSchema {
  database: string
  dbPath: string
  tables?: SchemaTable[]
  [key: string]: unknown
}

/**
 * SchemaRegistry — 数据模式注册
 * 从 .world-meta.json 中读取和管理数据模式信息
 */
export class SchemaRegistry {
  private schemas = new Map<string, DataSchema>()

  /**
   * Load schema from project metadata.
   */
  async loadFromMeta (projectId: string, projectsDir: string): Promise<DataSchema | null> {
    const metaPath = path.join(projectsDir, projectId, '.world-meta.json')

    if (!existsSync(metaPath)) {
      return null
    }

    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>
    const schema = (meta.dataSchema as DataSchema) || null

    if (schema) {
      this.schemas.set(projectId, schema)
    }

    return schema
  }

  /**
   * Get the registered schema for a project.
   */
  getSchema (projectId: string): DataSchema | null {
    return this.schemas.get(projectId) || null
  }

  /**
   * Update the schema for a project (in memory).
   */
  setSchema (projectId: string, schema: DataSchema): void {
    this.schemas.set(projectId, schema)
  }

  /**
   * Get a human-readable description of the schema (for AI context).
   */
  describeSchema (projectId: string): string {
    const schema = this.schemas.get(projectId)
    if (!schema) {
      return 'No schema information available.'
    }

    let description = `Database: ${schema.database}\n`
    description += `DB Path: ${schema.dbPath}\n\n`

    if (schema.tables) {
      for (const table of schema.tables) {
        description += `Table: ${table.name}`
        if (table.description) {
          description += ` (${table.description})`
        }
        description += '\n'

        if (table.columns) {
          for (const col of table.columns) {
            description += `  - ${col.name}: ${col.type}`
            if (col.primaryKey) description += ' [PK]'
            if (col.description) description += ` (${col.description})`
            description += '\n'
          }
        }
        description += '\n'
      }
    }

    return description
  }
}
