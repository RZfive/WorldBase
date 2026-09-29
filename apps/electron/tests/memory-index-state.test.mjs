import assert from 'node:assert/strict'
import test from 'node:test'
import { semanticMemoryPhase } from '../src/renderer/utils/memory-index-state.ts'

const saved = { enabled: true, providerId: 'p', modelId: 'embedding' }
const ready = {
  configured: true, providerId: 'p', modelId: 'embedding', state: 'ready', vectorAvailable: true,
  generation: { status: 'active' }, documents: { total: 140, indexed: 140, queued: 0, failed: 0 }
}

test('semantic status never equates a configured provider with a ready index', () => {
  assert.equal(semanticMemoryPhase(saved, saved, null), 'unknown')
  assert.equal(semanticMemoryPhase(saved, saved, { ...ready, state: 'waiting', generation: null, vectorAvailable: false, documents: { total: 140, indexed: 0 } }), 'waiting')
  assert.equal(semanticMemoryPhase(saved, saved, ready), 'ready')
  assert.equal(semanticMemoryPhase(saved, saved, { ...ready, documents: { total: 141, indexed: 140 } }), 'indexing')
  assert.equal(semanticMemoryPhase(saved, saved, { ...ready, vectorAvailable: false }), 'indexing')
})

test('semantic status rejects stale models, unsaved changes and failed pipelines', () => {
  assert.equal(semanticMemoryPhase({ ...saved, modelId: 'new' }, saved, ready), 'unsaved')
  assert.equal(semanticMemoryPhase(saved, saved, { ...ready, modelId: 'old' }), 'waiting')
  assert.equal(semanticMemoryPhase(saved, saved, { ...ready, lastError: 'embedding API failed' }), 'failed')
  const disabled = { ...saved, enabled: false }
  assert.equal(semanticMemoryPhase(disabled, disabled, ready), 'disabled')
})
