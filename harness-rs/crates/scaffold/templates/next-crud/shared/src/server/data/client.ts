/**
 * Host data API client.
 *
 * Generated applications persist records through the WorldBase runtime instead
 * of opening their own database. `THE_WORLD_PROJECT_DATA_BASE_URL` points at
 * `/api/projects/<project_id>/data` on the loopback LAN server and is injected
 * by the project runtime.
 */

const DATA_BASE_URL =
  process.env.THE_WORLD_PROJECT_DATA_BASE_URL ??
  process.env.NEXT_PUBLIC_THE_WORLD_PROJECT_DATA_BASE_URL ??
  ''

export interface QueryRecordsInput {
  filters?: Record<string, unknown>
  limit?: number
  offset?: number
  orderBy?: string
  orderDirection?: 'asc' | 'desc'
  columns?: string[]
}

interface RecordsResponse<T> {
  rows?: T[]
  records?: T[]
}

function dataUrl (path: string): string {
  const base = DATA_BASE_URL.replace(/\/$/, '')
  if (!base) {
    throw new Error('THE_WORLD_PROJECT_DATA_BASE_URL is not configured')
  }
  return `${base}${path}`
}

async function postJson<T> (path: string, body: unknown): Promise<T> {
  const response = await fetch(dataUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store'
  })
  if (!response.ok) {
    throw new Error(`Host data API ${path} failed (${response.status}): ${await response.text()}`)
  }
  return await response.json() as T
}

export async function queryRecords<T> (
  table: string,
  input: QueryRecordsInput = {}
): Promise<T[]> {
  const payload: Record<string, unknown> = { table }
  if (input.filters !== undefined) payload.filters = input.filters
  if (input.limit !== undefined) payload.limit = input.limit
  if (input.offset !== undefined) payload.offset = input.offset
  if (input.orderBy !== undefined) payload.orderBy = input.orderBy
  if (input.orderDirection !== undefined) payload.orderDirection = input.orderDirection
  if (input.columns !== undefined) payload.columns = input.columns
  const result = await postJson<RecordsResponse<T>>('/records/query', payload)
  return result.rows ?? result.records ?? []
}

export async function saveRecords<T extends Record<string, unknown>> (
  table: string,
  records: T[],
  mode: 'insert' | 'upsert'
): Promise<void> {
  await postJson<{ success?: boolean }>('/records/save', { table, records, mode })
}

export function newId (): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
