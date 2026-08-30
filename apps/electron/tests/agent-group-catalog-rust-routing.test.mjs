import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const ipcSource = fs.readFileSync(new URL('../electron/main-process/ipc.ts', import.meta.url), 'utf8')
const clientSource = fs.readFileSync(new URL('../electron/main-process/rust-harness-client.ts', import.meta.url), 'utf8')

function handlerBody (channel) {
  const start = ipcSource.indexOf(`ipcMain.handle('${channel}'`)
  assert.notEqual(start, -1, `missing ${channel} handler`)
  const next = ipcSource.indexOf("ipcMain.handle('", start + 1)
  return ipcSource.slice(start, next === -1 ? undefined : next)
}

test('agent and group catalog IPC routes through Rust when selected', () => {
  for (const [channel, method] of [
    ['agents:list', 'listAgents'],
    ['agents:get', 'getAgent'],
    ['agents:save', 'saveAgent'],
    ['agents:delete', 'deleteAgent'],
    ['agentGroups:list', 'listAgentGroups'],
    ['agentGroups:get', 'getAgentGroup'],
    ['agentGroups:save', 'saveAgentGroup'],
    ['agentGroups:delete', 'deleteAgentGroup']
  ]) {
    const body = handlerBody(channel)
    assert.match(body, /selectedRustProjectClient\(\)/)
    assert.match(body, new RegExp(`rustClient\\.${method}\\(`))
  }
})

test('Rust client exposes dedicated catalog RPCs and handoff mirrors', () => {
  for (const method of ['listAgents', 'getAgent', 'saveAgent', 'deleteAgent', 'listAgentGroups', 'getAgentGroup', 'saveAgentGroup', 'deleteAgentGroup']) {
    assert.match(clientSource, new RegExp(`async ${method} \\(`))
  }
  assert.match(clientSource, /onAgentsHandoff\?:/)
  assert.match(clientSource, /onAgentGroupsHandoff\?:/)
  assert.match(clientSource, /agentGroup\.list/)
})
