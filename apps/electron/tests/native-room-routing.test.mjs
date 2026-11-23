import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { build } from 'esbuild'

async function loadModule (entry, stubs) {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{
      name: 'room-fixtures',
      setup (bundle) {
        bundle.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'room-fixture' } : undefined)
        bundle.onLoad({ filter: /.*/, namespace: 'room-fixture' }, args => ({ contents: stubs[args.path] }))
      }
    }]
  })
  return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const roomModule = loadModule('electron/main-process/ai/native-rust-room.ts', {
  './service.js': 'export const inviteRoomLocalWorker = (...args) => globalThis.__testRoomJoin(...args)',
  '../../../src/main/i18n/main-i18n.js': 'export function t(key) { return key }',
  '../../src/main/i18n/main-i18n.js': 'export function t(key) { return key }'
})

const agents = [
  { id: 'default', name: 'Reviewer', icon: '🔎' },
  { id: 'member', name: 'Document Agent', icon: '🎨' },
  { id: 'other', name: 'Tester', icon: '🧪' }
]
const group = {
  id: 'room-fixture', name: 'Room', coordinatorAgentId: 'default', memberAgentIds: ['member', 'other', 'member', 'missing'],
  maxRounds: 3, maxParallelWorkers: 2
}

function finishRound (params) {
  for (const id of params.memberIds) {
    params.onEvent({ kind: 'start', groupMemberStreamId: `${params.groupId}:member:${id}:child` })
    params.onEvent({ kind: 'group_message', agentId: id, content: `Reply from ${id}` })
  }
  params.onEvent({ kind: 'done', stopReason: 'group_complete' })
}

function makeRoomRequest (text, context = {}) {
  const rounds = []
  const events = []
  const client = {
    async getAgentGroup () { return input.group },
    async createNativeGroup ({ sessionId }) { return { id: sessionId } },
    async startNativeGroupRound (params) { rounds.push(params); finishRound(params) },
    async waitForSessionEnd () {},
    async getNativeGroup () { return {} },
    async stopSession () { return true },
    ...context.client
  }
  const input = {
    client, group, agents,
    messages: [{ role: 'user', content: text }],
    sessionId: 'room-stream',
    onProgress: event => events.push(event)
  }
  return { input, rounds, events }
}

test('a broadcast directly runs every distinct room member once and returns individually authored messages', async () => {
  const { runNativeRoom } = await roomModule
  const { input, rounds, events } = makeRoomRequest('＠all @Document Agent 请各自回复。')
  const replies = await runNativeRoom({
    ...input,
    hostTools: {
      async chat () { assert.fail('A room message must not run a coordinator preflight or summary') },
      createElectronHostToolRegistrations: () => []
    },
    requestWorkspaceApproval: async () => assert.fail('Platform replies do not require a room-wide approval')
  })
  assert.deepEqual(rounds.map(round => round.memberIds), [['default', 'member', 'other']])
  assert.equal(rounds[0].text, '请各自回复。')
  assert.equal(rounds[0].authMode, 'strict')
  assert.ok(rounds[0].context.deniedToolNames.includes('read_board'))
  assert.ok(rounds[0].context.deniedToolNames.includes('message_agent'))
  assert.deepEqual(replies, agents.map(agent => ({ speakerName: agent.name, speakerIcon: agent.icon, content: `Reply from ${agent.id}` })))
  assert.deepEqual(events.filter(event => event.type === 'room_message').map(event => event.roomMessage), replies)
  assert.deepEqual([...new Set(events.map(event => event.type))].sort(), ['group_progress', 'group_session_state', 'room_message'])
})

test('named members and the default recipient use the same direct room dispatch', async () => {
  const { runNativeRoom } = await roomModule
  for (const [text, ids] of [
    ['请 @Document Agent 回复。', ['member']],
    ['@Document Agent @Tester Reply to this', ['member', 'other']],
    ['@Reviewer Reply to this', ['default']],
    ['@alloy is not a broadcast', ['default']],
    ['Check foo@all.example, please', ['default']],
    ['Hello, room.', ['default']]
  ]) {
    const { input, rounds, events } = makeRoomRequest(text)
    const replies = await runNativeRoom(input)
    assert.deepEqual(rounds.map(round => round.memberIds), [ids])
    assert.deepEqual(replies.map(reply => reply.content), ids.map(id => `Reply from ${id}`))
    if (ids.length === 1) {
      const statuses = events.filter(event => event.type === 'room_member_status').map(event => event.roomMemberStatus)
      assert.deepEqual(statuses.map(status => status.status), ['queued', 'running', 'completed'])
      assert.ok(statuses.every(status => status.speakerName === replies[0].speakerName && status.speakerIcon === replies[0].speakerIcon))
      assert.equal(events.some(event => event.type === 'group_progress'), false)
    }
  }
})

test('the only member also answers a bare @all', async () => {
  const { runNativeRoom } = await roomModule
  const { input, rounds } = makeRoomRequest('@all')
  input.group = { ...group, memberAgentIds: [] }
  await runNativeRoom(input)
  assert.deepEqual(rounds.map(round => round.memberIds), [['default']])
  assert.equal(rounds[0].text, '@all')
})

test('a single addressed member streams its own reasoning and tool activity before its final answer', async () => {
  const { runNativeRoom } = await roomModule
  const { input, events } = makeRoomRequest('@Document Agent Check the draft.', {
    client: {
      async startNativeGroupRound (params) {
        const stream = { groupMemberStreamId: `${params.groupId}:member:member:child` }
        params.onEvent({ ...stream, kind: 'start' })
        params.onEvent({ kind: 'thinking_delta', groupMemberStreamId: `${params.groupId}:member:other:child`, text: 'Other member' })
        params.onEvent({ ...stream, kind: 'thinking_delta', text: 'Inspect the draft.' })
        params.onEvent({ ...stream, kind: 'tool_call', callId: 'draft-read', name: 'read_workspace_file', args: { file_path: '/work/draft.md' } })
        params.onEvent({ ...stream, kind: 'tool_result', callId: 'draft-read', name: 'read_workspace_file', content: 'File body', isError: false })
        params.onEvent({ ...stream, kind: 'delta', text: 'Draft looks good.' })
        params.onEvent({ ...stream, kind: 'done', stopReason: 'stop' })
        params.onEvent({ kind: 'group_message', agentId: 'member', content: 'Draft looks good.' })
        params.onEvent({ kind: 'done', stopReason: 'group_complete' })
      }
    }
  })

  const replies = await runNativeRoom(input)
  assert.deepEqual(events.filter(event => !['group_session_state', 'room_member_status'].includes(event.type)), [
    { type: 'thinking', content: 'Inspect the draft.' },
    { type: 'tool_start', name: 'read_workspace_file', callId: 'draft-read', summary: '/work/draft.md', filePath: '/work/draft.md' },
    { type: 'tool_end', name: 'read_workspace_file', callId: 'draft-read' },
    { type: 'room_message', roomMessage: replies[0] }
  ])
  assert.equal(replies.length, 1)
  assert.equal(replies[0].content, 'Draft looks good.')
})

test('multi-recipient messages preserve each role’s assignment', async () => {
  const { runNativeRoom } = await roomModule
  const text = '@Document Agent Draft the changelog. @Tester Run the existing tests.'
  const { input, rounds } = makeRoomRequest(text)
  await runNativeRoom(input)
  assert.deepEqual(rounds[0].memberIds, ['member', 'other'])
  assert.equal(rounds[0].text, text)
})

test('a failed temporary worker remains available for a retry', async () => {
  const { runNativeRoom } = await roomModule
  const worker = { id: 'local_worker_codex_00000000000000000000000000000000', kind: 'codex', role: 'Frontend', exitAfterTask: true }
  const { input, events } = makeRoomRequest(`@${worker.id} Check the layout`, {
    client: {
      async startNativeGroupRound (params) {
        assert.deepEqual(params.memberIds, [worker.id])
        params.onEvent({ kind: 'group_member_failed', agentId: worker.id, message: 'CLI stopped with an error' })
        params.onEvent({ kind: 'done', stopReason: 'group_error' })
      },
      async removeRoomLocalWorker () { assert.fail('A Worker that did not deliver a result must not be removed') }
    }
  })
  input.group = { ...group, localWorkers: [worker] }
  await assert.rejects(runNativeRoom(input), /CLI stopped with an error/)
  assert.deepEqual(events.filter(event => event.type === 'room_member_status').map(event => event.roomMemberStatus.status), ['queued', 'failed'])
})

test('a room continues only explicit handoffs, with host tools still scoped to the current member stream', async () => {
  const { runNativeRoom } = await roomModule
  const hostContexts = []
  const recorded = []
  const membersByRound = []
  let authMode = 'strict'
  const task = 'Check the draft and provide evidence.'
  const { input, events } = makeRoomRequest('@Document Agent Draft the report.', {
    client: {
      async recordRoomHandoff (...args) { recorded.push(args) },
      async startNativeGroupRound (params) {
        membersByRound.push(params.memberIds)
        if (params.round === 1) {
          assert.equal(params.authMode, 'strict')
          authMode = 'auto'
          const streamId = `${params.groupId}:member:member:child`
          const tools = params.customToolsForStream(streamId, new AbortController().signal)
          assert.deepEqual(tools.map(tool => tool.definition.name), ['handoff_room_task'])
          await assert.rejects(tools[0].handler({ agentId: '@Unknown', task }), /room member/)
          await assert.rejects(tools[0].handler({ agentId: 'member', task }), /another member/)
          const result = await tools[0].handler({ agentId: '＠Tester', task })
          assert.equal(result.status, 'queued')
          assert.equal((await tools[0].handler({ agentId: 'other', task })).status, 'already_queued')
          assert.equal(hostContexts.at(-1).sessionId, streamId)
          assert.equal(hostContexts.at(-1).hostSessionId, input.sessionId)
          assert.equal(hostContexts.at(-1).hostConversationId, 'visible-room')
          assert.equal(hostContexts.at(-1).authMode, 'auto')
        } else {
          assert.equal(params.authMode, 'auto')
          assert.equal(params.recordMessage, false)
          assert.equal(params.memberRequests.other, `From Document Agent:\n${task}`)
        }
        finishRound(params)
      }
    }
  })
  const replies = await runNativeRoom({
    ...input,
    context: { hostConversationId: 'visible-room', getAuthMode: () => authMode },
    hostTools: { createElectronHostToolRegistrations: options => { hostContexts.push(options); return [] } }
  })
  assert.deepEqual(membersByRound, [['member'], ['other']])
  assert.deepEqual(recorded, [[`room-${group.id}`, 'member', 'other', task]])
  assert.deepEqual(replies.map(reply => reply.speakerName), ['Document Agent', 'Tester'])
  assert.deepEqual(events.filter(event => event.type === 'group_peer_message').map(event => event.peerMessage.status), ['pending', 'completed'])
})

test('live clarifications route to the active, mentioned, or all members without a planner', async () => {
  const { runNativeRoom, injectNativeRustGroup, hasNativeRustGroupSession, clearNativeRoomContext } = await roomModule
  const paused = Promise.withResolvers()
  const started = Promise.withResolvers()
  const targets = []
  const { input } = makeRoomRequest('@Document Agent Draft the report.', {
    client: {
      async startNativeGroupRound (params) {
        started.resolve()
        await paused.promise
        finishRound(params)
      },
      async injectNativeGroup (_sessionId, _groupId, _text, ids) { targets.push(ids); return { queued: ids.length } }
    }
  })
  const run = runNativeRoom(input)
  await started.promise
  try {
    assert.equal(hasNativeRustGroupSession(input.sessionId), true)
    await assert.rejects(clearNativeRoomContext(input.client, group.id, null, async () => assert.fail('Room is running')), /roomStopBeforeClearing/)
    for (const text of ['Include sources', '@Reviewer Please check', '@all Important detail']) {
      assert.equal((await injectNativeRustGroup(input.sessionId, group.id, text)).injected, true)
    }
    assert.equal((await injectNativeRustGroup(input.sessionId, group.id, 'Unexpected target', ['missing'])).injected, false)
    assert.deepEqual(targets, [['member'], ['default'], ['default', 'member', 'other']])
  } finally {
    paused.resolve()
    await run
  }
  assert.equal(hasNativeRustGroupSession(input.sessionId), false)
})

test('a clear blocks new turns until the visible history is saved and switches the room-only memory scope', async () => {
  const { runNativeRoom, clearNativeRoomContext } = await roomModule
  const { input, rounds } = makeRoomRequest('Fresh request.')
  const freshGroup = { ...group, roomContextId: 'new-generation' }
  const releasedKeys = []
  const started = Promise.withResolvers()
  const saved = Promise.withResolvers()
  input.client.clearRoomContext = async (id, conversationIds) => {
    assert.equal(id, group.id)
    assert.deepEqual(conversationIds, ['room-view'])
    return { group: freshGroup, previousContextId: 'old-generation' }
  }
  input.client.getAgentGroup = async () => freshGroup
  const clear = clearNativeRoomContext(input.client, group.id, { releaseRoomSessions: key => releasedKeys.push(key) }, async updated => {
    assert.equal(updated, freshGroup)
    started.resolve()
    await saved.promise
  }, ['room-view'])
  await started.promise
  try {
    await assert.rejects(runNativeRoom(input), /roomAlreadyRunning/)
  } finally {
    saved.resolve()
    await clear
  }
  await runNativeRoom({
    ...input,
    context: { memoryScopes: [{ scopeType: 'group', scopeId: group.id }, { scopeType: 'project', scopeId: 'project' }] }
  })
  assert.deepEqual(releasedKeys, ['room:old-generation', group.id])
  assert.equal(rounds[0].groupId, 'room:new-generation')
  assert.deepEqual(rounds[0].context.memoryScopes, [
    { scopeType: 'group', scopeId: 'room:new-generation' },
    { scopeType: 'project', scopeId: 'project' }
  ])
})

test('a member that produces no answer is marked failed without a synthetic success', async () => {
  const { runNativeRoom } = await roomModule
  const { input, events } = makeRoomRequest('@Document Agent Reply.', {
    client: { async startNativeGroupRound (params) { params.onEvent({ kind: 'done', stopReason: 'group_complete' }) } }
  })
  const replies = await runNativeRoom(input)
  assert.equal(replies.length, 1)
  assert.equal(replies[0].content, 'mainDialog.roomNoResult')
  assert.deepEqual(events.filter(event => event.type === 'room_member_status').map(event => event.roomMemberStatus.status), ['queued', 'failed'])
})

test('stopping a directly mentioned member cancels the Rust run and settles its visible state', async () => {
  const { runNativeRoom } = await roomModule
  const controller = new AbortController()
  let stopCalls = 0
  const { input, events } = makeRoomRequest('@Tester Reply.', {
    client: {
      async stopSession () { stopCalls++; return true },
      async startNativeGroupRound (params) {
        params.onEvent({ kind: 'start', groupMemberStreamId: `${params.groupId}:member:other:child` })
        controller.abort(new Error('cancelled by user'))
      }
    }
  })
  await assert.rejects(runNativeRoom({ ...input, abortSignal: controller.signal }), /cancelled by user/)
  assert.equal(stopCalls, 1)
  assert.deepEqual(events.filter(event => event.type === 'room_member_status').map(event => event.roomMemberStatus.status), ['queued', 'running', 'stopped'])
})

test('workspace approval only accepts the owning renderer and clears its listener on navigation', async context => {
  const ipcMain = new EventEmitter()
  globalThis.__worldbaseApprovalTestIpc = ipcMain
  context.after(() => { delete globalThis.__worldbaseApprovalTestIpc })
  const { requestRoomWorkspaceApproval } = await loadModule('electron/main-process/ai/room-workspace-approval.ts', {
    electron: 'export const ipcMain = globalThis.__worldbaseApprovalTestIpc'
  })
  const events = []
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel, payload) => events.push({ channel, payload })
  })
  const proposal = { purpose: 'room_workspace', title: 'Codex CLI', detail: '/example/folder' }
  const controller = new AbortController()
  const approval = requestRoomWorkspaceApproval(sender, 'stream', 'conversation', proposal, controller.signal)
  const request = events[0].payload
  assert.equal(events[0].channel, 'auth:request')
  assert.equal(request.detail, proposal.detail)
  assert.equal(request.purpose, 'room_workspace')
  ipcMain.emit('auth:response', { sender: {} }, { requestId: request.requestId, approved: true })
  assert.equal(events.length, 1)
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  assert.equal(events.length, 1)
  ipcMain.emit('auth:response', { sender }, { requestId: request.requestId, approved: true })
  assert.equal(await approval, true)
  assert.equal(ipcMain.listenerCount('auth:response'), 0)

  const cancelled = requestRoomWorkspaceApproval(sender, 'stream', 'conversation', proposal, controller.signal)
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.equal(await cancelled, false)
  assert.equal(ipcMain.listenerCount('auth:response'), 0)
})
