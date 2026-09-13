import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { computed, ref } from 'vue'
import './register-ts-hooks.mjs'
import { ChatHistoryStore } from '../src/main/settings/chat-history.ts'
import { ChatHistoryStorage } from '../src/main/settings/chat-history-storage.ts'
import { validateConversationMetadata } from '../src/shared/conversation-metadata.ts'
import { createChatConversationStorage } from '../src/renderer/components/chat/panel/conversation-storage.ts'
import { createChatProviderState } from '../src/renderer/components/chat/panel/provider-state.ts'
import { createChatConversationNavigation } from '../src/renderer/components/chat/panel/conversation-navigation.ts'
import { rendererFixture } from './helpers/renderer-fixture.mjs'

const date = '2026-09-12T00:00:00.000Z'
const record = id => ({ id, title: id, messages: [{ id: `${id}-1`, role: 'user', content: 'hello' }], createdAt: date, updatedAt: date, providerId: 'a', selectedModel: 'a1' })
function temporary (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worldbase-history-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function chatFixture (t, api = {}) {
  const environment = rendererFixture(t)
  environment.window.electronAPI = api
  const options = {
    t: key => key,
    formatAttachmentConversationTitle: names => names.join(', '),
    conversations: ref(['alpha', 'beta', 'gamma'].map(id => { const { messages, ...summary } = record(id); return summary })),
    conversationsLoaded: ref(true),
    currentConversationId: ref('alpha'),
    messages: ref(record('alpha').messages),
    inputText: ref(''), targetProjectId: ref(null), currentAuthMode: ref('strict'),
    providers: ref([{ id: 'a', models: ['a1', 'a2'], activeModel: 'a1' }, { id: 'b', models: ['b1', 'b2'], activeModel: 'b1' }]),
    providersConfig: ref({ providers: [], activeProviderId: 'a', enabledProviderIds: ['a', 'b'] }),
    activeProviderId: ref('a'), selectedModel: ref('a1'), reasoningStrength: ref('high'),
    conversationTemperature: ref(null), selectedAgentId: ref(''), selectedGroupId: ref(''), selectedChannelBindingId: ref(''),
    selectedLongTermGoalId: ref(null), syncingProviderOptions: ref(false), planModeActive: ref(false),
    activeStreamSessionIds: new Map(), backgroundStreamMessages: new Map(), streamingConversationIds: new Set(),
    conversationTargets: new Map(), pendingImages: ref([]), pendingFiles: ref([]), uploadFeedback: ref(''),
    agentsById: computed(() => new Map()), shouldUseConversationProviderOverride: computed(() => true),
    groupsById: computed(() => new Map()), getDefaultAgentId: () => '', getPinnedContextTitle: () => null,
    buildCurrentDocumentWorkspaceState: () => undefined, buildCurrentFolderWorkspaceState: () => undefined,
    applyDocumentWorkspaceState: () => {}, applyFolderWorkspaceState: () => {},
    resetDocumentWorkspaceState: () => {}, resetFolderWorkspaceState: () => {},
    resetTransientStreamState: () => {}, clearConversationUnread: () => {}
  }
  options.providersById = computed(() => new Map(options.providers.value.map(provider => [provider.id, provider])))
  const storage = createChatConversationStorage(options)
  const providers = createChatProviderState({ ...options, saveConversationMetadata: storage.saveConversationMetadata })
  const navigation = createChatConversationNavigation({ ...options, ...storage, ...providers })
  return { ...options, storage, providersState: providers, navigation }
}

test('provider/model switches send metadata only: no history serialization or catalog/list refresh', async t => {
  const patches = []
  const failHeavyWork = () => { throw new Error('Heavy history work on selection') }
  const fixture = chatFixture(t, {
    getProviders: failHeavyWork, listConversations: failHeavyWork, saveConversation: failHeavyWork,
    updateConversationMetadata: async (id, patch) => {
      patches.push({ id, patch })
      return { success: true, summary: { ...record(id), messages: undefined, ...patch } }
    }
  })
  Object.defineProperty(fixture.messages, 'value', { get: failHeavyWork })
  await fixture.providersState.handleProviderSelectionChange('b')
  await fixture.providersState.handleModelSelectionChange('b2')
  assert.equal(fixture.activeProviderId.value, 'b')
  assert.equal(fixture.selectedModel.value, 'b2')
  assert.equal(patches.length, 2)
  assert.equal(patches[1].patch.selectedModel, 'b2')
  assert.equal(patches[1].id, 'alpha')
  assert.ok(JSON.stringify(patches[1]).length < 512)
  assert.ok(!Object.hasOwn(patches[1].patch, 'messages'))
})

test('history saves update one summary instead of reloading the complete sidebar', async t => {
  let lists = 0
  const fixture = chatFixture(t, {
    listConversations: () => { lists++; throw new Error('unexpected rescan') },
    saveConversation: async value => { const { messages, ...summary } = value; return { success: true, summary } }
  })
  await fixture.storage.saveConversation('alpha', record('alpha').messages)
  assert.equal(lists, 0)
  assert.equal(fixture.conversations.value.length, 3)
})

test('rapid conversation switches discard stale loads and only select cached providers', async t => {
  const pending = new Map()
  let catalogReads = 0
  const fixture = chatFixture(t, {
    getConversation: id => new Promise(resolve => pending.set(id, resolve)),
    getProviders: () => { catalogReads++; throw new Error('unneeded catalog read') }
  })
  const first = fixture.navigation.loadConversation('beta')
  const last = fixture.navigation.loadConversation('gamma')
  pending.get('gamma')({ ...record('gamma'), providerId: 'b', selectedModel: 'b2' })
  await last
  pending.get('beta')(record('beta'))
  await first
  assert.equal(fixture.currentConversationId.value, 'gamma')
  assert.equal(fixture.activeProviderId.value, 'b')
  assert.equal(fixture.selectedModel.value, 'b2')
  assert.equal(catalogReads, 0)
})

test('starting a new chat invalidates pending loads; reselecting the current chat does no IO', async t => {
  let resolve
  let reads = 0
  const fixture = chatFixture(t, { getConversation: () => { reads++; return new Promise(done => { resolve = done }) } })
  await fixture.navigation.loadConversation('alpha')
  assert.equal(reads, 0)
  const pending = fixture.navigation.loadConversation('beta')
  fixture.navigation.newConversation()
  resolve(record('beta'))
  await pending
  assert.equal(fixture.currentConversationId.value, null)
  assert.deepEqual(fixture.messages.value, [])
})

test('leaving a streaming chat keeps references without serializing, and background saves retain its provider', async t => {
  const saved = []
  const fixture = chatFixture(t, {
    getConversation: async id => ({ ...record(id), providerId: 'b', selectedModel: 'b2' }),
    saveConversation: async value => {
      saved.push(value)
      const { messages, ...summary } = value
      return { success: true, summary }
    }
  })
  const messages = fixture.messages.value
  fixture.streamingConversationIds.add('alpha')
  await fixture.navigation.loadConversation('beta')
  assert.equal(saved.length, 0)
  assert.equal(fixture.backgroundStreamMessages.get('alpha').messages, messages)
  await fixture.storage.saveConversation('alpha', messages)
  assert.equal(saved[0].providerId, 'a')
  assert.equal(saved[0].selectedModel, 'a1')
  assert.equal(fixture.activeProviderId.value, 'b')
})


test('catalog rows never include message payloads and restart reads catalog instead of histories', t => {
  const dir = temporary(t)
  const first = new ChatHistoryStorage(dir)
  first.save({ ...record('alpha'), messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'last' }] })
  first.save({ ...record('beta'), messages: [{ role: 'user', content: 'beta' }] })
  const catalogPath = path.join(dir, 'conversations', 'catalog.json')
  assert.ok(fs.existsSync(catalogPath))
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  assert.ok(catalog.every(item => !('messages' in item) && !('searchText' in item)))

  const restarted = new ChatHistoryStorage(dir)
  const originalRead = fs.readFileSync
  const reads = []
  t.mock.method(fs, 'readFileSync', (...args) => { reads.push(String(args[0])); return originalRead(...args) })
  const rows = restarted.list()
  assert.deepEqual(rows.map(row => row.id), ['beta', 'alpha'])
  assert.ok(reads.some(file => file.endsWith('catalog.json')))
  assert.ok(reads.every(file => !file.endsWith('alpha.json') && !file.endsWith('beta.json')))
  assert.equal(restarted.get('alpha').messages.length, 2)
})

test('metadata validation rejects message payloads, unexpected keys and invalid values', () => {
  for (const patch of [null, [], { messages: [] }, { __proto__: null, title: 'no' }, { temperature: Infinity }, { authMode: 'allow-all' }]) {
    assert.throws(() => validateConversationMetadata(patch))
  }
  assert.deepEqual(validateConversationMetadata({ providerId: null, temperature: 0, authMode: 'auto' }), { providerId: null, temperature: 0, authMode: 'auto' })
})

test('summary cache avoids rereading unrelated histories and stays correct after mutations', t => {
  const dir = temporary(t)
  const store = new ChatHistoryStorage(dir)
  store.save(record('alpha'))
  store.save(record('beta'))
  const originalRead = fs.readFileSync
  const reads = []
  t.mock.method(fs, 'readFileSync', (...args) => { reads.push(args[0]); return originalRead(...args) })
  assert.equal(store.list().length, 2)
  assert.equal(reads.length, 0)
  for (let i = 0; i < 20; i++) store.list()
  assert.equal(reads.length, 0)
  const summary = store.updateMetadata('alpha', { providerId: 'b', temperature: null })
  assert.equal(summary.providerId, 'b')
  assert.equal(reads.length, 0, 'metadata-only changes never read a large history')
  assert.equal(store.list().find(item => item.id === 'alpha').providerId, 'b')
  assert.equal(reads.length, 0)
  assert.ok(store.rename('alpha', 'Manual title'))
  assert.equal(store.list().find(item => item.id === 'alpha').title, 'Manual title')
  store.delete('beta')
  assert.equal(store.list().length, 1)
  assert.throws(() => store.get('../alpha'))
})


test('conversation details load independently after list selection and stale loads never replace the active chat', async t => {
  const pending = new Map()
  const fixture = chatFixture(t, {
    getConversation: id => new Promise(resolve => pending.set(id, resolve))
  })
  const loading = fixture.navigation.loadConversation('beta')
  assert.equal(fixture.navigation.conversationDetailState.value, 'loading')
  assert.equal(fixture.currentConversationId.value, 'beta')
  assert.deepEqual(fixture.messages.value, [])
  const other = fixture.navigation.loadConversation('gamma')
  pending.get('beta')({ ...record('beta'), messages: [{ id: 'beta-message', role: 'assistant', content: 'stale' }] })
  pending.get('gamma')({ ...record('gamma'), messages: [{ id: 'gamma-message', role: 'assistant', content: 'current' }] })
  await Promise.all([loading, other])
  assert.equal(fixture.currentConversationId.value, 'gamma')
  assert.equal(fixture.navigation.conversationDetailState.value, 'ready')
  assert.equal(fixture.messages.value[0].id, 'gamma-message')
})

async function workerFixture (t) {
  const dir = temporary(t)
  const output = path.join(dir, 'chat-history-worker.cjs')
  await build({ entryPoints: [new URL('../src/main/settings/chat-history-worker.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', outfile: output, logLevel: 'silent' })
  const store = new ChatHistoryStore(dir, pathToFileURL(output))
  // Tests explicitly drain/close before temporary data is removed.
  return { store, dir }
}

test('worker preserves messages, fork metadata and cleared overrides across save/patch/restart', async t => {
  const { store, dir } = await workerFixture(t)
  try {
    const conversation = { ...record('alpha'), forkedFromConversationId: 'root', manualTitle: true, temperature: 1.5 }
    const summary = await store.save(conversation)
    assert.equal(summary.messages, undefined)
    await store.updateMetadata('alpha', { providerId: 'b', selectedModel: 'b2', temperature: null })
    const loaded = await store.get('alpha')
    assert.deepEqual(loaded.messages, conversation.messages)
    assert.equal(loaded.forkedFromConversationId, 'root')
    assert.equal(loaded.manualTitle, true)
    assert.equal(loaded.providerId, 'b')
    assert.equal(loaded.temperature, undefined)
    await assert.rejects(store.updateMetadata('alpha', { messages: [] }), /metadata/)
    const later = await store.get('alpha')
    assert.deepEqual(later.messages, conversation.messages)
  } finally { await store.dispose() }
  const persisted = new ChatHistoryStorage(dir)
  assert.equal(persisted.get('alpha').selectedModel, 'b2')
  assert.ok(fs.readdirSync(path.join(dir, 'conversations')).every(file => !file.endsWith('.tmp')))
})

test('worker shutdown drains accepted writes, clone errors do not leak pending requests', async t => {
  const { store, dir } = await workerFixture(t)
  await assert.rejects(store.save({ ...record('bad'), fn: () => {} }), /clone|cloned/i)
  assert.equal(store.pending.size, 0)
  const saving = store.save(record('alpha'))
  const patching = store.updateMetadata('alpha', { providerId: 'b' })
  const closing = store.dispose()
  await Promise.all([saving, patching, closing])
  assert.equal(new ChatHistoryStorage(dir).get('alpha').providerId, 'b')
  await assert.rejects(store.get('alpha'), /closing|exited/)
})

test('slow or failed workers reject requests without falling back to blocking main-thread IO', async t => {
  const dir = temporary(t)
  const script = path.join(dir, 'silent-worker.cjs')
  fs.writeFileSync(script, "require('node:worker_threads').parentPort.on('message', () => {})")
  const store = new ChatHistoryStore(dir, pathToFileURL(script), 30)
  await assert.rejects(store.list(), /timed out/)
  assert.equal(store.pending.size, 0)
  await store.dispose().catch(() => {})
  const missing = new ChatHistoryStore(dir, pathToFileURL(path.join(dir, 'missing.cjs')))
  await assert.rejects(missing.list(), /Cannot find module|exited/)
  await missing.dispose().catch(() => {})
})

test('large legacy history indexing runs while the calling event loop remains responsive', async t => {
  const { store, dir } = await workerFixture(t)
  // A legacy directory has no summary cache yet. No user data is read here.
  const conversationsDir = path.join(dir, 'conversations')
  fs.mkdirSync(conversationsDir, { recursive: true })
  const large = 'word '.repeat(40_000)
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(conversationsDir, `history-${i}.json`), JSON.stringify({ ...record(`history-${i}`), messages: [{ role: 'user', content: large }] }))
  }
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 1)
  try {
    const summaries = await store.list()
    assert.equal(summaries.length, 40)
    assert.ok(ticks > 0, 'event loop must be able to service UI/IPC during indexing')
    assert.ok(summaries.every(summary => !('messages' in summary) && !('searchText' in summary) && (summary.previewText?.length || 0) <= 99))
  } finally {
    clearInterval(timer)
    await store.dispose()
  }
})

test('metadata-only writes stay small and never rewrite screenshot history; content saves fold overrides safely', t => {
  const dir = temporary(t)
  const store = new ChatHistoryStorage(dir)
  const old = { ...record('alpha'), temperature: 1.5, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'x'.repeat(2_000_000) } }] }] }
  store.save(old)
  store.list()
  const file = path.join(dir, 'conversations', 'alpha.json')
  const original = fs.readFileSync(file, 'utf-8')
  for (let i = 0; i < 10; i++) store.updateMetadata('alpha', { providerId: `b-${i}`, temperature: null })
  assert.equal(fs.readFileSync(file, 'utf-8'), original)
  const metadataFile = path.join(dir, 'conversations', 'metadata', 'alpha.json')
  assert.ok(fs.statSync(metadataFile).size < 512)
  const restarted = new ChatHistoryStorage(dir)
  assert.equal(restarted.list()[0].providerId, 'b-9')
  assert.equal(restarted.get('alpha').temperature, undefined)
  restarted.save({ ...old, providerId: 'stale-provider', messages: [...old.messages, { role: 'assistant', content: 'done' }] })
  assert.equal(restarted.get('alpha').providerId, 'b-9')
  assert.equal(restarted.get('alpha').temperature, undefined)
  assert.equal(restarted.get('alpha').messages.length, 2)
  assert.equal(fs.existsSync(metadataFile), false)
})

test('failed metadata writes leave the previous body, settings and summary intact', t => {
  const dir = temporary(t)
  const store = new ChatHistoryStorage(dir)
  store.save(record('alpha'))
  store.list()
  store.updateMetadata('alpha', { providerId: 'b' })
  const originalRename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to.includes(`${path.sep}metadata${path.sep}`)) throw new Error('disk failure')
    return originalRename(from, to)
  })
  assert.throws(() => store.updateMetadata('alpha', { providerId: 'c' }), /disk failure/)
  assert.equal(store.get('alpha').providerId, 'b')
  assert.equal(store.list()[0].providerId, 'b')
  assert.ok(fs.readdirSync(path.join(dir, 'conversations', 'metadata')).every(file => !file.endsWith('.tmp')))
})

test('a slow startup catalog cannot overwrite a newer settings change', async t => {
  let resolve
  const fixture = chatFixture(t, { getProviders: () => new Promise(done => { resolve = done }) })
  const oldLoad = fixture.providersState.loadProviders()
  const newer = { providers: [{ id: 'new', models: ['new-model'], activeModel: 'new-model' }], activeProviderId: 'new', enabledProviderIds: ['new'] }
  await fixture.providersState.applyProvidersConfig(newer)
  resolve({ providers: [{ id: 'old', models: ['old-model'] }], activeProviderId: 'old', enabledProviderIds: ['old'] })
  await oldLoad
  assert.equal(fixture.providersConfig.value.activeProviderId, 'new')
  assert.equal(fixture.activeProviderId.value, 'new')
})

test('auth changes retain the original conversation when the user navigates during the session RPC', async t => {
  let finishSessionUpdate
  const saved = []
  const fixture = chatFixture(t, {
    updateConversationMetadata: async (id, patch) => { saved.push({ id, patch }); return { success: true, summary: null } },
    updateChatSessionAuthMode: () => new Promise(resolve => { finishSessionUpdate = resolve })
  })
  fixture.activeStreamSessionIds.set('alpha', 'alpha-stream')
  const changing = fixture.providersState.handleAuthModeChange('auto')
  fixture.currentConversationId.value = 'beta'
  finishSessionUpdate({ ok: true })
  await changing
  assert.equal(saved.length, 1)
  assert.equal(saved[0].id, 'alpha')
  assert.equal(saved[0].patch.authMode, 'auto')
})

test('combined picker selection persists the final provider/model pair once, with no intermediate default model', async t => {
  const patches = []
  const failHeavyWork = () => { throw new Error('unexpected history/catalog work') }
  const fixture = chatFixture(t, {
    getProviders: failHeavyWork, listConversations: failHeavyWork, saveConversation: failHeavyWork,
    updateConversationMetadata: async (id, patch) => {
      patches.push({ id, patch })
      const { messages, ...summary } = record(id)
      return { success: true, summary: { ...summary, ...patch } }
    }
  })
  Object.defineProperty(fixture.messages, 'value', { get: failHeavyWork })
  await fixture.providersState.handleProviderModelSelectionChange({ providerId: 'b', model: 'b2' })
  assert.equal(fixture.activeProviderId.value, 'b')
  assert.equal(fixture.selectedModel.value, 'b2')
  assert.equal(patches.length, 1)
  assert.equal(patches[0].patch.providerId, 'b')
  assert.equal(patches[0].patch.selectedModel, 'b2')
  assert.equal(patches[0].id, 'alpha')
  await fixture.providersState.handleProviderModelSelectionChange({ providerId: 'b', model: 'b2' })
  assert.equal(patches.length, 1, 'reselecting the same model does not write or reorder anything')
})

test('one-summary updates retain descending timestamp order without refreshing the catalog', async t => {
  const fixture = chatFixture(t, { updateConversationMetadata: async (id, patch) => ({ success: true, summary: { ...record(id), ...patch, messages: undefined, updatedAt: '2026-09-12T01:30:00.000Z' } }) })
  fixture.conversations.value = [
    { ...record('gamma'), updatedAt: '2026-09-12T02:00:00.000Z' },
    { ...record('beta'), updatedAt: '2026-09-12T01:00:00.000Z' },
    { ...record('alpha'), updatedAt: date }
  ]
  const unrelated = fixture.conversations.value[0]
  await fixture.storage.saveConversationMetadata('alpha')
  assert.deepEqual(fixture.conversations.value.map(item => item.id), ['gamma', 'alpha', 'beta'])
  assert.equal(fixture.conversations.value[0], unrelated)
})
