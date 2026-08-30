import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const GROUP_STATE_KEY = '__worldbaseGroupRoutingTestState'

const STUBS = {
  '../state.js': `export const mainState = globalThis.${GROUP_STATE_KEY}`,
  './agent-context.js': `
    export function buildActiveAgentSection(agent) { return 'agent:' + agent.id }
    export function buildActiveGroupSection(group) { return 'group:' + group.id }
    export function resolveProviderConfig(providerId, modelId, reasoningStrength) {
      return { providerId, model: modelId, reasoningEffort: reasoningStrength }
    }
    export function resolveSkillContentsByIds(ids) { return (ids || []).map(id => 'skill:' + id) }
  `,
  '../chat-message-utils.js': `
    export function getLastUserMessageText(messages) {
      const message = [...messages].reverse().find(item => item.role === 'user')
      return typeof message?.content === 'string' ? message.content : ''
    }
    export function getMessageText(content) { return typeof content === 'string' ? content : '' }
    export function serializeMessageContentForDisplay(content) { return getMessageText(content) }
    export function truncateSectionText(value, limit) { return String(value || '').slice(0, limit) }
    export function firstNonEmptyLine(value) { return String(value || '').split('\\n').find(Boolean) || '' }
  `,
  './group-session.js': `
    export class GroupSession {
      constructor(input) { Object.assign(this, input); this.round = input.round }
      setRound(round) { this.round = round }
      setInjectionRecipients() {}
      onInjection() { return () => {} }
      drainInjections() { return [] }
      finishInjectionTurn() {}
      buildBoardPromptSection() { return { section: 'board:empty' } }
      getPeerMessages() { return [] }
      getDirectReplies() { return [] }
      getBoardUpdatesByAgent() { return [] }
      snapshot() {
        return {
          groupId: this.groupId,
          groupName: this.groupName,
          board: { goal: '', assumptions: [], tasks: [], decisions: [], evidenceRefs: [], openQuestions: [] },
          recentUpdates: [],
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      }
    }
    export const groupSessionRegistry = { register() {}, release() {} }
  `,
  './tool-group-collab.js': 'export function buildGroupCollabTools() { return [] }',
  '../../../src/main/i18n/main-i18n.js': 'export function t(key) { return key }'
}

let groupModulePromise

async function loadGroupModule () {
  if (groupModulePromise) return await groupModulePromise
  groupModulePromise = (async () => {
    const result = await build({
      entryPoints: ['electron/main-process/ai/group-deliberation.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      plugins: [{
        name: 'group-routing-stubs',
        setup (build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (Object.hasOwn(STUBS, args.path)) {
              return { path: args.path, namespace: 'group-routing-stub' }
            }
            return undefined
          })
          build.onLoad({ filter: /.*/, namespace: 'group-routing-stub' }, args => ({
            contents: STUBS[args.path],
            loader: 'js'
          }))
        }
      }]
    })
    const source = result.outputFiles[0].text
    return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  })()
  return await groupModulePromise
}

const NATIVE_STUBS = {
  '../chat-message-utils.js': `
    export function getLastUserMessageText(messages) {
      const message = [...messages].reverse().find(item => item.role === 'user')
      return typeof message?.content === 'string' ? message.content : ''
    }
    export function firstNonEmptyLine(value) { return String(value || '').split('\\n').find(Boolean) || '' }
    export function truncateSectionText(value, limit) { return String(value || '').slice(0, limit) }
  `,
  './group-deliberation.js': `
    export function appendGroupProgressStep(item, stage, detail) {
      item.progress.push({ stage, detail })
    }
    export function buildGroupTranscriptSummary(_group, entries) {
      return 'Rust notes: ' + entries.length
    }
    export function createAgentSidechatSession(input) {
      return { ...input, id: input.memberId + ':' + input.round, response: '', status: 'running', updatedAt: '', progress: [] }
    }
    export function createGroupCollaborationPlan(input) { return input }
    export function createGroupProgressSnapshot(group, ids, request, totalRounds) {
      return {
        groupId: group.id,
        groupName: group.name,
        request,
        status: 'running',
        activeRound: 0,
        totalRounds,
        maxParallelWorkers: 1,
        queuedCount: ids.length,
        runningCount: 0,
        completedCount: 0,
        failedCount: 0,
        items: ids.map(id => ({ id, agentId: id, agentName: id, status: 'queued', currentRound: 0, completedRounds: 0, totalRounds, stage: '', progress: [] }))
      }
    }
    export async function buildGroupRoundCoordinatorPlan(input) {
      const response = await input.runtimeAiEngine.chat(input.messages, {
        agentId: input.planner?.id,
        targetProjectId: input.targetProjectId,
        systemPromptSections: ['native group planner'],
        ...input.runtimeRequestContext
      })
      try {
        const parsed = JSON.parse(String(response?.content || ''))
        const selected = Array.isArray(parsed.memberIds)
          ? parsed.memberIds.filter(id => input.candidateMemberIds.includes(id))
          : input.candidateMemberIds
        return {
          shouldContinue: parsed.shouldContinue !== false && selected.length > 0,
          selectedMemberIds: selected,
          request: parsed.request || input.normalizedRequest,
          focus: parsed.focus || ''
        }
      } catch {
        return {
          shouldContinue: input.candidateMemberIds.length > 0,
          selectedMemberIds: input.candidateMemberIds,
          request: input.normalizedRequest,
          focus: ''
        }
      }
    }
    export function emitAgentSidechatSession(onProgress, sidechat) { onProgress?.({ type: 'agent_sidechat', sidechat }) }
    export function emitGroupCollaborationPlan(onProgress, plan) { onProgress?.({ type: 'group_collaboration_plan', plan }) }
    export function emitGroupProgressSnapshot(onProgress, groupProgress) { onProgress?.({ type: 'group_progress', groupProgress }) }
    export function getGroupProgressItem(snapshot, agentId) { return snapshot.items.find(item => item.agentId === agentId) || null }
    export function summarizeGroupNote(value) { return String(value || '').slice(0, 220) }
  `
}

let nativeGroupModulePromise

async function loadNativeGroupModule () {
  if (nativeGroupModulePromise) return await nativeGroupModulePromise
  nativeGroupModulePromise = (async () => {
    const result = await build({
      entryPoints: ['electron/main-process/ai/native-rust-group-deliberation.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      plugins: [{
        name: 'native-group-routing-stubs',
        setup (build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (Object.hasOwn(NATIVE_STUBS, args.path)) {
              return { path: args.path, namespace: 'native-group-routing-stub' }
            }
            return undefined
          })
          build.onLoad({ filter: /.*/, namespace: 'native-group-routing-stub' }, args => ({
            contents: NATIVE_STUBS[args.path],
            loader: 'js'
          }))
        }
      }]
    })
    const source = result.outputFiles[0].text
    return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  })()
  return await nativeGroupModulePromise
}

function makeAgent (id, name) {
  return {
    id,
    name,
    description: `${name} description`,
    systemPrompt: `${name} system prompt`,
    providerId: `${id}-provider`,
    modelId: `${id}-model`,
    reasoningStrength: 'high',
    skillIds: [`${id}-skill`],
    allowedTools: ['read_project_file'],
    deniedTools: [],
    memoryScopes: ['group'],
    memoryWritePolicy: { allowUserTraits: false, allowAgentSkills: false, allowSteps: false, allowKnowledge: false },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function makeGroup () {
  return {
    id: 'group-rust',
    name: 'Rust routing group',
    coordinatorAgentId: 'coordinator',
    memberAgentIds: ['member'],
    maxRounds: 1,
    maxParallelWorkers: 1,
    sharedMemoryScopes: [],
    visibility: 'expandable_internal_transcript',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

test('Rust-selected group work keeps planner and member turns on the Rust execution engine', async () => {
  const agents = new Map([
    ['coordinator', makeAgent('coordinator', 'Coordinator')],
    ['member', makeAgent('member', 'Member')]
  ])
  globalThis[GROUP_STATE_KEY] = {
    aiEngine: {},
    agentStore: { get: id => agents.get(id) },
    memoryEngine: null
  }
  const { buildGroupDeliberationSection, buildGroupRoundCoordinatorPlan } = await loadGroupModule()

  const plannerCalls = []
  const memberCalls = []
  const rustEngine = {
    getAvailableTools: () => [{ name: 'read_project_file', description: '', parameters: {} }],
    async chat (messages, options) {
      plannerCalls.push({ messages, options })
      return {
        role: 'assistant',
        content: JSON.stringify({
          shouldContinue: true,
          memberIds: ['member'],
          request: 'Inspect the active project',
          focus: 'implementation details'
        })
      }
    },
    async *chatStream (messages, _onProgress, options) {
      memberCalls.push({ messages, options })
      yield { type: 'token', content: 'Rust member note' }
      yield { type: 'done', message: { role: 'assistant', content: 'Rust member note' } }
    }
  }
  const runContext = {
    hostConversationId: 'electron-conversation',
    hostSessionId: 'electron-session',
    workspaceRoot: '/tmp/worldbase-group-workspace',
    authMode: 'auto',
    getAuthMode: () => 'auto'
  }
  const messages = [{ role: 'user', content: 'Please review the implementation.' }]
  const group = makeGroup()

  const plan = await buildGroupRoundCoordinatorPlan({
    runtimeAiEngine: rustEngine,
    planner: agents.get('coordinator'),
    group,
    messages,
    candidateMemberIds: ['member'],
    priorNotes: [],
    latestUserMessage: 'Please review the implementation.',
    normalizedRequest: 'Please review the implementation.',
    mentionedMemberIds: [],
    round: 1,
    totalRounds: 1,
    selectionSource: 'coordinator_decides',
    runtimeRequestContext: runContext
  })

  assert.deepEqual(plan.selectedMemberIds, ['member'])
  assert.equal(plannerCalls.length, 1)
  assert.equal(plannerCalls[0].options.agentId, 'coordinator')
  assert.equal(plannerCalls[0].options.hostConversationId, 'electron-conversation')
  assert.equal(plannerCalls[0].options.hostSessionId, 'electron-session')
  assert.equal(plannerCalls[0].options.workspaceRoot, '/tmp/worldbase-group-workspace')
  assert.equal(plannerCalls[0].options.getAuthMode(), 'auto')

  const result = await buildGroupDeliberationSection({
    messages,
    group,
    routing: {
      mode: 'targeted',
      selectedMemberIds: ['member'],
      mentionedMemberIds: ['member'],
      normalizedRequest: 'Please review the implementation.'
    },
    sessionId: 'electron-session',
    runtimeAiHarness: rustEngine,
    runtimeRequestContext: runContext
  })

  assert.match(result.promptSection || '', /Rust member note/)
  assert.equal(memberCalls.length, 1)
  assert.equal(memberCalls[0].options.agentId, 'member')
  assert.equal(memberCalls[0].options.hostConversationId, 'electron-conversation')
  assert.equal(memberCalls[0].options.hostSessionId, 'electron-session')
  assert.equal(memberCalls[0].options.workspaceRoot, '/tmp/worldbase-group-workspace')
  assert.equal(memberCalls[0].options.authMode, 'auto')
  assert.equal(memberCalls[0].options.getAuthMode(), 'auto')
  assert.deepEqual(memberCalls[0].options.allowedToolNames, [
    'read_project_file',
    'message_agent',
    'read_board',
    'update_board',
    'reply_to_user'
  ])
})

test('Rust-native group adapter owns group rounds, board state, and live injection', async () => {
  const { buildNativeRustGroupDeliberation, hasNativeRustGroupSession, injectNativeRustGroup } = await loadNativeGroupModule()
  const calls = []
  let emitRound = null
  let finishRound = null
  const client = {
    async createNativeGroup (params) {
      calls.push({ method: 'group.create', params })
      return { id: 'native-group', board: {} }
    },
    async startNativeGroupRound (params) {
      calls.push({ method: 'group.message', params })
      emitRound = params.onEvent
      await new Promise(resolve => { finishRound = resolve })
      return { streamId: 'native-group', round: params.round }
    },
    async waitForSessionEnd () {},
    async getNativeGroup () {
      calls.push({ method: 'group.get' })
      return {
        id: 'native-group',
        board: {
          goal: 'Ship native groups',
          assumptions: [],
          tasks: [{
            id: 'verify-route',
            title: 'Verify route',
            ownerAgentId: 'member',
            status: 'done',
            summary: 'Electron received the native task state.'
          }],
          decisions: [],
          evidenceRefs: [],
          openQuestions: []
        },
        boardUpdates: [{
          id: 'persisted-board-update',
          agentId: 'member',
          agentName: 'Member',
          field: 'tasks',
          op: 'update',
          payload: { id: 'verify-route', status: 'done' },
          reason: 'Round complete',
          at: '2026-01-01T00:00:00.000Z'
        }]
      }
    },
    async injectNativeGroup (sessionId, groupId, content, targetAgentIds) {
      calls.push({ method: 'group.inject', params: { sessionId, groupId, content, targetAgentIds } })
      return { queued: 1 }
    },
    async stopSession () {
      calls.push({ method: 'chat.abort' })
      return true
    }
  }
  const group = {
    ...makeGroup(),
    maxRounds: 1,
    visibility: 'expandable_internal_transcript'
  }
  const coordinator = makeAgent('coordinator', 'Coordinator')
  const worker = makeAgent('member', 'Member')
  const progress = []
  const run = buildNativeRustGroupDeliberation({
    client,
    group,
    agents: [coordinator, worker],
    messages: [{ role: 'user', content: 'Review this native group route.' }],
    routing: {
      mode: 'discussion',
      selectedMemberIds: ['member'],
      mentionedMemberIds: [],
      normalizedRequest: 'Review this native group route.'
    },
    sessionId: 'native-stream',
    onProgress: event => progress.push(event)
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hasNativeRustGroupSession('native-stream'), true)
  const injected = await injectNativeRustGroup('native-stream', group.id, 'Check cancellation.', ['member'])
  assert.deepEqual(injected, { ok: true, injected: true, queued: 1 })
  assert.equal(calls.find(call => call.method === 'group.create').params.members.length, 2)
  assert.equal(calls.find(call => call.method === 'group.create').params.maxParallelWorkers, group.maxParallelWorkers)
  assert.equal(calls.find(call => call.method === 'group.message').params.groupId, 'native-group')
  assert.deepEqual(calls.find(call => call.method === 'group.message').params.memberIds, ['member'])

  emitRound({ kind: 'start', groupMemberStreamId: 'native-group:member:member:child' })
  emitRound({ kind: 'group_message', member: 'Member', round: 1, content: 'Rust member note' })
  emitRound({
    kind: 'board_update',
    board: {
      goal: 'Ship native groups',
      assumptions: [],
      tasks: [{ id: 'verify-route', title: 'Verify route', ownerAgentId: 'member', status: 'running', summary: 'Checking the route.' }],
      decisions: [],
      evidenceRefs: [],
      openQuestions: []
    },
    update: {
      id: 'live-board-update',
      agentId: 'member',
      agentName: 'Member',
      field: 'tasks',
      op: 'update',
      payload: { id: 'verify-route', status: 'running' },
      at: '2026-01-01T00:00:00.000Z'
    }
  })
  emitRound({
    kind: 'group_direct_reply',
    reply: {
      id: 'direct-rust',
      agentId: 'member',
      agentName: 'Member',
      content: 'The Rust route is ready for review.',
      round: 1,
      endorsed: false,
      at: '2026-01-01T00:00:00.000Z'
    }
  })
  emitRound({
    kind: 'group_peer_message',
    message: {
      id: 'peer-rust',
      fromAgentId: 'member',
      fromAgentName: 'Member',
      toAgentId: 'coordinator',
      toAgentName: 'Coordinator',
      request: 'Please verify the migration.',
      response: 'Verified.',
      status: 'completed',
      round: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: '2026-01-01T00:00:01.000Z'
    }
  })
  emitRound({ kind: 'done', stopReason: 'group_complete' })
  finishRound()

  const result = await run
  assert.match(result.promptSection || '', /Rust member note/)
  assert.equal(result.transcript?.entryCount, 1)
  assert.equal(hasNativeRustGroupSession('native-stream'), false)
  assert.ok(progress.some(event => event.type === 'group_board'))
  assert.ok(progress.some(event => event.type === 'group_user_injection'))
  const persistedBoard = progress.find(event => event.type === 'group_board' && event.board?.board.tasks[0]?.status === 'done')
  assert.deepEqual(persistedBoard.board.board.tasks[0], {
    id: 'verify-route',
    title: 'Verify route',
    ownerAgentId: 'member',
    status: 'done',
    summary: 'Electron received the native task state.'
  })
  assert.equal(persistedBoard.board.recentUpdates[0].id, 'persisted-board-update')
  assert.equal(persistedBoard.board.recentUpdates[0].payload.status, 'done')
  const directReply = progress.find(event => event.type === 'group_direct_reply')
  assert.equal(directReply.directReply.groupId, group.id)
  assert.equal(directReply.directReply.content, 'The Rust route is ready for review.')
  const peerMessage = progress.find(event => event.type === 'group_peer_message')
  assert.equal(peerMessage.peerMessage.groupId, group.id)
  assert.equal(peerMessage.peerMessage.status, 'completed')
  assert.equal(peerMessage.peerMessage.response, 'Verified.')
})

test('Rust-native planner selects the requested members for coordinator-driven rounds', async () => {
  const { buildNativeRustGroupDeliberation } = await loadNativeGroupModule()
  const rounds = []
  const client = {
    async createNativeGroup () { return { id: 'planner-group', board: {} } },
    async startNativeGroupRound (params) {
      rounds.push(params.memberIds)
      params.onEvent({ kind: 'group_message', member: 'Member', round: params.round, content: 'Selected Rust member note' })
      params.onEvent({ kind: 'done', stopReason: 'group_complete' })
      return { streamId: 'planner-group', round: params.round }
    },
    async waitForSessionEnd () {},
    async getNativeGroup () { return { id: 'planner-group', board: {} } },
    async stopSession () { return true }
  }
  const plannerCalls = []
  const planner = {
    getAvailableTools: () => [],
    async chat (_messages, options) {
      plannerCalls.push(options)
      return { role: 'assistant', content: JSON.stringify({ shouldContinue: true, memberIds: ['member'], request: 'Inspect the route', focus: 'routing' }) }
    },
    async *chatStream () {}
  }
  const result = await buildNativeRustGroupDeliberation({
    client,
    planner,
    group: { ...makeGroup(), maxRounds: 1 },
    agents: [makeAgent('coordinator', 'Coordinator'), makeAgent('member', 'Member')],
    messages: [{ role: 'user', content: 'Coordinator, select a reviewer.' }],
    routing: {
      mode: 'coordinator_decides',
      selectedMemberIds: ['member'],
      mentionedMemberIds: [],
      normalizedRequest: 'select a reviewer',
      plannerAgentId: 'coordinator'
    },
    sessionId: 'planner-stream'
  })

  assert.equal(plannerCalls.length, 1)
  assert.equal(plannerCalls[0].agentId, 'coordinator')
  assert.deepEqual(rounds, [['member']])
  assert.match(result.promptSection || '', /Selected Rust member note/)
})

test('Rust-native group adapter preserves coordinator-only direct chat behavior', async () => {
  const { buildNativeRustGroupDeliberation } = await loadNativeGroupModule()
  const result = await buildNativeRustGroupDeliberation({
    client: {
      async createNativeGroup () { throw new Error('coordinator-only must not create a native group') }
    },
    group: makeGroup(),
    agents: [makeAgent('coordinator', 'Coordinator')],
    messages: [{ role: 'user', content: 'Coordinator, answer directly.' }],
    routing: {
      mode: 'coordinator_only',
      selectedMemberIds: [],
      mentionedMemberIds: [],
      normalizedRequest: 'answer directly'
    },
    sessionId: 'coordinator-only-stream'
  })
  assert.deepEqual(result, { promptSection: null, transcript: null })
})

test('aborting a Rust-native group sends cancellation through its parent group stream', async () => {
  const { buildNativeRustGroupDeliberation } = await loadNativeGroupModule()
  const controller = new AbortController()
  let releaseRound = null
  let abortCalls = 0
  const client = {
    async createNativeGroup () { return { id: 'abort-group', board: {} } },
    async startNativeGroupRound () {
      await new Promise(resolve => { releaseRound = resolve })
      return { streamId: 'abort-group', round: 1 }
    },
    async waitForSessionEnd () {},
    async getNativeGroup () { return { id: 'abort-group', board: {} } },
    async stopSession () {
      abortCalls++
      return true
    }
  }
  const run = buildNativeRustGroupDeliberation({
    client,
    group: { ...makeGroup(), maxRounds: 1 },
    agents: [makeAgent('coordinator', 'Coordinator'), makeAgent('member', 'Member')],
    messages: [{ role: 'user', content: 'Cancel this group.' }],
    routing: {
      mode: 'discussion',
      selectedMemberIds: ['member'],
      mentionedMemberIds: [],
      normalizedRequest: 'Cancel this group.'
    },
    sessionId: 'abort-group-stream',
    abortSignal: controller.signal
  })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('cancelled by user'))
  releaseRound()
  await assert.rejects(run, /cancelled by user/)
  assert.equal(abortCalls, 1)
})
