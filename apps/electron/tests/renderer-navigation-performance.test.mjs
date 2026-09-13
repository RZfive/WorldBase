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
const history = (prefix = 'chat', count = 40) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, role: i % 2 ? 'assistant' : 'user', content: `Message ${i}` }))
const props = (messages = history()) => ({ messages, isLoading: false, filePreview: { active: false } })
const viewport = () => ({ clientHeight: 600, clientWidth: 1000, scrollTop: 0, scrollHeight: 100_000 })

test('message list renders the complete selected conversation without virtual row ranges', async t => {
  const fixture = rendererFixture(t)
  const messages = history('complete', 1200)
  const mounted = fixture.mount(MessageList, props(messages))
  assert.equal(mounted.props.messages.length, 1200)
  assert.equal(mounted.state.virtualRows, undefined)
  assert.equal(mounted.state.messageOffsets, undefined)
  assert.equal(mounted.state.minimapRows, undefined)
  mounted.state.messagesContainer = viewport()
  mounted.state.syncViewportState()
  mounted.state.messagesContainer.scrollTop = 5000
  mounted.state.handleScroll()
  assert.equal(mounted.state.scrollTop, 5000)
  await flush()
})

test('switching the selected history clears gallery state and keeps the new full message array', async t => {
  const fixture = rendererFixture(t)
  const mounted = fixture.mount(MessageList, props(history('first', 20)))
  mounted.state.galleryActive = true
  mounted.props.messages = history('second', 90)
  await flush()
  assert.equal(mounted.state.galleryActive, false)
  assert.equal(mounted.props.messages.length, 90)
  assert.equal(mounted.state.virtualRows, undefined)
})

test('sticky scrolling follows appended messages without height estimation or anchor compensation', async t => {
  const fixture = rendererFixture(t)
  const mounted = fixture.mount(MessageList, props(history('stream', 3)))
  const element = viewport()
  mounted.state.messagesContainer = element
  mounted.state.syncViewportState()
  mounted.state.autoStickEnabled = true
  mounted.props.messages = history('stream', 6)
  await flush()
  assert.equal(mounted.state.autoStickEnabled, true)
  assert.equal(mounted.state.measuredMessageHeights, undefined)
  assert.equal(mounted.state.pendingAnchorDelta, undefined)
})
