import assert from 'node:assert/strict'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { transitionHarnessOwnership } from '../electron/main-process/ai/harness-ownership.ts'

function dependencies (events, overrides = {}) {
  return {
    async stopTypeScriptHealthChecks () { events.push('ts-health:stop') },
    startTypeScriptHealthChecks () { events.push('ts-health:start') },
    async startRustHarness () { events.push('rust:start'); return true },
    async stopTypeScriptProjects () { events.push('ts-projects:stop') },
    async handoffRustToTypeScript () { events.push('rust:handoff') },
    rebuildTypeScriptImageLibrary () { events.push('images:rebuild') },
    notifyImageLibraryChanged () { events.push('images:notify') },
    onRustHandoffError () { events.push('rust:handoff-error') },
    ...overrides
  }
}

test('TS to Rust stops recovery before Rust starts and then retires TS project children', async () => {
  const events = []
  await transitionHarnessOwnership('ts', 'rust', false, dependencies(events))
  assert.deepEqual(events, [
    'ts-health:stop',
    'rust:start',
    'ts-projects:stop'
  ])
})

test('a failed Rust startup restores TypeScript project recovery and rejects the switch', async () => {
  const events = []
  await assert.rejects(
    transitionHarnessOwnership('ts', 'rust', false, dependencies(events, {
      async startRustHarness () {
        events.push('rust:start')
        throw new Error('missing Rust binary')
      }
    })),
    /missing Rust binary/
  )
  assert.deepEqual(events, [
    'ts-health:stop',
    'rust:start',
    'ts-health:start'
  ])
})

test('a stopped Rust retry does not revive TypeScript recovery when startup fails', async () => {
  const events = []
  await assert.rejects(
    transitionHarnessOwnership('rust', 'rust', false, dependencies(events, {
      async startRustHarness () {
        events.push('rust:start')
        throw new Error('Rust startup failed')
      }
    })),
    /Rust startup failed/
  )
  assert.deepEqual(events, [
    'ts-health:stop',
    'rust:start'
  ])
})

test('Rust to TS stops Rust ownership before enabling TypeScript recovery and rebuilds the gallery mirror', async () => {
  const events = []
  await transitionHarnessOwnership('rust', 'ts', true, dependencies(events))
  assert.deepEqual(events, [
    'rust:handoff',
    'ts-health:start',
    'images:rebuild',
    'images:notify'
  ])
})

test('a Rust retry first pauses the temporary TypeScript fallback', async () => {
  const events = []
  await transitionHarnessOwnership('rust', 'rust', false, dependencies(events))
  assert.deepEqual(events, [
    'ts-health:stop',
    'rust:start',
    'ts-projects:stop'
  ])
})

test('a failed Rust handoff still restores the TS fallback and reports the error', async () => {
  const events = []
  await transitionHarnessOwnership('rust', 'ts', true, dependencies(events, {
    async handoffRustToTypeScript () {
      events.push('rust:handoff')
      throw new Error('child did not stop')
    }
  }))
  assert.deepEqual(events, [
    'rust:handoff',
    'rust:handoff-error',
    'ts-health:start',
    'images:rebuild',
    'images:notify'
  ])
})
