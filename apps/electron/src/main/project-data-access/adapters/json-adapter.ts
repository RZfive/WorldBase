import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'

/**
 * JsonAdapter — JSON 文件数据适配器
 */
export class JsonAdapter {
  /**
   * Read and parse a JSON file.
   */
  async read (filePath: string): Promise<unknown> {
    if (!existsSync(filePath)) {
      throw new Error(`JSON file not found: ${filePath}`)
    }

    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content) as unknown
  }

  /**
   * Write data to a JSON file.
   */
  async write (filePath: string, data: unknown): Promise<void> {
    const content = JSON.stringify(data, null, 2)
    await fs.writeFile(filePath, content, 'utf-8')
  }

  /**
   * Read a JSON file and return filtered/queried results.
   * Supports simple path-based queries using dot notation.
   */
  async query (filePath: string, queryPath?: string): Promise<unknown> {
    const data = await this.read(filePath)

    if (!queryPath) {
      return data
    }

    // Simple dot-notation path traversal
    const parts = queryPath.split('.')
    let current: unknown = data

    for (const part of parts) {
      if (current === null || current === undefined) {
        return null
      }
      current = (current as Record<string, unknown>)[part]
    }

    return current
  }
}
