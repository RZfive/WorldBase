import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, reactive, ref } from 'vue'
import { createChatMessageSender } from '../src/renderer/components/chat/panel/message-sender.ts'
import { buildRenderSegments } from '../src/renderer/components/chat/message-segments.ts'

function createStreamFixture (context) {
  const messages = ref([])
  const saves = []
  const streams = []
  const pendingTimers = new Map()
  const streamingConversationIds = reactive(new Set())
  const activeStreamSessionIds = new Map()
  const activeCleanups = new Map()
  const previousWindow = globalThis.window
  let nextTimer = 0
  let streamStarted = Promise.withResolvers()
  const events = new Map()
  globalThis.window = {
    setTimeout: callback => {
      pendingTimers.set(++nextTimer, callback)
      return nextTimer
    },
    clearTimeout: timer => pendingTimers.delete(timer),
    electronAPI: {
      onStreamEvent (sessionId, callback) {
        events.set(sessionId, callback)
        return () => events.delete(sessionId)
      },
      chatStream (_messages, sessionId) {
        const result = Promise.withResolvers()
        const emit = events.get(sessionId)
        streams.push({ emit, resolve: roomReplies => result.resolve({ ok: true, roomReplies }), reject: result.reject })
        streamStarted.resolve(streams.at(-1))
        streamStarted = Promise.withResolvers()
        return result.promise
      },
      async stopChatStream () { return { ok: true, stopped: true } }
    }
  }
  context.after(() => {
    activeStreamSessionIds.clear()
    for (const cleanup of activeCleanups.values()) cleanup()
    for (const stream of streams) stream.resolve()
    globalThis.window = previousWindow
  })
  const sender = createChatMessageSender({
    t: key => key,
    getActivePageContext: () => null,
    getActiveTerminalContext: () => null,
    getActiveCodeContext: () => null,
    messages,
    currentConversationId: ref('conversation'),
    targetProjectId: ref(null),
    currentAuthMode: ref('strict'),
    reasoningStrength: ref('medium'),
    conversationTemperature: ref(null),
    pendingImages: ref([]),
    pendingFiles: ref([]),
    filePreview: ref({ active: false, filePath: '', lineCount: 0, added: 0, removed: 0 }),
    selectedAgentId: ref(''),
    selectedGroupId: ref('room'),
    selectedChannelBindingId: ref(''),
    activeProviderId: ref(''),
    selectedModel: ref(''),
    shouldUseConversationProviderOverride: ref(false),
    currentModelLabel: ref('Test model'),
    isDeletingConversation: () => false,
    isLoading: computed(() => streamingConversationIds.has('conversation')),
    isUploadingFiles: ref(false),
    computerUseEnabled: ref(false),
    streamingConversationIds,
    activeStreamSessionIds,
    activeCleanups,
    activeGroupSessionIds: new Set(),
    backgroundStreamMessages: new Map(),
    unreadConversationIds: new Set(),
    codingStatusByConversation: new Map(),
    codingDiffByConversation: new Map(),
    resolveAssistantSpeaker: () => ({ speakerName: 'Member', speakerIcon: '🎨' }),
    async saveConversation (_conversationId, snapshot) { saves.push(JSON.parse(JSON.stringify(snapshot))) },
    resetTransientStreamState: () => {},
    clearPendingAskUserRequests: () => {}
  })
  return {
    messages,
    saves,
    sender,
    pendingTimers,
    activeStreamSessionIds,
    async send () {
      const started = streamStarted.promise
      const finished = sender.sendMessage({ id: `user-${streams.length}`, content: '@Member 请回复', text: '@Member 请回复' })
      return { ...await started, finished }
    }
  }
}

function roomReply (content, speakerName = 'Member', speakerIcon = '🎨') {
  return { type: 'room_message', roomMessage: { content, speakerName, speakerIcon } }
}

function memberStatus (status) {
  return { type: 'room_member_status', roomMemberStatus: { status, speakerName: 'Member', speakerIcon: '🎨' } }
}

const roomDone = { type: 'done', message: { role: 'assistant', content: '' } }

test('an IPC return before room done leaves only the real, saved reply', async context => {
  const fixture = createStreamFixture(context)
  const stream = await fixture.send()
  const reply = roomReply('核对完成。')
  stream.emit(reply)
  stream.resolve([reply.roomMessage])
  await stream.finished
  assert.deepEqual(fixture.messages.value.map(message => message.content), ['@Member 请回复', '核对完成。'])
  assert.deepEqual(fixture.saves.at(-1), JSON.parse(JSON.stringify(fixture.messages.value)))
  stream.emit(roomDone)
  assert.deepEqual(fixture.saves.at(-1), JSON.parse(JSON.stringify(fixture.messages.value)))
  assert.equal(fixture.pendingTimers.size, 0)
})

test('the IPC result recovers replies whose live events are still queued', async context => {
  const fixture = createStreamFixture(context)
  const stream = await fixture.send()
  const replies = [roomReply('First reply'), roomReply('Second reply', 'QA', '🧪')]
  stream.emit(replies[0])
  stream.resolve(replies.map(event => event.roomMessage))
  await stream.finished
  stream.emit(replies[1])
  stream.emit(roomDone)
  assert.deepEqual(fixture.saves.at(-1).slice(1).map(message => [message.speakerName, message.content]), [
    ['Member', 'First reply'], ['QA', 'Second reply']
  ])
  assert.equal(fixture.messages.value.length, 3)
})

test('a direct member shows status and replies in the same row', async context => {
  const fixture = createStreamFixture(context)
  const stream = await fixture.send()
  const pendingRow = fixture.messages.value[1]
  stream.emit(memberStatus('queued'))
  assert.equal(pendingRow.roomReplyStatus, 'queued')
  stream.emit(memberStatus('running'))
  assert.equal(pendingRow.roomReplyStatus, 'running')
  stream.emit(roomReply('Done.'))
  stream.emit(memberStatus('completed'))
  assert.equal(fixture.messages.value.length, 2)
  assert.equal(fixture.messages.value[1], pendingRow)
  assert.equal(pendingRow.speakerIcon, '🎨')
  stream.emit(roomDone)
  stream.resolve()
  await stream.finished
  assert.equal(fixture.saves.at(-1)[1].roomReplyStatus, 'completed')
  assert.equal(fixture.saves.at(-1)[1].content, 'Done.')
  assert.equal(fixture.saves.length, 2)
})

test('the room activity stays in one disclosure above the final answer', async context => {
  const fixture = createStreamFixture(context)
  const stream = await fixture.send()
  const message = fixture.messages.value[1]
  stream.emit(memberStatus('running'))

  const live = buildRenderSegments(message.blocks, { roomReply: true, streaming: true })
  assert.equal(live.length, 1)
  assert.equal(live[0].type, 'group')
  assert.equal(live[0].block.endedAt, undefined)
  stream.emit({ type: 'thinking', content: 'Discarded attempt.' })
  stream.emit({ type: 'reset' })
  stream.emit({ type: 'thinking', content: 'Check both inputs.' })
  stream.emit({ type: 'tool_start', name: 'read_workspace_file', callId: 'first', filePath: '/work/a.md' })
  stream.emit({ type: 'group_peer_message', peerMessage: { id: 'handoff', status: 'pending' } })
  stream.emit({ type: 'tool_start', name: 'read_workspace_file', callId: 'second', filePath: '/work/b.md' })
  stream.emit({ type: 'tool_end', name: 'read_workspace_file', callId: 'first', error: 'File missing' })
  stream.emit({ type: 'tool_end', name: 'read_workspace_file', callId: 'second' })
  stream.emit({ type: 'thinking', content: 'Use the available file.' })
  stream.emit(roomReply('已核对。'))
  assert.equal(message.roomReplyStatus, 'completed')
  assert.equal(fixture.messages.value.length, 2)
  stream.emit(roomDone)
  stream.resolve()
  await stream.finished

  const saved = fixture.saves.at(-1)[1]
  const segments = buildRenderSegments(saved.blocks, { roomReply: true })
  assert.equal(segments.filter(segment => segment.type === 'group').length, 1)
  assert.equal(segments[0].key, live[0].key)
  assert.deepEqual(segments[0].groupEntries.map(({ block }) => block.kind === 'thinking'
    ? block.text : [block.toolRun.filePath, block.toolRun.status]), [
    'Check both inputs.', ['/work/a.md', 'failed'], ['/work/b.md', 'completed'], 'Use the available file.'
  ])
  assert.ok(segments[0].groupEntries.every(({ block }) => (block.toolRun ?? block).endedAt != null))
  assert.equal(segments.at(-1).type, 'single')
  assert.equal(segments.at(-1).block.content, '已核对。')
})

test('a handoff retains two independent replies and updates the original handoff block', async context => {
  const fixture = createStreamFixture(context)
  const stream = await fixture.send()
  const handoff = { id: 'handoff', kind: 'handoff', fromAgentName: 'Member', toAgentName: 'QA', request: 'Verify this.' }
  stream.emit(memberStatus('running'))
  stream.emit({ type: 'group_peer_message', peerMessage: { ...handoff, status: 'pending' } })
  stream.emit(roomReply('Draft ready.'))
  stream.emit(memberStatus('completed'))
  stream.emit(roomReply('Verified.', 'QA', '🧪'))
  stream.emit({ type: 'group_peer_message', peerMessage: { ...handoff, status: 'completed' } })
  stream.emit({ type: 'done', message: { role: 'assistant', content: 'Member: Draft ready. QA: Verified.' } })
  stream.resolve()
  await stream.finished
  const replies = fixture.saves.at(-1).slice(1)
  assert.deepEqual(replies.map(reply => [reply.speakerName, reply.content]), [['Member', 'Draft ready.'], ['QA', 'Verified.']])
  assert.deepEqual(replies[0].blocks.filter(block => block.kind === 'group_peer_message').map(block => block.peerMessage.status), ['completed'])
})

test('a truly empty reply is reported once and a rejected stream shows a failed state', async context => {
  const fixture = createStreamFixture(context)
  const empty = await fixture.send()
  empty.emit(memberStatus('queued'))
  empty.emit(roomReply('   '))
  empty.resolve()
  await empty.finished
  assert.equal(fixture.messages.value.length, 2)
  assert.equal(fixture.messages.value[1].content, 'chatUi.noResponse')
  assert.equal(fixture.messages.value[1].roomReplyStatus, 'failed')

  const failed = await fixture.send()
  failed.emit(memberStatus('running'))
  failed.reject(new Error('Unable to start the agent'))
  await failed.finished
  const last = fixture.saves.at(-1).at(-1)
  assert.equal(last.roomReplyStatus, 'failed')
  assert.deepEqual(last.blocks.map(block => block.kind), ['thinking', 'error'])
  assert.ok(last.blocks[0].endedAt)
})

test('stop and a late IPC return cannot close a newer stream in the same room', async context => {
  const fixture = createStreamFixture(context)
  const stopped = await fixture.send()
  stopped.emit(memberStatus('running'))
  stopped.emit({ type: 'progress', stage: 'Codex', detail: 'shell: check fixture' })
  await fixture.sender.stopCurrentStream()
  const stoppedMessage = fixture.messages.value[1]
  assert.equal(stoppedMessage.roomReplyStatus, 'stopped')
  const tool = stoppedMessage.blocks.find(block => block.kind === 'tool')
  assert.ok(tool.toolRun.endedAt)
  assert.deepEqual(tool.toolRun.progress.map(step => step.stage), ['Codex', 'chatUi.toolStageStopped'])

  const next = await fixture.send()
  next.emit(memberStatus('running'))
  const nextSessionId = fixture.activeStreamSessionIds.get('conversation')
  stopped.emit(roomReply('Late reply from the stopped run.'))
  stopped.emit(roomDone)
  stopped.resolve()
  await stopped.finished
  assert.equal(fixture.activeStreamSessionIds.get('conversation'), nextSessionId)
  assert.equal(fixture.messages.value[1].roomReplyStatus, 'stopped')
  assert.equal(fixture.messages.value[3].roomReplyStatus, 'running')

  next.emit(roomReply('New reply.'))
  next.emit(roomDone)
  next.resolve()
  await next.finished
  assert.equal(fixture.saves.at(-1).at(-1).content, 'New reply.')
  assert.equal(fixture.pendingTimers.size, 0)
})
