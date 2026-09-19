import assert from 'node:assert/strict'
import test from 'node:test'
import { createI18n } from 'vue-i18n'
import './register-ts-hooks.mjs'
import { messages } from '../src/locales/index.ts'
import { flush, loadSetupComponent, rendererFixture } from './helpers/renderer-fixture.mjs'

// The Settings > MCP panel must let a user disable a server, bring it back,
// and reconnect a disconnected one without opening the editor. Enabling and
// disabling go through saveMcpServers (the main process re-applies the
// catalog); connecting goes through the per-server refresh.

const MCPSettingsPanel = await loadSetupComponent(new URL('../src/renderer/components/settings/MCPSettingsPanel.vue', import.meta.url))

function serverConfig (overrides = {}) {
  return {
    id: 'srv-1',
    name: 'Filesystem',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: [],
    cwd: '',
    env: {},
    url: '',
    headers: {},
    timeoutMs: 15000,
    ...overrides
  }
}

function snapshot (config, status, extra = {}) {
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    transport: config.transport,
    status,
    updatedAt: null,
    tools: [],
    resources: [],
    prompts: [],
    capabilities: { tools: false, resources: false, prompts: false },
    ...extra
  }
}

function mountPanel (t, { servers, statusFor, onRefresh }) {
  const fixture = rendererFixture(t)
  let saved = servers
  const calls = { save: [], refresh: [], disconnect: [] }
  const state = () => ({ servers: saved.map(server => snapshot(server, statusFor(server))), updatedAt: 'now' })
  fixture.window.electronAPI = {
    getMcpServers: async () => saved,
    getMcpState: async () => state(),
    saveMcpServers: async (next) => { calls.save.push(next); saved = next; return { success: true } },
    refreshMcpServer: async (serverId) => {
      calls.refresh.push(serverId)
      return onRefresh(serverId, saved)
    },
    disconnectMcpServer: async (serverId) => {
      calls.disconnect.push(serverId)
      return snapshot(saved.find(server => server.id === serverId), 'disconnected')
    },
    onMcpStateChanged: () => () => {}
  }
  const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages })
  const mounted = fixture.mount(MCPSettingsPanel, {}, [i18n])
  return { ...mounted, window: fixture.window, calls, savedServers: () => saved }
}

test('toggle disables an enabled server and re-enables it from the detail header', async t => {
  const enabledStatus = new Map([['srv-1', 'connected']])
  const panel = mountPanel(t, {
    servers: [serverConfig()],
    statusFor: server => (server.enabled ? enabledStatus.get(server.id) : 'disconnected'),
    onRefresh: () => { throw new Error('toggle must not go through refresh') }
  })
  await flush()
  assert.equal(panel.state.selectedConfig.enabled, true)
  assert.equal(panel.state.selectedIsLive, true)

  await panel.state.toggleSelectedEnabled()
  assert.equal(panel.calls.save.length, 1)
  assert.equal(panel.calls.save[0][0].enabled, false)
  assert.equal(panel.state.selectedConfig.enabled, false)
  assert.equal(panel.state.selectedSnapshot.status, 'disconnected')
  assert.equal(panel.state.selectedIsLive, false)
  assert.equal(panel.state.statusMessage, '已禁用 Filesystem')

  await panel.state.toggleSelectedEnabled()
  assert.equal(panel.calls.save.length, 2)
  assert.equal(panel.calls.save[1][0].enabled, true)
  assert.equal(panel.savedServers()[0].enabled, true)
  assert.equal(panel.state.selectedConfig.enabled, true)
  assert.equal(panel.state.selectedSnapshot.status, 'connected')
  assert.equal(panel.state.selectedIsLive, true)
  assert.equal(panel.state.statusMessage, '已启用 Filesystem')
})

test('a failed save rolls the toggle back to the persisted enabled flag', async t => {
  const panel = mountPanel(t, {
    servers: [serverConfig()],
    statusFor: () => 'connected',
    onRefresh: () => { throw new Error('unused') }
  })
  await flush()
  panel.window.electronAPI.saveMcpServers = async () => { throw new Error('disk full') }

  await panel.state.toggleSelectedEnabled()
  assert.equal(panel.state.selectedConfig.enabled, true)
  assert.equal(panel.state.selectedIsLive, true)
  assert.match(panel.state.statusMessage, /disk full/)
})

test('connect reconnects a disconnected but enabled server through the per-server refresh', async t => {
  const config = serverConfig()
  const panel = mountPanel(t, {
    servers: [config],
    statusFor: () => 'disconnected',
    onRefresh: (serverId, saved) => snapshot(saved.find(server => server.id === serverId), 'connected', { updatedAt: 'now' })
  })
  await flush()
  assert.equal(panel.state.selectedIsLive, false)

  await panel.state.connectSelected()
  assert.deepEqual(panel.calls.refresh, ['srv-1'])
  assert.equal(panel.calls.save.length, 0)
  assert.equal(panel.state.selectedSnapshot.status, 'connected')
  assert.equal(panel.state.selectedIsLive, true)
  assert.equal(panel.state.statusMessage, '已连接 Filesystem')

  await panel.state.disconnectSelected()
  assert.deepEqual(panel.calls.disconnect, ['srv-1'])
  assert.equal(panel.state.selectedSnapshot.status, 'disconnected')
  assert.equal(panel.state.selectedIsLive, false)
})

test('connect surfaces a snapshot-level error instead of reporting success', async t => {
  const panel = mountPanel(t, {
    servers: [serverConfig()],
    statusFor: () => 'disconnected',
    onRefresh: (serverId, saved) => snapshot(saved.find(server => server.id === serverId), 'error', { error: 'spawn npx ENOENT' })
  })
  await flush()

  await panel.state.connectSelected()
  assert.equal(panel.state.selectedSnapshot.status, 'error')
  assert.equal(panel.state.selectedIsLive, false)
  assert.match(panel.state.statusMessage, /spawn npx ENOENT/)
})

test('connect is a no-op for a disabled server; the toggle is the way back', async t => {
  const panel = mountPanel(t, {
    servers: [serverConfig({ enabled: false })],
    statusFor: () => 'disconnected',
    onRefresh: () => { throw new Error('refresh must not run for a disabled server') }
  })
  await flush()

  await panel.state.connectSelected()
  assert.equal(panel.calls.refresh.length, 0)
  assert.equal(panel.state.selectedIsLive, false)
})
