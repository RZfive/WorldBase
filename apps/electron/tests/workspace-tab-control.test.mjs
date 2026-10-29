import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  applyWorkspaceControlToSnapshot,
  buildWorkspaceTabSummaries,
  buildWorkspaceTabSummary,
  findWorkspaceTabs,
  hydrateWorkspaceSnapshot,
  openWorkspaceTabInSnapshot,
  workspaceStore
} from '../src/renderer/components/workspace/workspace-store.ts'
import {
  listUserAddableWorkspaceTabDefinitions,
  registerWorkspaceTab
} from '../src/renderer/components/workspace/tab-registry.ts'

// Minimal stand-ins for the built-in multi-instance kinds: the production
// matchers (tab-registry-entries) pull in .vue components, so the tests
// register equivalent match rules inline — normalizeUrlKey-style for browser
// and exact-cwd for terminal.
const normalizeUrlKey = (url = '') => {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`.toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

registerWorkspaceTab({
  kind: 'browser',
  titleKey: 'test.browser',
  icon: '🌐',
  singleton: false,
  minWidth: 0,
  maxWidth: 0,
  defaultWidth: 0,
  component: null,
  matches: (tab, payload) =>
    normalizeUrlKey(tab.state?.url) === normalizeUrlKey(payload.url)
})

registerWorkspaceTab({
  kind: 'terminal',
  titleKey: 'test.terminal',
  icon: '>_',
  singleton: false,
  minWidth: 0,
  maxWidth: 0,
  defaultWidth: 0,
  component: null,
  matches: (tab, payload) =>
    String(tab.state?.cwd || '').replace(/\/+$/, '') === String(payload.cwd || '').replace(/\/+$/, '')
})

registerWorkspaceTab({
  kind: 'folder',
  titleKey: 'test.folder',
  icon: '📁',
  singleton: true,
  minWidth: 0,
  maxWidth: 0,
  defaultWidth: 0,
  component: null
})

registerWorkspaceTab({
  kind: 'document',
  titleKey: 'test.document',
  icon: '📄',
  singleton: false,
  minWidth: 0,
  maxWidth: 0,
  defaultWidth: 0,
  component: null,
  matches: (tab, payload) =>
    String(tab.state?.filePath || '').trim().replace(/\//g, '\\').toLowerCase()
      === String(payload.filePath || '').trim().replace(/\//g, '\\').toLowerCase()
})

registerWorkspaceTab({
  kind: 'project',
  titleKey: 'test.project',
  icon: 'project',
  singleton: false,
  minWidth: 0,
  maxWidth: 0,
  defaultWidth: 0,
  component: null
})

registerWorkspaceTab({
  kind: 'coding',
  titleKey: 'test.coding',
  icon: 'coding',
  singleton: false,
  userAddable: false,
  minWidth: 0,
  maxWidth: 0,
  defaultWidth: 0,
  component: null
})

registerWorkspaceTab({
  kind: 'coding-diff',
  titleKey: 'test.codingDiff',
  icon: 'diff',
  singleton: false,
  userAddable: false,
  minWidth: 0,
  maxWidth: 0,
  defaultWidth: 0,
  component: null
})

const builtinDefinitionsSource = readFileSync(
  new URL('../src/renderer/components/workspace/tab-registry-entries.ts', import.meta.url),
  'utf8'
)

function builtinDefinitionBlock (kind) {
  const escaped = kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`kind: '${escaped}'([\\s\\S]*?)\\n  \\}\\)`).exec(builtinDefinitionsSource)?.[1] ?? ''
}

/** Restores the module-singleton store between tests. */
function resetStore (tabs) {
  workspaceStore.tabs.value = tabs
  workspaceStore.activeTabId.value = tabs[tabs.length - 1]?.id ?? null
  workspaceStore.visible.value = false
}

const browserTabA = { id: 'browser-a', kind: 'browser', title: 'Docs', state: { url: 'https://example.com/docs' } }
const browserTabB = { id: 'browser-b', kind: 'browser', state: { url: 'https://example.com/search?q=ai' } }
const terminalTab = { id: 'terminal-1', kind: 'terminal', state: { cwd: '/repo', sessionId: 's1' } }

test('buildWorkspaceTabSummaries exposes identity, live title and key bindings', () => {
  resetStore([browserTabA, terminalTab])

  assert.deepEqual(buildWorkspaceTabSummaries(), [
    { id: 'browser-a', kind: 'browser', title: 'Docs', active: false, url: 'https://example.com/docs' },
    { id: 'terminal-1', kind: 'terminal', title: 'terminal', active: true, cwd: '/repo' }
  ])
})

test('buildWorkspaceTabSummary marks the active tab', () => {
  resetStore([browserTabA, browserTabB])
  workspaceStore.activeTabId.value = 'browser-b'
  assert.equal(buildWorkspaceTabSummary(browserTabA).active, false)
  assert.equal(buildWorkspaceTabSummary(browserTabB).active, true)
})

test('findWorkspaceTabs matches multi-instance tabs by kind and payload', () => {
  resetStore([browserTabA, browserTabB, terminalTab])

  // Kind alone returns every tab of the kind.
  assert.deepEqual(
    findWorkspaceTabs('browser').map(tab => tab.id),
    ['browser-a', 'browser-b']
  )
  // Payload reuses the open-dedupe match rule (URL normalization).
  assert.deepEqual(findWorkspaceTabs('browser', { url: 'https://example.com/docs/' }).map(tab => tab.id), ['browser-a'])
  assert.deepEqual(findWorkspaceTabs('terminal', { cwd: '/repo' }).map(tab => tab.id), ['terminal-1'])
  // No match fields at all.
  assert.deepEqual(findWorkspaceTabs(undefined).length, 3)
  // Unknown kind never matches.
  assert.deepEqual(findWorkspaceTabs('project'), [])
  // Matched kind, unmatched payload.
  assert.deepEqual(findWorkspaceTabs('browser', { url: 'https://other.example' }), [])
})

test('findWorkspaceTabs returns the whole strip when no kind is given', () => {
  resetStore([browserTabA, terminalTab])
  assert.deepEqual(
    findWorkspaceTabs().map(tab => tab.id),
    ['browser-a', 'terminal-1']
  )
})

// ---------------------------------------------------------------------------
// Background conversation snapshots: AI requests for a conversation that is
// not displayed must mutate only that conversation's stored snapshot.
// ---------------------------------------------------------------------------

test('openWorkspaceTabInSnapshot dedupes by the kind match rule and activates', () => {
  const state = { tabs: [{ id: 'browser-a', kind: 'browser', state: { url: 'https://example.com/docs' } }], activeTabId: 'browser-a' }

  openWorkspaceTabInSnapshot(state, 'browser', { url: 'https://example.com/docs/' })
  assert.deepEqual(state.tabs.map(tab => tab.id), ['browser-a'])
  assert.equal(state.activeTabId, 'browser-a')
  assert.equal(state.tabs[0].state.url, 'https://example.com/docs/')

  openWorkspaceTabInSnapshot(state, 'browser', { url: 'https://example.com/other' })
  assert.equal(state.tabs.length, 2)
  assert.equal(state.activeTabId, state.tabs[1].id)
  // Documents show their file name as the tab title, like the live open path.
  openWorkspaceTabInSnapshot(state, 'document', { filePath: '/tmp/report.docx' })
  assert.equal(state.tabs[2].title, 'report.docx')
})

test('openWorkspaceTabInSnapshot binds the folder entry and keeps it singleton', () => {
  const state = {}

  openWorkspaceTabInSnapshot(state, 'folder', { rootPath: '/repo', rootName: 'repo', activeFilePath: 'src/a.ts' })
  assert.equal(state.tabs.length, 1)
  assert.equal(state.tabs[0].kind, 'folder')
  assert.deepEqual(state.tabs[0].state, { rootPath: '/repo', rootName: 'repo', activeFilePath: 'src/a.ts' })
  assert.equal(state.activeTabId, state.tabs[0].id)

  openWorkspaceTabInSnapshot(state, 'folder', { rootPath: '/other', activeFilePath: 'b.ts' })
  assert.equal(state.tabs.length, 1)
  assert.equal(state.tabs[0].state.rootPath, '/other')
  assert.equal(state.tabs[0].state.activeFilePath, 'b.ts')
  assert.equal(state.tabs[0].state.rootName, 'other')
})

test('applyWorkspaceControlToSnapshot lists summaries with active flags', () => {
  const state = {
    tabs: [
      { id: 'browser-a', kind: 'browser', title: 'Docs', state: { url: 'https://example.com/docs' } },
      { id: 'terminal-1', kind: 'terminal', state: { cwd: '/repo' } }
    ],
    activeTabId: 'terminal-1'
  }

  const { result } = applyWorkspaceControlToSnapshot(state, { action: 'list' })
  assert.deepEqual(result.tabs, [
    { id: 'browser-a', kind: 'browser', title: 'Docs', active: false, url: 'https://example.com/docs' },
    { id: 'terminal-1', kind: 'terminal', title: 'terminal', active: true, cwd: '/repo' }
  ])
})

test('applyWorkspaceControlToSnapshot activates and closes through stored tabs only', () => {
  const state = {
    tabs: [
      { id: 'browser-a', kind: 'browser', state: { url: 'https://example.com/docs' } },
      { id: 'browser-b', kind: 'browser', state: { url: 'https://example.com/search' } }
    ],
    activeTabId: 'browser-b'
  }

  const activated = applyWorkspaceControlToSnapshot(state, { action: 'activate', tabId: 'browser-a' })
  assert.equal(state.activeTabId, 'browser-a')
  assert.equal(activated.result.tab.id, 'browser-a')

  const closed = applyWorkspaceControlToSnapshot(state, { action: 'close', kind: 'browser', url: 'https://example.com/search' })
  assert.deepEqual(state.tabs.map(tab => tab.id), ['browser-a'])
  assert.equal(closed.result.tab.id, 'browser-b')

  const emptied = applyWorkspaceControlToSnapshot(state, { action: 'close', tabId: 'browser-a' })
  assert.equal(emptied.state, undefined)
  assert.deepEqual(emptied.result.tabs, [])
})

test('applyWorkspaceControlToSnapshot reports missing targets like the live path', () => {
  assert.throws(
    () => applyWorkspaceControlToSnapshot({ tabs: [], activeTabId: null }, { action: 'activate', kind: 'browser' }),
    /No matching workspace tab/
  )
  assert.throws(
    () => applyWorkspaceControlToSnapshot(undefined, { action: 'close', kind: 'terminal' }),
    /No matching workspace tab/
  )
  // A list over an empty snapshot stays a clean empty answer.
  const { result } = applyWorkspaceControlToSnapshot(undefined, { action: 'list' })
  assert.deepEqual(result.tabs, [])
})

test('hydrateWorkspaceSnapshot seeds from legacy mirrors and leaves live tabs alone', () => {
  const folderOnly = hydrateWorkspaceSnapshot(undefined, {
    folderWorkspace: { rootPath: '/repo', rootName: '' },
    documentWorkspace: { documents: [{ filePath: '/tmp/a.docx', fileName: 'a.docx' }], activeFilePath: '/tmp/a.docx' }
  })
  assert.deepEqual(folderOnly.tabs.map(tab => tab.kind), ['folder', 'document'])
  assert.equal(folderOnly.tabs[0].state.rootPath, '/repo')
  assert.equal(folderOnly.tabs[0].state.rootName, 'repo')
  // The legacy active document wins the restored active tab.
  assert.equal(folderOnly.activeTabId, folderOnly.tabs[1].id)

  const untouched = hydrateWorkspaceSnapshot(
    { tabs: [{ id: 'browser-a', kind: 'browser', state: { url: 'https://example.com' } }], activeTabId: 'browser-a' },
    { folderWorkspace: { rootPath: '/stale', rootName: 'stale' } }
  )
  assert.deepEqual(untouched.tabs.map(tab => tab.id), ['browser-a'])
})

test('system-managed coding tabs are excluded from the add-tab menu', () => {
  const addableKinds = listUserAddableWorkspaceTabDefinitions().map(definition => definition.kind)

  for (const kind of ['folder', 'document', 'browser', 'terminal', 'project']) {
    assert.ok(addableKinds.includes(kind), `${kind} should remain user-addable`)
  }
  for (const kind of ['coding', 'coding-diff']) {
    assert.ok(!addableKinds.includes(kind), `${kind} should not be user-addable`)
  }
})

test('built-in coding tab registrations opt out of the add-tab menu', () => {
  for (const kind of ['coding', 'coding-diff']) {
    const block = builtinDefinitionBlock(kind)
    assert.ok(block, `missing built-in ${kind} registration`)
    assert.match(block, /userAddable:\s*false/)
  }
  for (const kind of ['folder', 'document', 'browser', 'terminal', 'project']) {
    const block = builtinDefinitionBlock(kind)
    assert.ok(block, `missing built-in ${kind} registration`)
    assert.doesNotMatch(block, /userAddable:\s*false/)
  }
})
