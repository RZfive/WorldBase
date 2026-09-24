import assert from 'node:assert/strict'
import test from 'node:test'
import './register-ts-hooks.mjs'
import {
  chunkMemoryEntriesForAiCompaction,
  extractJsonObjectCandidate,
  parseMemoryCompactionPlan
} from '../electron/main-process/ai/memory-compaction-plan.ts'
import { MEMORY_AI_COMPACTION_CHUNK_SIZE } from '../electron/main-process/constants.ts'

function makeEntry (id, overrides = {}) {
  return {
    id,
    scopeType: overrides.scopeType || 'user',
    scopeId: overrides.scopeId || 'local-user',
    memoryType: overrides.memoryType || 'knowledge',
    title: overrides.title || `title-${id}`,
    summary: overrides.summary || `summary-${id}`,
    details: '',
    tags: [],
    pinned: false,
    importance: 0.5,
    confidence: 0.5,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    useCount: 0
  }
}

test('extractJsonObjectCandidate finds JSON in plain text, fences, and surrounding prose', () => {
  assert.deepEqual(JSON.parse(extractJsonObjectCandidate('{"deleteIds":[]}')), { deleteIds: [] })
  assert.deepEqual(
    JSON.parse(extractJsonObjectCandidate('```json\n{"deleteIds":["a"]}\n```')),
    { deleteIds: ['a'] }
  )
  assert.deepEqual(
    JSON.parse(extractJsonObjectCandidate('好的，方案如下：{"deleteIds":["a"]} 以上。')),
    { deleteIds: ['a'] }
  )
  assert.equal(extractJsonObjectCandidate('没有任何花括号的普通回复'), null)
  assert.equal(extractJsonObjectCandidate(''), null)
})

test('parseMemoryCompactionPlan strips inline thinking before extracting the plan', () => {
  const entries = [makeEntry('a'), makeEntry('b')]
  const raw = '<think>我需要判断哪些记忆该删……让我想想。</think>{"deleteIds":["a"],"mergeGroups":[],"updates":[]}'
  const plan = parseMemoryCompactionPlan(raw, entries)
  assert.deepEqual(plan.deleteIds, ['a'])
})

test('parseMemoryCompactionPlan drops unknown ids and dedupes', () => {
  const entries = [makeEntry('a'), makeEntry('b')]
  const plan = parseMemoryCompactionPlan(
    JSON.stringify({ deleteIds: ['a', 'ghost', 'a'], mergeGroups: [{ ids: ['a', 'ghost'] }], updates: [{ id: 'ghost', title: 'x' }] }),
    entries
  )
  assert.deepEqual(plan.deleteIds, ['a'])
  assert.equal(plan.mergeGroups?.length, 0)
  assert.equal(plan.updates?.length, 0)
})

test('parseMemoryCompactionPlan reports a model-output preview instead of a raw JSON syntax error', () => {
  const entries = [makeEntry('a')]
  // Conversational reply with no JSON at all.
  assert.throws(
    () => parseMemoryCompactionPlan('你好，我是 WorldBase AI 助手，有什么可以帮忙？', entries),
    (error) => error.message.includes('你好，我是 WorldBase AI 助手')
  )
  // Truncated JSON: must not leak a SyntaxError message.
  assert.throws(
    () => parseMemoryCompactionPlan('{"deleteIds":["a"', entries),
    (error) => error.message.includes('{"deleteIds":["a"')
  )
  // Empty output still produces a readable message.
  assert.throws(
    () => parseMemoryCompactionPlan('', entries),
    (error) => error.message.length > 0 && !error.message.includes('Unexpected token')
  )
})

test('chunkMemoryEntriesForAiCompaction caps batches at the configured chunk size', () => {
  const entries = Array.from({ length: MEMORY_AI_COMPACTION_CHUNK_SIZE + 25 }, (_, index) => makeEntry(`entry-${index}`))
  const chunks = chunkMemoryEntriesForAiCompaction(entries)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= MEMORY_AI_COMPACTION_CHUNK_SIZE)
  }
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.length, 0), entries.length)
})
