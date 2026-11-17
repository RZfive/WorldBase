/**
 * Host data API client for generated Node applications.
 *
 * `THE_WORLD_PROJECT_DATA_BASE_URL` is injected by the WorldBase project
 * runtime and points at `/api/projects/<project_id>/data` on loopback.
 */

const DATA_BASE_URL =
  process.env.THE_WORLD_PROJECT_DATA_BASE_URL ??
  process.env.NEXT_PUBLIC_THE_WORLD_PROJECT_DATA_BASE_URL ??
  ''

function dataUrl (path) {
  const base = DATA_BASE_URL.replace(/\/$/, '')
  if (!base) {
    throw new Error('THE_WORLD_PROJECT_DATA_BASE_URL is not configured')
  }
  return `${base}${path}`
}

async function postJson (path, body) {
  const response = await fetch(dataUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    throw new Error(`Host data API ${path} failed (${response.status}): ${await response.text()}`)
  }
  return await response.json()
}

export async function queryRecords (table, input = {}) {
  const payload = { table }
  if (input.filters !== undefined) payload.filters = input.filters
  if (input.limit !== undefined) payload.limit = input.limit
  if (input.offset !== undefined) payload.offset = input.offset
  if (input.orderBy !== undefined) payload.orderBy = input.orderBy
  if (input.orderDirection !== undefined) payload.orderDirection = input.orderDirection
  if (input.columns !== undefined) payload.columns = input.columns
  const result = await postJson('/records/query', payload)
  return result.rows ?? result.records ?? []
}

export async function saveRecords (table, records, mode) {
  await postJson('/records/save', { table, records, mode })
}

export function newId () {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
