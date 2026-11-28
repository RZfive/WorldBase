import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { h, ref } from 'vue'
import './register-ts-hooks.mjs'
import { flush, loadSetupComponent, rendererFixture } from './helpers/renderer-fixture.mjs'

const AskUserPanel = await loadSetupComponent(new URL('../src/renderer/components/chat/layout/AskUserPanel.vue', import.meta.url))
const PinnedTodoPanel = await loadSetupComponent(new URL('../src/renderer/components/chat/layout/PinnedTodoPanel.vue', import.meta.url))
const ChatInput = await loadSetupComponent(new URL('../src/renderer/components/chat/layout/ChatInput.vue', import.meta.url))
const RoomLocalAgentDialog = await loadSetupComponent(new URL('../src/renderer/components/chat/layout/RoomLocalAgentDialog.vue', import.meta.url))
const LocalGroupSettingsDialog = await loadSetupComponent(new URL('../src/renderer/components/chat/layout/LocalGroupSettingsDialog.vue', import.meta.url))
const GroupMembersPanel = await loadSetupComponent(new URL('../src/renderer/components/chat/layout/GroupMembersPanel.vue', import.meta.url))
const ExecutionDisclosure = await loadSetupComponent(new URL('../src/renderer/components/chat/blocks/ExecutionDisclosure.vue', import.meta.url))

function cssRule (source, selector) {
  const start = source.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `missing CSS rule ${selector}`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++
    if (source[index] === '}') {
      depth--
      if (depth === 0) return source.slice(bodyStart + 1, index)
    }
  }
  throw new Error(`unterminated CSS rule ${selector}`)
}

test('attention cards expand while their scroll belongs to the card body', async () => {
  const [chatPanel, askPanel, todoPanel, authPanel, sudoPanel] = await Promise.all([
    readFile(new URL('../src/renderer/components/chat/panel/ChatPanelContainer.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/components/chat/layout/AskUserPanel.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/components/chat/layout/PinnedTodoPanel.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/components/chat/layout/AuthPermissionPanel.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/components/chat/layout/SudoPasswordPanel.vue', import.meta.url), 'utf8')
  ])

  const attentionZone = cssRule(chatPanel, '.chat-attention-zone')
  assert.match(attentionZone, /overflow:\s*visible/)
  assert.doesNotMatch(attentionZone, /overflow-y:\s*auto/)
  assert.doesNotMatch(attentionZone, /max-height:/)

  assert.match(cssRule(askPanel, '.ask-scroll'), /overflow-y:\s*auto/)
  assert.match(cssRule(todoPanel, '.todo-scroll'), /overflow-y:\s*auto/)
  assert.match(cssRule(authPanel, '.auth-detail-body'), /overflow-y:\s*auto/)
  assert.match(cssRule(sudoPanel, '.sudo-detail-body'), /overflow-y:\s*auto/)
})

test('ask user and todo panels honor controlled expansion', async t => {
  const fixture = rendererFixture(t)
  const ask = fixture.mount(AskUserPanel, {
    expanded: true,
    requests: [{
      requestId: 'ask-1',
      questions: [
        { id: 'q1', question: 'First?', options: ['Yes', 'No'] },
        { id: 'q2', question: 'Second?', options: ['A', 'B'] }
      ]
    }]
  })
  const todo = fixture.mount(PinnedTodoPanel, {
    expanded: true,
    isLoading: false,
    items: [
      { id: 1, title: 'First task', status: 'completed' },
      { id: 2, title: 'Second task', status: 'in-progress' }
    ]
  })
  await flush()

  assert.equal(ask.state.collapsed, false)
  assert.equal(todo.state.collapsed, false)
})

test('ask user panel merges every pending member request and submits each independently', async t => {
  const fixture = rendererFixture(t)
  const submissions = []
  const ask = fixture.mount(AskUserPanel, {
    expanded: true,
    requests: [
      {
        requestId: 'ask-a',
        questions: [
          { id: 'q1', question: 'Ship now?', options: ['Yes', 'No'] },
          { id: 'q2', question: 'Which target?', options: ['Desktop', 'Mobile'] }
        ]
      },
      {
        requestId: 'ask-b',
        questions: [
          { id: 'q1', question: 'Run the regression suite?', options: ['Run all', 'Run focused'] }
        ]
      }
    ],
    onSubmit: (requestId, answers) => submissions.push({ requestId, answers })
  })
  await flush()

  assert.equal(ask.state.questionEntries.length, 3)
  for (const entry of ask.state.questionEntries) {
    ask.state.pickOption(entry.key, entry.question.options[0])
  }
  ask.state.submit()

  assert.deepEqual(submissions, [
    {
      requestId: 'ask-a',
      answers: [
        { questionId: 'q1', selectedOption: 'Yes', customAnswer: null },
        { questionId: 'q2', selectedOption: 'Desktop', customAnswer: null }
      ]
    },
    {
      requestId: 'ask-b',
      answers: [
        { questionId: 'q1', selectedOption: 'Run all', customAnswer: null }
      ]
    }
  ])
})

test('ask user panel unblocks a completed request without waiting for other members', async t => {
  const fixture = rendererFixture(t)
  const submissions = []
  const ask = fixture.mount(AskUserPanel, {
    expanded: true,
    requests: [
      {
        requestId: 'ask-ready',
        questions: [{ id: 'q1', question: 'Ship now?', options: ['Yes', 'No'] }]
      },
      {
        requestId: 'ask-waiting',
        questions: [
          { id: 'q1', question: 'Which target?', options: ['Desktop', 'Mobile'] },
          { id: 'q2', question: 'Run all tests?', options: ['Yes', 'No'] }
        ]
      }
    ],
    onSubmit: (requestId, answers) => submissions.push({ requestId, answers })
  })
  await flush()

  ask.state.pickOption('ask-ready:q1', 'Yes')
  ask.state.submit()
  assert.deepEqual(submissions, [{
    requestId: 'ask-ready',
    answers: [{ questionId: 'q1', selectedOption: 'Yes', customAnswer: null }]
  }])

  ask.state.pickOption('ask-waiting:q1', 'Mobile')
  ask.state.pickOption('ask-waiting:q2', 'No')
  ask.state.submit()
  assert.deepEqual(submissions[1], {
    requestId: 'ask-waiting',
    answers: [
      { questionId: 'q1', selectedOption: 'Mobile', customAnswer: null },
      { questionId: 'q2', selectedOption: 'No', customAnswer: null }
    ]
  })
})

test('the invite dialog is centered without dimming or blurring the chat', async () => {
  const source = await readFile(new URL('../src/renderer/components/chat/layout/RoomLocalAgentDialog.vue', import.meta.url), 'utf8')
  const dialog = cssRule(source, '.room-agent-dialog')
  const backdrop = cssRule(source, '.room-agent-dialog::backdrop')
  assert.match(dialog, /position:\s*fixed/)
  assert.match(dialog, /inset:\s*0;/)
  assert.match(dialog, /margin:\s*auto/)
  assert.match(backdrop, /background:\s*transparent/)
  assert.doesNotMatch(backdrop, /backdrop-filter/)
})

test('the activity disclosure collapses at completion and can be reopened', async t => {
  const fixture = rendererFixture(t)
  const status = ref('running')
  const disclosure = ref(null)
  fixture.mount({
    render: () => h(ExecutionDisclosure, {
      ref: disclosure, title: 'Work', status: status.value, collapseOnSettle: true
    }, { default: () => 'Tool activity' })
  }, {})
  const state = disclosure.value.$.setupState
  state.toggleExpanded()
  assert.equal(state.expanded, true)
  status.value = 'completed'
  await flush()
  assert.equal(state.expanded, false)
  state.toggleExpanded()
  assert.equal(state.expanded, true)
})

test('the invite dialog can reuse the same CLI for several roles and remove a Worker independently', async t => {
  const fixture = rendererFixture(t)
  const invites = []
  const joined = []
  const removals = []
  fixture.window.electronAPI = {
    async getRoomLocalWorkspace () { return { path: '/room', source: 'group' } },
    async discoverLocalAgents () { return [{ agentId: 'local_cli_codex', name: 'Codex', kind: 'codex', available: true }] },
    async inviteRoomLocalWorker (agentId, groupId, options) {
      invites.push({ agentId, groupId, ...options })
      return { worker: { id: `local_worker_codex_0000000${invites.length}`, kind: 'codex', ...options } }
    },
    async removeRoomLocalWorker (groupId, workerId) { removals.push([groupId, workerId]) }
  }
  const previous = { id: 'existing-worker', kind: 'codex', role: 'Reviewer', exitAfterTask: false }
  const { state } = fixture.mount(RoomLocalAgentDialog, { groupId: 'room', workers: [previous], onJoined: name => joined.push(name) })
  await flush()
  assert.equal(state.selectedId, 'local_cli_codex')
  assert.equal(state.canJoin, false)
  state.role = 'Implementer'
  state.instructions = 'Limit edits to the UI.'
  await state.join()
  state.role = 'Tester'
  state.exitAfterTask = true
  await state.join()
  await state.removeWorker(previous)
  assert.deepEqual(invites.map(invite => [invite.agentId, invite.role, invite.instructions, invite.exitAfterTask]), [
    ['local_cli_codex', 'Implementer', 'Limit edits to the UI.', false],
    ['local_cli_codex', 'Tester', '', true]
  ])
  assert.deepEqual(joined, ['Implementer-00000001', 'Tester-00000002'])
  assert.deepEqual(removals, [['room', previous.id]])
})

test('group settings own the working folder, authorization mode and local agent roster', async t => {
  const fixture = rendererFixture(t)
  const invites = []
  const removals = []
  const authChanges = []
  const changed = []
  const previous = { id: 'existing-worker', kind: 'codex', role: 'Reviewer', exitAfterTask: false }
  const group = {
    id: 'room',
    name: 'Product room',
    coordinatorAgentId: 'default',
    memberAgentIds: ['default'],
    maxRounds: 3,
    maxParallelWorkers: 2,
    localWorkers: [previous]
  }
  fixture.window.electronAPI = {
    async getRoomLocalWorkspace () { return { path: '/room/project', source: 'group' } },
    async pickFolderWorkspace () { return { canceled: false, rootPath: '/room/next', rootName: 'next' } },
    async setRoomLocalWorkspace (groupId, rootPath, rootName) {
      return { ...group, workspaceRoot: rootPath, workspaceRootName: rootName }
    },
    async discoverLocalAgents () {
      return [{ agentId: 'local_cli_codex', name: 'Codex', kind: 'codex', available: true }]
    },
    async inviteRoomLocalWorker (agentId, groupId, options) {
      invites.push({ agentId, groupId, ...options })
      const worker = { id: 'local_worker_codex_00000001', kind: 'codex', ...options }
      return { worker, group: { ...group, localWorkers: [...group.localWorkers, worker] } }
    },
    async removeRoomLocalWorker (groupId, workerId) {
      removals.push([groupId, workerId])
      return { group: { ...group, localWorkers: [] }, removed: true }
    }
  }
  const { state } = fixture.mount(LocalGroupSettingsDialog, {
    open: true,
    group,
    authMode: 'strict',
    workers: [previous],
    onAuthModeChange: value => authChanges.push(value),
    onChanged: value => changed.push(value)
  })
  await flush()

  assert.equal(state.workspace.path, '/room/project')
  assert.equal(state.selectedAgentId, 'local_cli_codex')
  assert.equal(state.canJoin, false)
  await state.chooseWorkspace()
  state.role = 'Tester'
  state.exitAfterTask = true
  await state.joinAgent()
  state.setAuthMode('auto')
  await state.removeWorker(previous)

  assert.deepEqual(invites, [{
    agentId: 'local_cli_codex',
    groupId: 'room',
    role: 'Tester',
    instructions: '',
    exitAfterTask: true
  }])
  assert.deepEqual(removals, [['room', 'existing-worker']])
  assert.deepEqual(authChanges, ['auto'])
  assert.equal(state.workspace.path, '/room/next')
  assert.equal(changed.length, 3)
  assert.equal(changed[0].workspaceRoot, '/room/next')
})

test('each member Agent branch can collapse independently', async t => {
  const fixture = rendererFixture(t)
  const { state } = fixture.mount(GroupMembersPanel, {
    group: {
      id: 'room',
      name: 'Product room',
      coordinatorAgentId: 'agent-a',
      memberAgentIds: ['agent-a', 'agent-b'],
      localWorkers: []
    },
    agents: [
      { id: 'agent-a', name: 'Planner' },
      { id: 'agent-b', name: 'Reviewer' }
    ],
    localWorkers: []
  })

  assert.equal(state.isAgentBranchCollapsed('room:local'), false)
  state.toggleAgentBranch('room:local')
  assert.equal(state.isAgentBranchCollapsed('room:local'), true)
  state.toggleAgentBranch('room:local')
  assert.equal(state.isAgentBranchCollapsed('room:local'), false)
})

test('the shared main button stops an active room while Enter sends a clarification', async t => {
  const fixture = rendererFixture(t)
  const actions = []
  fixture.window.electronAPI = {
    async injectGroupClarification (...args) {
      actions.push(args)
      return { injected: true }
    }
  }
  const props = {
    modelValue: 'Please check the result',
    isLoading: true,
    pendingImages: [],
    pendingFiles: [],
    isUploadingFiles: false,
    uploadFeedback: '',
    workspaceVisible: false,
    authMode: 'strict',
    planModeActive: false,
    isGroupConversation: true,
    selectedGroupId: 'room',
    activeGroupSessionId: 'run',
    onStop: () => actions.push('stop'),
    onSend: () => actions.push('send')
  }
  const composer = fixture.mount(ChatInput, props)
  composer.state.handlePrimaryAction()
  composer.state.handleKeydown({ key: 'Enter', preventDefault () {} })
  await flush()
  const emptyComposer = fixture.mount(ChatInput, { ...props, modelValue: '' })
  emptyComposer.state.handleKeydown({ key: 'Enter', preventDefault () {} })
  emptyComposer.state.handlePrimaryAction()
  const idleComposer = fixture.mount(ChatInput, { ...props, isLoading: false })
  idleComposer.state.handlePrimaryAction()

  assert.deepEqual(actions, ['stop', ['run', 'room', 'Please check the result'], 'stop', 'send'])
  const source = await readFile(new URL('../src/renderer/components/chat/layout/ChatInput.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /room-stop-btn/)
  assert.match(source, /stopping: props\.isLoading/)
})

test('group settings stay mounted on their own state and open as a drawer under the title row', async () => {
  const [chatPanel, localSettings] = await Promise.all([
    readFile(new URL('../src/renderer/components/chat/panel/ChatPanelContainer.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/components/chat/layout/LocalGroupSettingsDialog.vue', import.meta.url), 'utf8')
  ])

  assert.match(chatPanel, /const localGroupSettingsOpen = ref\(false\)/)
  assert.match(chatPanel, /<LocalGroupSettingsDialog\s+:open="localGroupSettingsOpen"/)
  assert.doesNotMatch(chatPanel, /<LocalGroupSettingsDialog\s+v-if=/)

  // The drawer is drawn in place, inside the chat panel's drawer slot. The
  // slot is the grid row under the title, so the drawer cannot cover the
  // title row; it lets clicks through to the chat, the drawer takes them back.
  assert.doesNotMatch(localSettings, /<Teleport/)
  assert.match(cssRule(chatPanel, '.chat-panel-drawer-slot'), /grid-row:\s*2/)
  assert.match(cssRule(chatPanel, '.chat-panel-drawer-slot'), /pointer-events:\s*none/)
  assert.match(cssRule(localSettings, '.local-group-settings-drawer'), /pointer-events:\s*auto/)
  // Square along its top edge: it meets the title row as a flush panel, not a card.
  assert.doesNotMatch(cssRule(localSettings, '.local-group-settings-drawer'), /border-top-left-radius/)
})
