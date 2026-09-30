import assert from 'node:assert/strict'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { resolveModelStrength } from '../src/shared/reasoning-effort.ts'

test('undeclared and unrestricted models keep the canonical set and pass the value through', () => {
  const view = resolveModelStrength(undefined, { current: 'max' })
  assert.deepEqual(view.levels, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  assert.equal(view.active, 'max')
})

test('levels are declared ∩ allowed, canonically ordered', () => {
  const view = resolveModelStrength({
    reasoningEfforts: ['max', 'thinking-pro', 'low', 'high'],
    allowedReasoningEfforts: ['high', 'low', 'max']
  }, { current: 'low' })
  // 'thinking-pro' is declared but not user-allowed, so it does not render.
  assert.deepEqual(view.levels, ['low', 'high', 'max'])
  assert.equal(view.active, 'low')
})

test('unknown gateway levels keep their order after the canonical ones', () => {
  const view = resolveModelStrength({
    reasoningEfforts: ['max', 'thinking-pro', 'low', 'high']
  }, { current: 'low' })
  assert.deepEqual(view.levels, ['low', 'high', 'max', 'thinking-pro'])
})

test('active follows remembered → user default → gateway default → clamp', () => {
  const capabilities = {
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    defaultReasoningEffort: 'high',
    reasoningEffort: 'medium'
  }
  // Remembered pick wins over both defaults.
  assert.equal(resolveModelStrength(capabilities, { remembered: 'low', current: 'max' }).active, 'low')
  // User-chosen default beats the gateway default.
  assert.equal(resolveModelStrength(capabilities, { current: 'max' }).active, 'medium')
  // Without a user default the gateway default applies.
  assert.equal(
    resolveModelStrength({ ...capabilities, reasoningEffort: undefined }, { current: 'max' }).active,
    'high'
  )
  // No defaults at all: unsupported current snaps to the nearest declared level.
  assert.equal(
    resolveModelStrength({ reasoningEfforts: ['low', 'high'] }, { current: 'max' }).active,
    'high'
  )
})

test('allowed-only narrowing applies when the gateway declares nothing', () => {
  const view = resolveModelStrength({ allowedReasoningEfforts: ['low', 'max'] }, { current: 'low' })
  assert.deepEqual(view.levels, ['low', 'max'])
  assert.equal(view.active, 'low')
})

test('an allowed set disjoint from the declaration falls back to the declaration', () => {
  const view = resolveModelStrength({
    reasoningEfforts: ['low', 'high'],
    allowedReasoningEfforts: ['ultra']
  }, { current: 'low' })
  assert.deepEqual(view.levels, ['low', 'high'])
})

test('unsupported current clamps to the nearest allowed level inside a narrowed set', () => {
  const view = resolveModelStrength({
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    allowedReasoningEfforts: ['low', 'max']
  }, { current: 'medium' })
  assert.deepEqual(view.levels, ['low', 'max'])
  // On the canonical scale medium sits next to low, far from max.
  assert.equal(view.active, 'low')
  // A true tie (medium between low and high) resolves to the stronger level.
  assert.equal(
    resolveModelStrength({
      reasoningEfforts: ['low', 'medium', 'high'],
      allowedReasoningEfforts: ['low', 'high']
    }, { current: 'medium' }).active,
    'high'
  )
})
