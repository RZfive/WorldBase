import assert from 'node:assert/strict'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { createComputerUsePermissionState } from '../src/renderer/utils/computer-use-permissions.ts'
import { createStartupPermissionSnapshot } from '../electron/main-process/permissions/startup-snapshot.ts'
import { flush, loadSetupComponent, rendererFixture } from './helpers/renderer-fixture.mjs'

const granted = { platform: 'darwin', screen: 'granted', accessibility: true, granted: true }
const denied = { ...granted, screen: 'denied', granted: false }

test('native permissions are probed once at startup, never by status IPC reads', () => {
  let probes = 0
  const snapshot = createStartupPermissionSnapshot(() => { probes++; return granted }, denied)
  assert.equal(snapshot.get(), denied)
  assert.equal(probes, 0)
  snapshot.initialize()
  for (let i = 0; i < 1000; i++) {
    snapshot.initialize()
    assert.equal(snapshot.get(), granted)
  }
  assert.equal(probes, 1)
})

test('a failed startup probe does not turn into repeated retries during navigation', () => {
  let probes = 0
  const snapshot = createStartupPermissionSnapshot(() => { probes++; throw new Error('TCC unavailable') }, denied)
  for (let i = 0; i < 100; i++) {
    assert.equal(snapshot.initialize(), denied)
    assert.equal(snapshot.get(), denied)
  }
  assert.equal(probes, 1)
})

test('renderer startup requests share one snapshot, even after focus changes and long idle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const fixture = rendererFixture(t)
  let reads = 0
  const state = createComputerUsePermissionState(() => ({ getComputerUsePermissions: async () => { reads++; return granted } }))
  await Promise.all([state.initialize(), state.initialize()])
  for (let i = 0; i < 100; i++) {
    fixture.window.dispatchEvent(new Event('focus'))
    fixture.document.dispatchEvent(new Event('visibilitychange'))
    t.mock.timers.tick(60_000)
    await state.initialize()
  }
  assert.equal(reads, 1)
  assert.equal(state.status.value, granted)
  assert.equal(fixture.window.listenerCount(), 0)
  assert.equal(fixture.document.listenerCount(), 0)
})

test('failed startup IPC stays unknown and does not recheck on button clicks', async () => {
  let reads = 0
  const state = createComputerUsePermissionState(() => ({ getComputerUsePermissions: async () => { reads++; throw new Error('offline') } }))
  assert.equal(await state.initialize(), null)
  assert.equal(await state.initialize(), null)
  assert.equal(state.granted.value, null)
  assert.equal(reads, 1)
})

test('explicit grant opens settings once but never re-probes or mutates the startup snapshot', async () => {
  let reads = 0
  let requests = 0
  const state = createComputerUsePermissionState(() => ({
    getComputerUsePermissions: async () => { reads++; return denied },
    requestComputerUsePermissions: async () => { requests++; return { granted: true } }
  }))
  await state.initialize()
  await Promise.all([state.request(), state.request()])
  assert.equal(requests, 1)
  assert.equal(reads, 1)
  assert.equal(state.status.value, denied)
  assert.equal(state.requesting.value, false)
})

const MessageList = await loadSetupComponent(new URL('../src/renderer/components/chat/messages/MessageList.vue', import.meta.url))
const history = (prefix = 'chat', count = 400) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, role: 'assistant', content: `Message ${i}` }))
const props = () => ({ messages: history(), isLoading: false, filePreview: { active: false } })
const viewport = () => ({ clientHeight: 600, clientWidth: 1000, scrollTop: 800, scrollHeight: 100_000 })

test('hidden chat preserves viewport/row sizes, scroll position and stops minimap work', async t => {
  const fixture = rendererFixture(t)
  const { state } = fixture.mount(MessageList, props())
  const element = viewport()
  state.messagesContainer = element
  state.autoStickEnabled = false
  state.syncViewportMetrics()
  const rowKey = state.getMessageKey(0)
  state.updateMeasuredHeight(rowKey, 0, 360)
  await flush()
  const previousRange = { ...state.visibleRange }
  assert.ok(fixture.idleCallbacks.size > 0)
  element.clientHeight = 0
  element.clientWidth = 0
  element.scrollTop = 0
  state.syncViewportMetrics()
  state.updateMeasuredHeight(rowKey, 0, 0)
  state.handleScroll()
  state.flushScrollToBottom()
  await flush()
  assert.equal(state.viewportHeight, 600)
  assert.equal(state.minimapTrackWidth, 1000)
  assert.equal(state.scrollTop, 800)
  assert.equal(state.autoStickEnabled, false)
  assert.equal(state.measuredMessageHeights[rowKey], 360)
  assert.deepEqual(state.visibleRange, previousRange)
  assert.equal(fixture.idleCallbacks.size, 0)
  element.clientHeight = 600
  element.clientWidth = 1000
  state.syncViewportMetrics()
  assert.equal(element.scrollTop, 800)
  assert.ok(fixture.idleCallbacks.size > 0)
})

test('conversation changes reset minimap indexes instead of rendering 300 replacement rows', async t => {
  const fixture = rendererFixture(t)
  const mounted = fixture.mount(MessageList, props())
  mounted.state.messagesContainer = viewport()
  mounted.state.syncViewportMetrics()
  // Simulate the previous history having finished its idle rendering.
  mounted.state.minimapMountedIndexes = new Set(Array.from({ length: 300 }, (_, i) => i))
  mounted.props.messages = history('different')
  await flush()
  assert.ok(mounted.state.minimapMountedIndexes.size < 40)
  assert.ok(fixture.idleCallbacks.size <= 1)
})

test('without requestIdleCallback minimap still mounts bounded deferred batches', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fixture = rendererFixture(t, { idle: false })
  const { state } = fixture.mount(MessageList, props())
  const element = viewport()
  state.messagesContainer = element
  state.syncViewportMetrics()
  const immediateCount = state.minimapMountedIndexes.size
  assert.ok(immediateCount < 40)
  t.mock.timers.tick(32)
  assert.equal(state.minimapMountedIndexes.size, immediateCount + 3)
  element.clientHeight = 0
  state.syncViewportMetrics()
  const hiddenCount = state.minimapMountedIndexes.size
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(state.minimapMountedIndexes.size, hiddenCount)
})

test('an idle callback racing a settings navigation cannot mount hidden rows', async t => {
  const fixture = rendererFixture(t)
  const { state } = fixture.mount(MessageList, props())
  const element = viewport()
  state.messagesContainer = element
  state.syncViewportMetrics()
  const callback = [...fixture.idleCallbacks.values()][0]
  const before = state.minimapMountedIndexes.size
  // Simulate display:none before the container ResizeObserver delivers it.
  element.clientWidth = 0
  callback()
  await flush()
  assert.equal(state.minimapMountedIndexes.size, before)
})

test('a sticky chat resumes at the tail after messages arrive while hidden', async t => {
  const fixture = rendererFixture(t)
  const { state } = fixture.mount(MessageList, props())
  const element = viewport()
  state.messagesContainer = element
  state.syncViewportMetrics()
  element.clientHeight = 0
  state.syncViewportMetrics()
  element.scrollHeight += 5000
  element.scrollTop = 0
  state.scrollToBottom()
  await flush()
  assert.equal(element.scrollTop, 0, 'no scrolling work while hidden')
  element.clientHeight = 600
  state.syncViewportMetrics()
  assert.equal(element.scrollTop, element.scrollHeight)
})

