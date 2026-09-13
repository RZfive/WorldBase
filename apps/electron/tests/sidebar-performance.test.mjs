import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, effectScope, reactive, ref } from 'vue'
import './register-ts-hooks.mjs'
import { createChatSidebarState } from '../src/renderer/components/chat/panel/sidebar-state.ts'
import { useConversationSidebarFolders } from '../src/renderer/components/chat/layout/useConversationSidebarFolders.ts'
import { flush, loadSetupComponent, rendererFixture } from './helpers/renderer-fixture.mjs'
import { createI18n } from 'vue-i18n'

const date = '2026-09-12T00:00:00.000Z'
function sidebarFixture (count = 5000) {
  let searchReads = 0
  const options = {
    t: key => key, locale: ref('zh-CN'),
    conversations: ref(Array.from({ length: count }, (_, i) => ({
      id: `chat-${i}`, title: `Chat ${i}`, updatedAt: date, createdAt: date, previewText: 'preview '.repeat(12),
      get searchText () { searchReads++; return 'history '.repeat(750) }
    }))),
    providers: ref([]), providersConfig: ref({ providers: [], activeProviderId: 'a', enabledProviderIds: [] }),
    activeProviderId: ref('a'), selectedModel: ref('a1'), availableAgents: ref([]), availableAgentGroups: ref([]),
    longTermGoals: ref([]), selectedLongTermGoalId: ref(null), selectedAgentId: ref(''), selectedGroupId: ref(''),
    selectedChannelBindingId: ref(''), currentConversationId: ref('chat-0'), streamingConversationIds: reactive(new Set()),
    getPendingAuthCount: () => 0, getUnreadCount: () => 0
  }
  return { ...options, state: createChatSidebarState(options), searchReads: () => searchReads }
}

test('5,000-chat navigation reuses presentation/search data and changes only two card props', t => {
  const fixture = sidebarFixture()
  let started = performance.now()
  const initial = fixture.state.conversationSidebarItems.value
  const initialMs = performance.now() - started
  const reads = fixture.searchReads()
  fixture.currentConversationId.value = 'chat-1'
  started = performance.now()
  const switched = fixture.state.conversationSidebarItems.value
  const switchMs = performance.now() - started
  assert.equal(fixture.searchReads(), reads)
  assert.equal(switched.filter((item, index) => item !== initial[index]).length, 2)
  assert.equal(switched[0].isActive, false)
  assert.equal(switched[1].isActive, true)
  fixture.activeProviderId.value = 'b'
  assert.equal(fixture.state.conversationSidebarItems.value, switched, 'provider selection does not invalidate the history list')
  t.diagnostic(`5,000 synthetic summaries (Vue data derivation, not browser paint): initial ${initialMs.toFixed(1)}ms; switch ${switchMs.toFixed(1)}ms`)
})

test('provider metadata updates rebuild one summary, preserving all other card identities', () => {
  const fixture = sidebarFixture()
  const initial = fixture.state.conversationSidebarItems.value
  const changed = { ...fixture.conversations.value[1], providerId: 'b', updatedAt: '2026-09-12T01:00:00.000Z' }
  const reads = fixture.searchReads()
  fixture.conversations.value = fixture.conversations.value.map((item, index) => index === 1 ? changed : item)
  const updated = fixture.state.conversationSidebarItems.value
  assert.equal(fixture.searchReads(), reads, 'unrelated histories must not be read again')
  assert.equal(updated.filter((item, index) => item !== initial[index]).length, 1)
  assert.notEqual(updated[1].subtitle, initial[1].subtitle)
})

test('cached sidebar labels still react to edits, locale, fork metadata and stream badges', () => {
  const fixture = sidebarFixture(4)
  const initial = fixture.state.conversationSidebarItems.value
  fixture.conversations.value[2].title = 'Renamed'
  fixture.conversations.value[2].previewText = 'New preview'
  fixture.conversations.value[2].forkedFromConversationId = 'parent'
  fixture.streamingConversationIds.add('chat-3')
  const updated = fixture.state.conversationSidebarItems.value
  assert.equal(updated[2].title, 'Renamed')
  assert.ok(updated[2].searchText.includes('New preview'))
  assert.equal(updated[2].isFork, true)
  assert.equal(updated[3].isStreaming, true)
  assert.equal(updated[0], initial[0])
  const reads = fixture.searchReads()
  fixture.locale.value = 'en-US'
  const localized = fixture.state.conversationSidebarItems.value
  assert.equal(fixture.searchReads(), reads, 'catalog rows do not contain large hidden search text')
  assert.notEqual(localized[0], updated[0])
})

test('default-agent histories remain visible, custom agent/group histories remain in their sections', () => {
  const fixture = sidebarFixture(5)
  fixture.availableAgents.value = [{ id: 'agent_default', name: 'Default' }, { id: 'custom', name: 'Custom' }]
  fixture.availableAgentGroups.value = [{ id: 'group', name: 'Group', memberAgentIds: [] }]
  fixture.conversations.value[0].agentId = 'agent_default'
  fixture.conversations.value[1].agentId = 'custom'
  fixture.conversations.value[2].groupId = 'group'
  fixture.conversations.value[3].agentId = 'deleted-agent'
  assert.deepEqual(fixture.state.conversationSidebarItems.value.map(item => item.id), ['chat-0', 'chat-3', 'chat-4'])
  fixture.availableAgents.value = [{ id: 'agent_default', name: 'Default' }]
  assert.ok(fixture.state.conversationSidebarItems.value.some(item => item.id === 'chat-1'))
})

test('folder layout observes ids only, not active flags or large search strings', async t => {
  const environment = rendererFixture(t)
  const saved = new Map()
  environment.window.localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value)
  }
  let textReads = 0
  const items = ref(Array.from({ length: 5000 }, (_, index) => ({
    id: `chat-${index}`, title: `Chat ${index}`, subtitle: '', isActive: index === 0,
    get searchText () { textReads++; return 'history '.repeat(750) }
  })))
  const scope = effectScope()
  t.after(() => scope.stop())
  const folders = scope.run(() => useConversationSidebarFolders(computed(() => items.value), ref(''), value => value.trim().toLowerCase(), ref(true), ref('Folder')))
  assert.equal(folders.conversationEntries.value.length, 5000)
  assert.equal(textReads, 0, 'initial folder normalization must not traverse presentation content')
  const stringify = t.mock.method(JSON, 'stringify')
  items.value[0].isActive = false
  items.value[1].isActive = true
  items.value[2].title = 'Renamed'
  await flush()
  assert.equal(stringify.mock.callCount(), 0)
  assert.equal(textReads, 0)
  items.value = items.value.slice()
  await flush()
  assert.equal(stringify.mock.callCount(), 0, 'new array with identical ids does not normalize layout')
  items.value = items.value.slice(1)
  await flush()
  assert.ok(stringify.mock.callCount() > 0, 'membership changes still persist correctly')
  assert.equal(folders.conversationEntries.value.length, 4999)
})



