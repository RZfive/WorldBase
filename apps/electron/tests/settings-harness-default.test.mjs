import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { SettingsStore } from '../src/main/settings/settings-store.ts'
import { loadAIExecutionPreferences } from '../src/renderer/utils/ai-execution-preferences.ts'

async function withSettings (settings, verify) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worldbase-harness-settings-'))
  try {
    if (settings !== undefined) {
      await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify(settings), 'utf8')
    }
    await verify(new SettingsStore(directory))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

test('main settings default missing and invalid Harness values to Rust', async () => {
  for (const settings of [
    undefined,
    { aiExecutionPreferences: {} },
    { aiExecutionPreferences: { harnessBackend: 'unknown' } }
  ]) {
    await withSettings(settings, async store => {
      assert.equal(store.getAIExecutionPreferences().harnessBackend, 'rust')
    })
  }
})

test('main settings preserve only an explicit TypeScript compatibility choice', async () => {
  await withSettings({ aiExecutionPreferences: { harnessBackend: 'ts' } }, async store => {
    assert.equal(store.getAIExecutionPreferences().harnessBackend, 'ts')
  })
  await withSettings({ aiExecutionPreferences: { harnessBackend: 'rust' } }, async store => {
    assert.equal(store.getAIExecutionPreferences().harnessBackend, 'rust')
  })
})

test('renderer fallback applies the same Rust-default migration rule', async () => {
  const values = new Map()
  const previousWindow = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    }
  }
  try {
    assert.equal((await loadAIExecutionPreferences()).harnessBackend, 'rust')

    values.set('the-world:ai-execution-preferences', JSON.stringify({ harnessBackend: 'invalid' }))
    assert.equal((await loadAIExecutionPreferences()).harnessBackend, 'rust')

    values.set('the-world:ai-execution-preferences', JSON.stringify({ harnessBackend: 'ts' }))
    assert.equal((await loadAIExecutionPreferences()).harnessBackend, 'ts')
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
