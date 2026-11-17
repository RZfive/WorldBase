#!/usr/bin/env node
/* Seed deterministic sample records through the WorldBase host data API. */
import { readFileSync } from 'node:fs'

const baseUrl =
  process.env.SEED_DATA_API_URL ||
  process.env.THE_WORLD_PROJECT_DATA_BASE_URL ||
  ''

if (!baseUrl) {
  console.error('[seed] THE_WORLD_PROJECT_DATA_BASE_URL is not set')
  process.exit(1)
}

const seedFile = new URL('./seed-data.json', import.meta.url)
const seed = JSON.parse(readFileSync(seedFile, 'utf8'))
const endpoint = `${baseUrl.replace(/\/$/, '')}/records/save`

async function saveTable (table, records) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ table, records, mode: 'upsert' })
  })
  if (!response.ok) {
    throw new Error(`seed ${table} failed (${response.status}): ${await response.text()}`)
  }
  return records.length
}

let total = 0
for (const table of seed.tables) {
  const count = await saveTable(table.table, table.records)
  total += count
  console.log(`[seed] ${table.table}: ${count} record(s)`)
}
console.log(`[seed] done (${total} record(s))`)
