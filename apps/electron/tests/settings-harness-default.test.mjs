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

test('provider protocol values normalize with legacy migration', async () => {
  await withSettings({
    aiProviders: {
      providers: [
        { id: 'legacy-openai', name: 'Old', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', apiProtocol: 'openai', models: ['m'], activeModel: 'm' },
        { id: 'legacy-auto-anthropic', name: 'Sniffed', baseUrl: 'https://api.anthropic.com', apiKey: 'k', models: ['claude'], activeModel: 'claude' },
        { id: 'legacy-auto-other', name: 'Plain', baseUrl: 'https://gateway.example/v1', apiKey: 'k', models: ['m'], activeModel: 'm' },
        { id: 'new-responses', name: 'New', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', apiProtocol: 'openai-responses', models: ['gpt-5.1'], activeModel: 'gpt-5.1' },
        { id: 'explicit-anthropic', name: 'Native', baseUrl: 'https://gw.example/v3', apiKey: 'k', apiProtocol: 'anthropic', models: ['claude'], activeModel: 'claude' }
      ],
      activeProviderId: 'legacy-openai',
      enabledProviderIds: ['legacy-openai']
    }
  }, async store => {
    const providers = store.getProviders().providers
    const byId = Object.fromEntries(providers.map(provider => [provider.id, provider]))

    // Legacy 'openai' migrates to the explicit chat/completions value.
    assert.equal(byId['legacy-openai'].apiProtocol, 'openai-chat')
    assert.equal(byId['legacy-openai'].detectedApiProtocol, undefined)

    // Auto + anthropic.com keeps working: the sniffed result is pinned once as
    // the detection outcome instead of being re-guessed at runtime.
    assert.equal(byId['legacy-auto-anthropic'].apiProtocol, '')
    assert.equal(byId['legacy-auto-anthropic'].detectedApiProtocol, 'anthropic')

    // Plain auto entries stay unpinned.
    assert.equal(byId['legacy-auto-other'].apiProtocol, '')
    assert.equal(byId['legacy-auto-other'].detectedApiProtocol, undefined)

    // New protocol values round-trip untouched.
    assert.equal(byId['new-responses'].apiProtocol, 'openai-responses')
    assert.equal(byId['explicit-anthropic'].apiProtocol, 'anthropic')
  })
})
