import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { RustHarnessEngine, codingEventsForGenericFileResult, codingEventsForToolResult, planModeExitedAfterNativeResult, shouldActivateCodingMode, webToolResultEvents, fileWritePreviewEvents } from '../src/main/ai-harness/rust-harness-engine.ts'
import { toRendererStreamEvent } from '../electron/main-process/ai/stream-event-contract.ts'
import { codingStatusForCancelledRun } from '../src/shared/coding-status-types.ts'
import {
  CODING_STATE_STORAGE_PREFIX,
  MAX_CODING_DIFF_BYTES,
  clearCodingState,
  codingStateStorageKey,
  decodeCodingState,
  encodeCodingState,
  loadCodingState,
  saveCodingStateNow
} from '../src/renderer/components/chat/panel/coding-status-storage.ts'
import { ElectronToolRegistry } from '../src/main/ai-harness/electron-tool-registry.ts'
import { MCPService } from '../src/main/mcp/mcp-service.ts'
import { RustHarnessClient } from '../electron/main-process/rust-harness-client.ts'
import { normalizeRustAskUserQuestions, normalizeRustAskUserResponse } from '../electron/main-process/ai/rust-ask-user-contract.ts'

const SESSION_ID = 'rust-host-test-session'

test('Rust ask_user host contract preserves one bundled 1-4 question request', () => {
  const questions = normalizeRustAskUserQuestions({
    questions: [
      { id: 'mode', question: 'Mode?', options: ['Fast', 'Careful'] },
      { id: 'format', question: 'Format?', options: ['JSON', 'Text'] },
      { id: 'third', question: 'Third?', options: ['A'] },
      { id: 'fourth', question: 'Fourth?', options: ['B'] },
      { id: 'ignored', question: 'Ignored?', options: ['C'] }
    ]
  }, 'request-batch')
  assert.equal(questions.length, 4)

  const response = normalizeRustAskUserResponse([
    { questionId: 'mode', selectedOption: 'Careful', customAnswer: null },
    { questionId: 'format', selectedOption: 'JSON', customAnswer: 'Markdown' }
  ], questions.slice(0, 2))
  assert.deepEqual(response, {
    answers: [
      { question: 'Mode?', answer: 'Careful' },
      { question: 'Format?', answer: 'Markdown' }
    ]
  })
})

test('Rust ask_user host contract retains legacy single payload and response aliases', () => {
  const questions = normalizeRustAskUserQuestions({
    question: 'Continue?',
    choices: ['Yes', 'No']
  }, 'request-legacy')
  assert.deepEqual(questions, [{
    id: 'request-legacy-question-1',
    question: 'Continue?',
    options: ['Yes', 'No']
  }])
  assert.deepEqual(normalizeRustAskUserResponse({ answer: 'Yes' }, questions), {
    answers: [{ question: 'Continue?', answer: 'Yes' }],
    answer: 'Yes'
  })
})

function createNativeToolClient (domainTools = []) {
  return {
    async start () {},
    getAvailableTools: () => [
      { name: 'enter_plan_mode', description: 'Enter plan mode', inputSchema: { type: 'object' } },
      { name: 'exit_plan_mode', description: 'Exit plan mode', inputSchema: { type: 'object' } },
      ...domainTools.map(tool => typeof tool === 'string'
        ? { name: tool, description: `Rust ${tool}`, inputSchema: { type: 'object' } }
        : tool)
    ]
  }
}

function createServices (overrides = {}) {
  return {
    projectFS: {
      async readFile () { return '' },
      async writeFile () {},
      async listProjects () { return [] }
    },
    runtimeManager: {
      getStatus () { return { status: 'stopped' } }
    },
    builderService: {},
    apiClient: {},
    dataAccess: {},
    asyncTaskManager: {
      startTask () { return { task_id: 'task-1' } },
      getTask () { return null }
    },
    ...overrides
  }
}

function createHarnessEngine (services, domainToolNames = []) {
  return new RustHarnessEngine({
    client: createNativeToolClient(domainToolNames),
    services
  })
}

async function collectHostTools (engine, context = {}) {
  // collectCustomTools is intentionally private to the facade. Calling it in
  // this bridge test lets us inspect exactly the registrations that Rust sees
  // before it sends a tool.execute host request.
  return await engine.collectCustomTools(context)
}

function getTool (registrations, name) {
  const tool = registrations.find(candidate => candidate.definition.name === name)
  assert.ok(tool, `expected Rust registration for ${name}`)
  return tool
}

async function dispatchToolExecute (registrations, name, args, onProgress) {
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-host-test'),
    onEvent: () => {}
  })
  const responses = []
  const progress = []
  client.sessionCustomTools.set(SESSION_ID, new Map(
    registrations.map(tool => [tool.definition.name, tool])
  ))
  client.handlers.set(SESSION_ID, frame => {
    progress.push(frame)
    onProgress?.(frame)
  })
  client.respondHost = async (requestId, result) => {
    responses.push({ requestId, result })
  }

  await client.handleHostRequest({
    requestId: `request-${name}`,
    requestKind: 'tool.execute',
    payload: { name, args },
    streamId: 'rust-host-test-stream'
  }, SESSION_ID)

  assert.equal(responses.length, 1, 'every Rust host request receives one response')
  return { result: responses[0].result, progress }
}

test('project file tools are Rust-native and register no Node override', async () => {
  // read/write/edit/patch/delete/list project files plus project glob/grep
  // search execute in Rust (`electron_native`), including the Office
  // direct-write guard and the SafeWriter-style backup.
  const services = createServices()
  const registrations = await collectHostTools(createHarnessEngine(services), { authMode: 'strict' })

  for (const name of [
    'read_project_file',
    'write_project_file',
    'edit_project_file',
    'patch_project_file',
    'delete_project_file',
    'list_project_files',
    'glob_search',
    'grep_search',
    'run_shell_command',
    'get_command_status',
    'query_project_database',
    'analyze_project_data',
    'create_project',
    'list_projects',
    'start_project_server',
    'restart_project_server',
    'get_project_status',
    'get_project_logs',
    'rebuild_project',
    'finalize_project',
    'clear_project_build_flag',
    'call_project_api',
    'create_agent',
    'create_agent_group',
    'list_agent_workspace_catalog',
    'run_skill',
    'list_skills',
    'install_skill',
    'manage_todo_list',
    'spawn_subagents',
    'web_search',
    'fetch_webpage',
    'mcp_call',
    'mcp_list_servers',
    'mcp_list_resources',
    'mcp_read_resource',
    'mcp_list_prompts',
    'mcp_get_prompt',
    'install_mcp_server',
    'local_read_file',
    'local_run_command',
    'local_write_file',
    'create_scheduled_task',
    'list_scheduled_tasks',
    'start_async_task',
    'get_task_status',
    'read_document',
    'list_documents'
  ]) {
    assert.equal(
      registrations.some(tool => tool.definition.name === name),
      false,
      `${name} must execute in Rust, not through a Node host override`
    )
  }
})

test('folder-workspace file tools are Rust-native and register no Node override', async () => {
  // list/read/write/edit/patch/delete/glob/grep workspace tools execute in
  // Rust (`electron_native`); the facade's onNativeToolResult hook broadcasts
  // folderWorkspace:changed from the Rust result shapes.
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'worldbase-rust-workspace-'))
  try {
    const services = createServices()
    const registrations = await collectHostTools(createHarnessEngine(services), {
      authMode: 'strict',
      workspaceRoot
    })

    for (const name of [
      'list_workspace_files',
      'read_workspace_file',
      'write_workspace_file',
      'edit_workspace_file',
      'patch_workspace_file',
      'delete_workspace_file',
      'glob_workspace',
      'grep_workspace'
    ]) {
      assert.equal(
        registrations.some(tool => tool.definition.name === name),
        false,
        `${name} must execute in Rust, not through a Node host override`
      )
    }
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('Rust-native image tools no longer register a Node Studio fallback', async () => {
  // generate_image / edit_image are Rust-native (`electron_native`): requests
  // land in the Rust `studio_pending_tasks` queue that the renderer drains.
  // A Node host override would write to a dead in-memory buffer, so the
  // facade must not register one even when Studio services are present.
  const services = createServices({
    settingsStore: {},
    imageLibraryStore: {},
    enqueueStudioImageTasks: () => {}
  })
  const registrations = await collectHostTools(createHarnessEngine(services), { authMode: 'strict' })

  for (const name of ['generate_image', 'edit_image']) {
    assert.equal(
      registrations.some(tool => tool.definition.name === name),
      false,
      `${name} must execute in Rust, not through a Node host override`
    )
  }
})

test('Rust-advertised Electron domain tools use Node overrides while plan controls stay native', async () => {
  const services = createServices({
    mcpService: {
      async executeServerTool () { return {} }
    },
    settingsStore: { getProviders: () => ({ providers: [], activeProviderId: '', enabledProviderIds: [] }) },
    imageLibraryStore: {},
    enqueueStudioImageTasks: () => {}
  })
  const nativeNames = [
    'write_project_file',
    'write_workspace_file',
    'generate_image',
    'mcp_call'
  ]
  const registrations = await collectHostTools(createHarnessEngine(services, nativeNames), {
    authMode: 'strict',
    workspaceRoot: process.cwd()
  })

  for (const name of ['write_project_file', 'write_workspace_file', 'generate_image', 'mcp_call']) {
    const registration = getTool(registrations, name)
    assert.equal(registration.domain, 'electron_host_override', `${name} must use the exact Electron handler`)
  }
  for (const name of ['enter_plan_mode', 'exit_plan_mode']) {
    assert.equal(registrations.some(tool => tool.definition.name === name), false, `${name} must remain Rust-native`)
  }
})

test('canonical Node catalog excludes Rust-intrinsic plan controls and Rust-native image tools', () => {
  const registry = new ElectronToolRegistry({
    services: createServices(),
    getNativeToolDefinitions: () => []
  })
  const definitions = registry.getToolDefinitions()
  const registrations = registry.createRegistrations({})

  // enter/exit_plan_mode are Rust-intrinsic and generate/edit_image are
  // Rust-native (`electron_native`): the model-facing schemas come from the
  // Rust catalog and no Node handler may exist for them.
  for (const name of ['enter_plan_mode', 'exit_plan_mode', 'generate_image', 'edit_image']) {
    assert.equal(definitions.some(tool => tool.name === name), false, `${name} must be owned by Rust, not the Node catalog`)
    assert.equal(registrations.some(tool => tool.definition.name === name), false, `${name} must not register a Node handler`)
  }
})

test('electronNative tools keep their Rust schema and cannot be shadowed by host registrations', async () => {
  const nativeTool = {
    name: 'write_project_file',
    description: 'Rust-native write implementation',
    inputSchema: {
      type: 'object',
      properties: {
        rust_only_value: { type: 'string' }
      },
      required: ['rust_only_value']
    },
    electronNative: true
  }
  const engine = createHarnessEngine(createServices(), [nativeTool])
  const visible = engine.getAvailableTools().find(tool => tool.name === nativeTool.name)

  assert.ok(visible)
  assert.equal(visible.description, nativeTool.description)
  assert.deepEqual(visible.parameters, nativeTool.inputSchema)
  assert.equal(visible.electronNative, true)

  const registrations = await collectHostTools(engine, {
    customTools: [{
      domain: 'electron_host_override',
      definition: {
        name: nativeTool.name,
        description: 'Caller override that must be ignored',
        parameters: { type: 'object' }
      },
      handler: async () => ({ source: 'node' })
    }]
  })
  assert.equal(
    registrations.some(tool => tool.definition.name === nativeTool.name),
    false,
    'an explicit Rust ownership declaration must suppress placeholders, legacy handlers, and custom overrides'
  )
})

test('new electronNative tools need no frozen Node registry entry', async () => {
  const nativeTool = {
    name: 'new_rust_native_feature',
    description: 'A feature implemented entirely in Rust',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    },
    electronNative: true
  }
  const engine = createHarnessEngine(createServices(), [nativeTool])

  assert.deepEqual(
    engine.getAvailableTools().find(tool => tool.name === nativeTool.name),
    {
      name: nativeTool.name,
      description: nativeTool.description,
      parameters: nativeTool.inputSchema,
      electronNative: true
    }
  )
  const registrations = await collectHostTools(engine)
  assert.equal(registrations.some(tool => tool.definition.name === nativeTool.name), false)
})

test('all canonical Electron tools have an explicit execution owner', async () => {
  const services = createServices({
    documentStore: {},
    skillStore: {},
    agentStore: {},
    agentGroupStore: {},
    settingsStore: {},
    readActivePage: async () => ({
      title: '',
      url: '',
      textPreview: '',
      fullTextAvailable: false,
      interactiveElements: [],
      formFields: []
    }),
    interactWithActivePage: async () => ({ ok: true, type: 'wait', timeoutMs: 0 }),
    mcpService: new MCPService(),
    scheduledTaskService: {}
  })
  const catalog = new ElectronToolRegistry({
    services,
    getNativeToolDefinitions: () => [],
    runSubagents: async () => []
  }).getToolDefinitions()
  const canonicalNames = catalog.map(tool => tool.name).sort()
  assert.equal(canonicalNames.length, 8)
  assert.equal(new Set(canonicalNames).size, 8)
  // Rust-intrinsic plan controls and Rust-native image/workspace/project-file
  // tools never appear in the Node canonical catalog; Rust advertises and
  // executes them itself.
  for (const name of [
    'enter_plan_mode',
    'exit_plan_mode',
    'generate_image',
    'edit_image',
    'list_workspace_files',
    'read_workspace_file',
    'write_workspace_file',
    'edit_workspace_file',
    'patch_workspace_file',
    'delete_workspace_file',
    'glob_workspace',
    'grep_workspace',
    'read_project_file',
    'write_project_file',
    'edit_project_file',
    'patch_project_file',
    'delete_project_file',
    'list_project_files',
    'glob_search',
    'grep_search',
    'run_shell_command',
    'get_command_status',
    'query_project_database',
    'analyze_project_data',
    'create_project',
    'list_projects',
    'start_project_server',
    'restart_project_server',
    'get_project_status',
    'get_project_logs',
    'rebuild_project',
    'finalize_project',
    'clear_project_build_flag',
    'call_project_api',
    'create_agent',
    'create_agent_group',
    'list_agent_workspace_catalog',
    'run_skill',
    'list_skills',
    'install_skill',
    'manage_todo_list',
    'spawn_subagents',
    'web_search',
    'fetch_webpage',
    'mcp_call',
    'mcp_list_servers',
    'mcp_list_resources',
    'mcp_read_resource',
    'mcp_list_prompts',
    'mcp_get_prompt',
    'install_mcp_server',
    'local_read_file',
    'local_run_command',
    'local_write_file',
    'create_scheduled_task',
    'list_scheduled_tasks',
    'start_async_task',
    'get_task_status',
    'read_document',
    'list_documents'
  ]) {
    assert.equal(canonicalNames.includes(name), false, `${name} must be Rust-owned and absent from the Node catalog`)
  }

  const registrations = await collectHostTools(
    createHarnessEngine(services, canonicalNames),
    { authMode: 'auto', workspaceRoot: process.cwd() }
  )
  const hostNames = registrations
    .filter(tool => tool.domain === 'electron_host_override')
    .map(tool => tool.definition.name)
    .sort()

  assert.deepEqual(hostNames, canonicalNames)
})

test('missing optional Electron services remain explicit host errors instead of Rust fallbacks', async () => {
  // This is intentionally the smallest service set.  Rust still advertises
  // the canonical Electron catalog, but a headless/partially initialized
  // Electron process must not accidentally execute a different Rust
  // implementation for a host-owned tool.
  const services = createServices()
  const contract = JSON.parse(await fs.readFile(
    path.resolve(process.cwd(), '../../harness-rs/crates/tools/electron-tool-contracts.json'),
    'utf8'
  ))
  const canonicalNames = contract.tools.map(tool => tool.name)
  const registrations = await collectHostTools(
    createHarnessEngine(services, canonicalNames),
    { authMode: 'auto' }
  )
  const hostNames = new Set(
    registrations
      .filter(tool => tool.domain === 'electron_host_override')
      .map(tool => tool.definition.name)
  )

  for (const name of canonicalNames) {
    assert.equal(hostNames.has(name), true, `${name} must retain an explicit Electron owner`)
  }

  for (const name of [
    'read_current_page'
  ]) {
    const { result } = await dispatchToolExecute(registrations, name, {})
    assert.deepEqual(result, {
      error: `Electron host service unavailable for ${name}`
    })
  }
})

test('MCP discovery/resource/prompt tools are Rust-native and register no Node override', async () => {
  const mcpService = new MCPService()
  const names = [
    'mcp_list_servers',
    'mcp_list_resources',
    'mcp_read_resource',
    'mcp_list_prompts',
    'mcp_get_prompt',
    'mcp_call',
    'install_mcp_server'
  ]
  const registrations = await collectHostTools(
    createHarnessEngine(createServices({ mcpService }), names.map(name => ({
      name, description: `Rust ${name}`, inputSchema: { type: 'object' }, electronNative: true
    }))),
    { authMode: 'strict' }
  )

  for (const name of names) {
    assert.equal(
      registrations.some(tool => tool.definition.name === name),
      false,
      `${name} must execute in Rust, not through a Node host override`
    )
  }
})

test('project command tools are Rust-native and register no Node override', async () => {
  // The merged run_shell_command / get_command_status pair executes in
  // Rust (`electron_native`) with the same output caps and
  // timeout-to-background semantics the Electron registry used to own.
  const services = createServices()
  const registrations = await collectHostTools(
    createHarnessEngine(services, [
      { name: 'run_project_command', description: 'Rust run_project_command', inputSchema: { type: 'object' }, electronNative: true },
      { name: 'get_project_command_status', description: 'Rust get_project_command_status', inputSchema: { type: 'object' }, electronNative: true }
    ]),
    { authMode: 'auto' }
  )

  for (const name of [
    'run_shell_command',
    'get_command_status'
  ]) {
    assert.equal(
      registrations.some(tool => tool.definition.name === name),
      false,
      `${name} must execute in Rust, not through a Node host override`
    )
  }
})

test('spawn_subagents is Rust-native and registers no Node override', async () => {
  // The harness's own subagent runtime owns child runs, nesting limits, and
  // parent cancellation; the facade must not register a Node shim.
  const client = createNativeToolClient([
    { name: 'spawn_subagents', description: 'Rust spawn_subagents', inputSchema: { type: 'object' }, electronNative: true }
  ])
  const engine = new RustHarnessEngine({ client, services: createServices() })
  const registrations = await collectHostTools(engine)

  assert.equal(
    registrations.some(tool => tool.definition.name === 'spawn_subagents'),
    false,
    'spawn_subagents must execute in Rust, not through a Node host override'
  )
})


test('Rust-advertised Electron document and page tools use host overrides', async () => {
  const services = createServices({
    documentStore: {
      listSummaries: () => [],
      getAllSelections: () => [],
      getArtifact: () => null,
      getArtifactChunks: () => null,
      buildSelectionRefs: () => []
    },
    getMainWindow: () => null,
    readActivePage: async () => ({ title: '', url: '', textPreview: '', fullTextAvailable: false, interactiveElements: [], formFields: [] }),
    interactWithActivePage: async () => ({ ok: true, type: 'wait', timeoutMs: 0 })
  })
  const names = [
    'ask_user',
    'read_current_page',
    'interact_current_page',
    'fill_current_page_form',
    'save_current_page_as_document',
    'list_documents',
    'read_document',
    'open_project_app'
  ]
  const registrations = await collectHostTools(createHarnessEngine(services, names), {
    authMode: 'strict',
    workspaceRoot: process.cwd()
  })
  for (const name of names) {
    const registration = getTool(registrations, name)
    assert.equal(registration.domain, 'electron_host_override', `${name} must use the Electron host implementation`)
  }
})

test('native Rust dynamic MCP results notify the Electron bridge', async () => {
  const nativeResults = []
  const client = createNativeToolClient(['mcp__docs__lookup__abc123'])
  const engine = new RustHarnessEngine({
    client,
    services: createServices(),
    onNativeToolResult: async (name, result) => nativeResults.push({ name, result })
  })

  await engine.handleNativeToolResult({
    kind: 'tool_result',
    name: 'mcp__docs__lookup__abc123',
    content: '{"ok":true,"content":[{"type":"text","text":"done"}]}'
  })

  assert.deepEqual(nativeResults, [
    { name: 'mcp__docs__lookup__abc123', result: { ok: true, content: [{ type: 'text', text: 'done' }] } }
  ])
})

test('plan mode keeps mutating tools visible in the Rust run policy', async () => {
  const captured = []
  const client = {
    ...createNativeToolClient(),
    async start () {},
    async chatStream (_sessionId, _conversationId, _text, options, onFrame) {
      captured.push({ options })
      onFrame({ kind: 'assistant_message', content: '已给出计划' })
      onFrame({ kind: 'done' })
      return { streamId: 'plan-visible-stream' }
    }
  }
  const engine = new RustHarnessEngine({ client, services: createServices() })
  engine.setPlanMode(true)

  for await (const _event of engine.chatStream([
    { role: 'user', content: '先规划再建项目' }
  ])) {}

  assert.equal(captured.length, 1)
  // Blocking belongs to Rust's execution boundary. Filtering the visible
  // catalog froze the tool list per run and made the model believe it lacked
  // create_project, so it redirected the user to a manual UI flow.
  assert.deepEqual(captured[0].options.deniedToolNames, [])
  assert.equal(captured[0].options.planModeActive, true)
})

test('native exit_plan_mode result clears the engine plan default and notifies the shell', async () => {
  const events = []
  const client = {
    ...createNativeToolClient(),
    async start () {},
    async chatStream (_sessionId, _conversationId, _text, _options, onFrame) {
      onFrame({
        kind: 'tool_result',
        name: 'exit_plan_mode',
        content: '{"success":true,"planning":false,"plan_summary":"7 步方案","steps":[]}'
      })
      onFrame({ kind: 'assistant_message', content: '开始执行' })
      onFrame({ kind: 'done' })
      return { streamId: 'plan-exit-stream' }
    }
  }
  const engine = new RustHarnessEngine({
    client,
    services: createServices(),
    onPlanModeChanged: (active) => events.push(active)
  })
  engine.setPlanMode(true)

  for await (const _event of engine.chatStream([
    { role: 'user', content: '按计划执行' }
  ])) {}

  assert.equal(engine.getPlanMode(), false)
  assert.deepEqual(events, [false])
})

test('planModeExitedAfterNativeResult only accepts successful exits', () => {
  assert.equal(planModeExitedAfterNativeResult('exit_plan_mode', { success: true, planning: false }), true)
  assert.equal(
    planModeExitedAfterNativeResult('exit_plan_mode', { success: false, planning: false, message: '当前不在规划模式中。' }),
    false
  )
  assert.equal(planModeExitedAfterNativeResult('enter_plan_mode', { planning: true }), false)
  assert.equal(planModeExitedAfterNativeResult('exit_plan_mode', null), false)
  assert.equal(planModeExitedAfterNativeResult('exit_plan_mode', 'not-an-object'), false)
})

test('Rust Studio client replays image events published before its RPC response is mapped', async () => {
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-studio-test'),
    onEvent: () => {}
  })
  client.start = async () => {}
  client.syncSettings = async () => {}
  client.request = async (method, params) => {
    assert.equal(method, 'studio.generate')
    assert.equal(params.size, '1536x1024')
    queueMicrotask(() => {
      client.handleEvent({
        streamId: 'studio-stream-1',
        seq: 1,
        ts: new Date().toISOString(),
        kind: 'image_ready',
        entry: { id: 'native-image', file: 'native-image.png' }
      })
      client.handleEvent({
        streamId: 'studio-stream-1',
        seq: 2,
        ts: new Date().toISOString(),
        kind: 'done'
      })
    })
    return { streamId: 'studio-stream-1' }
  }

  const result = await client.studioGenerate({ prompt: 'A native studio test', size: '1536x1024' })

  assert.deepEqual(result, {
    streamId: 'studio-stream-1',
    entries: [{ id: 'native-image', file: 'native-image.png' }]
  })
  assert.equal(client.hasSession('studio-stream-1'), false)
})

test('Rust client answers direct document host requests without a session mapping', async () => {
  const hostRequests = []
  const responses = []
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-direct-document-host-test'),
    onEvent: () => {},
    onHostRequest: async request => {
      hostRequests.push(request)
      return { success: true, supported: true }
    }
  })
  client.start = async () => {}
  client.respondHost = async (requestId, result) => {
    responses.push({ requestId, result })
  }

  // Direct document/workbench RPCs do not have the chat session mapping that
  // tool.execute requests use. They must still be dispatched to the Electron
  // host callback immediately instead of being parked in the replay backlog.
  client.handleEvent({
    streamId: 'document-open-direct',
    seq: 0,
    ts: new Date().toISOString(),
    kind: 'host_request',
    requestId: 'document-open-direct-request',
    requestKind: 'document.openOriginal',
    payload: {
      artifactId: 'artifact-1',
      filePath: '/tmp/report.docx'
    }
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(hostRequests, [{
    requestId: 'document-open-direct-request',
    requestKind: 'document.openOriginal',
    payload: {
      artifactId: 'artifact-1',
      filePath: '/tmp/report.docx'
    },
    streamId: 'document-open-direct'
  }])
  assert.deepEqual(responses, [{
    requestId: 'document-open-direct-request',
    result: { success: true, supported: true }
  }])
  assert.equal(client.backlog.has('document-open-direct'), false)
})

test('Rust native group keeps its Electron session through child completion and releases only at group completion', async () => {
  const calls = []
  const events = []
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-native-group-test'),
    onEvent: () => {}
  })
  client.start = async () => {}
  client.syncSettings = async () => {}
  client.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'group.create') {
      return { id: 'native-group-1', topic: params.topic, board: {} }
    }
    if (method === 'group.message') {
      queueMicrotask(() => {
        client.handleEvent({
          streamId: 'native-group-1:member:reviewer:child-1',
          seq: 1,
          ts: new Date().toISOString(),
          kind: 'assistant_message',
          content: 'Member note'
        })
        client.handleEvent({
          streamId: 'native-group-1:member:reviewer:child-1',
          seq: 2,
          ts: new Date().toISOString(),
          kind: 'done',
          stopReason: 'stop'
        })
      })
      return { streamId: 'native-group-1', round: 1 }
    }
    if (method === 'group.inject') return { queued: 1 }
    throw new Error(`Unexpected method: ${method}`)
  }

  const group = await client.createNativeGroup({
    topic: 'Review the implementation',
    mode: 'discussion',
    coordinator: 'Coordinator',
    members: [
      { name: 'Coordinator', persona: 'Coordinate', agentId: 'coordinator' },
      { name: 'Reviewer', persona: 'Review', agentId: 'reviewer' }
    ]
  })
  assert.equal(group.id, 'native-group-1')

  await client.startNativeGroupRound({
    sessionId: 'electron-group-session',
    groupId: group.id,
    text: 'Review the implementation',
    memberIds: ['reviewer'],
    authMode: 'auto',
    onEvent: frame => events.push(frame)
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(client.hasSession('electron-group-session'), true, 'child done must not release the group mapping')
  assert.equal(client.getNativeGroupId('electron-group-session'), 'native-group-1')
  assert.equal(events[0].streamId, 'native-group-1', 'child frames are routed to the parent group stream')
  assert.equal(events[1].kind, 'done')

  await client.injectNativeGroup('electron-group-session', 'native-group-1', 'Prioritize security findings', ['reviewer'])
  assert.deepEqual(calls.at(-1), {
    method: 'group.inject',
    params: {
      id: 'native-group-1',
      content: 'Prioritize security findings',
      targetAgentIds: ['reviewer']
    }
  })

  client.handleEvent({
    streamId: 'native-group-1',
    seq: 3,
    ts: new Date().toISOString(),
    kind: 'group_message',
    member: 'Reviewer',
    round: 1,
    content: 'Member note'
  })
  client.handleEvent({
    streamId: 'native-group-1',
    seq: 4,
    ts: new Date().toISOString(),
    kind: 'done',
    stopReason: 'group_complete'
  })

  assert.equal(client.hasSession('electron-group-session'), false)
  assert.equal(client.getNativeGroupId('electron-group-session'), null)
  assert.deepEqual(calls.map(call => call.method), ['group.create', 'group.message', 'group.inject'])
})

test('Rust native group routes stateful Electron tools by original member stream', async () => {
  const calls = []
  const responses = []
  const progress = []
  const factoryCalls = []
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-native-group-tools-test'),
    onEvent: () => {}
  })
  client.start = async () => {}
  client.syncSettings = async () => {}
  client.request = async (method, params) => {
    calls.push({ method, params })
    assert.equal(method, 'group.message')
    return { streamId: 'native-group-tools', round: 1 }
  }
  client.respondHost = async (requestId, result) => {
    responses.push({ requestId, result })
  }

  const definition = {
    name: 'stateful_group_tool',
    description: 'Verify isolated member state',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false
    }
  }
  const registrationFor = streamId => {
    let invocationCount = 0
    return {
      definition,
      domain: 'electron_host_override',
      permission: 'allow',
      async handler (args, onProgress) {
        invocationCount++
        onProgress?.('member-tool', `${streamId}:${invocationCount}`)
        return { streamId, invocationCount, value: args.value }
      }
    }
  }
  const customToolsForStream = streamId => {
    factoryCalls.push(streamId)
    return [registrationFor(streamId)]
  }

  await client.startNativeGroupRound({
    sessionId: 'electron-group-tools-session',
    groupId: 'native-group-tools',
    text: 'Exercise the host tool',
    context: {
      customTools: [registrationFor('catalog-only')],
      memoryScopes: [{ scopeType: 'group', scopeId: 'logical-group' }],
      memoryQuery: 'Exercise the host tool'
    },
    customToolsForStream,
    onEvent: frame => progress.push(frame)
  })

  assert.deepEqual(calls[0].params.context.customTools, [{
    name: definition.name,
    description: definition.description,
    inputSchema: definition.parameters,
    domain: 'electron_host_override',
    permission: 'allow'
  }])
  assert.deepEqual(calls[0].params.context.memoryScopes, [{ scopeType: 'group', scopeId: 'logical-group' }])
  assert.equal(calls[0].params.context.memoryQuery, 'Exercise the host tool')

  const childOne = 'native-group-tools:member:reviewer:child-1'
  const childTwo = 'native-group-tools:member:writer:child-2'
  const emitTool = (requestId, streamId, value) => client.handleEvent({
    streamId,
    seq: 1,
    ts: new Date().toISOString(),
    kind: 'host_request',
    requestId,
    requestKind: 'tool.execute',
    payload: { name: definition.name, args: { value } }
  })
  emitTool('child-one-first', childOne, 'a')
  emitTool('child-one-second', childOne, 'b')
  emitTool('child-two-first', childTwo, 'c')
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(factoryCalls, [childOne, childTwo])
  assert.deepEqual(responses.sort((left, right) => left.requestId.localeCompare(right.requestId)), [
    {
      requestId: 'child-one-first',
      result: { streamId: childOne, invocationCount: 1, value: 'a' }
    },
    {
      requestId: 'child-one-second',
      result: { streamId: childOne, invocationCount: 2, value: 'b' }
    },
    {
      requestId: 'child-two-first',
      result: { streamId: childTwo, invocationCount: 1, value: 'c' }
    }
  ])
  const toolProgress = progress.filter(frame => frame.kind === 'progress')
  assert.equal(toolProgress.length, 3)
  assert.ok(toolProgress.every(frame => frame.streamId === 'native-group-tools'))
  assert.deepEqual(toolProgress.map(frame => frame.groupMemberStreamId), [childOne, childOne, childTwo])

  client.handleEvent({
    streamId: childOne,
    seq: 2,
    ts: new Date().toISOString(),
    kind: 'done',
    stopReason: 'stop'
  })
  assert.equal(client.nativeGroupMemberTools.has(childOne), false)
  assert.equal(client.nativeGroupMemberTools.has(childTwo), true)

  client.handleEvent({
    streamId: 'native-group-tools',
    seq: 3,
    ts: new Date().toISOString(),
    kind: 'done',
    stopReason: 'group_complete'
  })
  assert.equal(client.nativeGroupToolFactories.has('electron-group-tools-session'), false)
  assert.equal(client.nativeGroupMemberTools.size, 0)
  assert.equal(client.nativeGroupMemberStreams.size, 0)
})

test('Rust MCP ownership enforces the per-run server allow-list natively', async () => {
  // mcp_call is Rust-native: ensure_server_allowed enforces the run's
  // allowedMcpServerIds narrowing before any network traffic, replacing the
  // Node PermissionEngine gate the shim used to provide.
  const mcpService = { async executeServerTool () { throw new Error('must not be called') } }
  const services = createServices({ mcpService })
  const context = { authMode: 'strict', allowedMcpServerIds: ['docs-server'] }
  const registrations = await collectHostTools(createHarnessEngine(services), context)

  assert.equal(
    registrations.some(tool => tool.definition.name === 'mcp_call'),
    false,
    'mcp_call must execute in Rust, not through a Node host override'
  )
})

test('Rust-native dynamic MCP permission requests are answered through the Electron client', async () => {
  const permissionRequests = []
  const responses = []
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-native-mcp-permission-test'),
    onEvent: () => {},
    onPermissionRequest: async request => {
      permissionRequests.push(request)
      return false
    }
  })
  client.callRunning = async (method, params) => {
    responses.push({ method, params })
    return { delivered: true }
  }

  client.sessionAuthModes.set('strict-session', 'strict')
  await client.handlePermissionRequest({
    kind: 'permission_request',
    requestId: 'strict-mcp-request',
    toolName: 'mcp__docs__lookup__abc123',
    argsSummary: 'docs-server.lookup'
  }, 'strict-session')

  client.sessionAuthModes.set('auto-session', 'auto')
  await client.handlePermissionRequest({
    kind: 'permission_request',
    requestId: 'auto-mcp-request',
    toolName: 'mcp__docs__lookup__abc123',
    argsSummary: 'docs-server.lookup'
  }, 'auto-session')

  assert.deepEqual(permissionRequests, [{
    requestId: 'strict-mcp-request',
    toolName: 'mcp__docs__lookup__abc123',
    argsSummary: 'docs-server.lookup',
    sessionId: 'strict-session'
  }])
  assert.deepEqual(responses, [
    { method: 'chat.respond', params: { requestId: 'strict-mcp-request', allow: false } },
    { method: 'chat.respond', params: { requestId: 'auto-mcp-request', allow: true } }
  ])
})

test('late host and permission replies cannot restart an exited Rust harness', async () => {
  let releasePermission
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-late-callback-test'),
    onEvent: () => {},
    onPermissionRequest: async () => await new Promise(resolve => {
      releasePermission = resolve
    })
  })
  let startCalls = 0
  let requestCalls = 0
  client.start = async () => { startCalls++ }
  client.request = async () => {
    requestCalls++
    return { delivered: true }
  }
  client.sessionAuthModes.set('late-session', 'strict')

  const permissionReply = client.handlePermissionRequest({
    kind: 'permission_request',
    requestId: 'late-permission-request',
    toolName: 'mcp_call',
    argsSummary: 'docs-server.lookup'
  }, 'late-session')
  client.handleExit(new Error('test harness exited'))
  releasePermission(true)
  await permissionReply

  await assert.rejects(
    client.respondHost('late-host-request', { ok: true }),
    /Rust harness is not running/
  )
  assert.equal(startCalls, 0)
  assert.equal(requestCalls, 0)
})

test('Rust MCP settings control plane stays on the Rust transport', async () => {
  const calls = []
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-mcp-control-test'),
    getMcpServers: () => [{
      id: 'docs-server',
      name: 'Docs server',
      enabled: true,
      transport: 'streamable-http',
      command: '',
      args: [],
      cwd: '',
      env: {},
      url: 'https://mcp.example.test',
      headers: { Authorization: 'Bearer test' },
      timeoutMs: 20_000
    }],
    onEvent: () => {}
  })
  client.start = async () => {}
  client.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'mcp.status') {
      return { servers: [], updatedAt: '2026-08-30T00:00:00Z' }
    }
    if (method === 'mcp.refresh') {
      return { id: 'docs-server', status: 'connected' }
    }
    if (method === 'mcp.disconnect') {
      return { id: 'docs-server', status: 'disconnected' }
    }
    return { servers: ['docs-server'] }
  }

  await client.syncMcpServers()
  const state = await client.getMcpState()
  const refreshed = await client.refreshMcpServer('docs-server')
  const disconnected = await client.disconnectMcpServer('docs-server')

  assert.deepEqual(state, { servers: [], updatedAt: '2026-08-30T00:00:00Z' })
  assert.deepEqual(refreshed, { id: 'docs-server', status: 'connected' })
  assert.deepEqual(disconnected, { id: 'docs-server', status: 'disconnected' })
  assert.deepEqual(calls, [
    {
      method: 'mcp.reload',
      params: {
        servers: [{
          name: 'docs-server',
          displayName: 'Docs server',
          enabled: true,
          transport: 'streamable-http',
          target: 'https://mcp.example.test',
          args: [],
          cwd: null,
          env: {},
          headers: { Authorization: 'Bearer test' },
          timeoutMs: 20_000
        }]
      }
    },
    { method: 'mcp.status', params: {} },
    { method: 'mcp.refresh', params: { serverId: 'docs-server' } },
    { method: 'mcp.disconnect', params: { serverId: 'docs-server' } }
  ])
})

test('Rust JSON-RPC transport sanitizes lone UTF-16 surrogates at every depth', async () => {
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-unicode-test'),
    onEvent: () => {}
  })
  const writes = []
  client.child = {
    stdin: {
      writable: true,
      write (message, callback) {
        writes.push(message)
        callback?.()
        const request = JSON.parse(message)
        queueMicrotask(() => client.handleLine(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { ok: true }
        })))
      }
    }
  }

  const loneHigh = String.fromCharCode(0xD800)
  const loneLow = String.fromCharCode(0xDC00)
  const badKey = `key-${loneHigh}`
  await client.request('test.unicode', {
    text: `before${loneHigh}after`,
    nested: { [badKey]: [`low-${loneLow}`, 'valid-\uD83D\uDE00'] }
  })

  const request = JSON.parse(writes[0])
  assert.equal(request.params.text, 'before\uFFFDafter')
  assert.deepEqual(request.params.nested['key-\uFFFD'], ['low-\uFFFD', 'valid-\uD83D\uDE00'])
  assert.equal(writes[0].includes('\\ud800'), false)
  assert.equal(writes[0].includes('\\udc00'), false)
})

test('Rust JSON-RPC uncorrelated protocol errors reject pending requests immediately', async () => {
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-rpc-error-test'),
    onEvent: () => {}
  })
  client.child = {
    stdin: {
      writable: true,
      write (_message, callback) {
        callback?.()
        queueMicrotask(() => client.handleLine(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'invalid json' }
        })))
      }
    }
  }

  await assert.rejects(
    client.request('chat.send', { text: 'test' }),
    /uncorrelated JSON-RPC request \(-32700\): invalid json/
  )
  assert.equal(client.pending.size, 0)
})

test('Rust chat preserves provider thinking defaults and omits reasoning only when explicitly disabled', async () => {
  const captured = []
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-reasoning-test'),
    onEvent: () => {}
  })
  client.start = async () => {}
  client.syncSettings = async () => {}
  client.ensureConversation = async () => {}
  client.request = async (method, params) => {
    assert.equal(method, 'chat.send')
    captured.push(params)
    return { streamId: `stream-${captured.length}` }
  }

  await client.chatStream('session-default', 'conversation-default', 'hello', {
    reasoningEffort: 'max'
  })
  await client.chatStream('session-off', 'conversation-off', 'hello', {
    enableThinking: false,
    reasoningEffort: 'max'
  })
  await client.chatStream('session-on', 'conversation-on', 'hello', {
    enableThinking: true,
    reasoningEffort: 'high'
  })

  assert.equal(Object.hasOwn(captured[0], 'enableThinking'), false)
  assert.equal(captured[0].reasoningEffort, 'max')
  assert.equal(captured[1].enableThinking, false)
  assert.equal(Object.hasOwn(captured[1], 'reasoningEffort'), false)
  assert.equal(captured[2].enableThinking, true)
  assert.equal(captured[2].reasoningEffort, 'high')
})

test('Rust chat forwards the coding mode gate to chat.send', async () => {
  const captured = []
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-coding-mode-test'),
    onEvent: () => {}
  })
  client.start = async () => {}
  client.syncSettings = async () => {}
  client.ensureConversation = async () => {}
  client.request = async (method, params) => {
    assert.equal(method, 'chat.send')
    captured.push(params)
    return { streamId: `coding-stream-${captured.length}` }
  }

  await client.chatStream('session-coding', 'conversation-coding', 'edit the app', {
    codingMode: true,
    targetProjectId: 'project-1'
  })
  await client.chatStream('session-coding-off', 'conversation-coding-off', 'answer a question', {
    codingMode: false,
    targetProjectId: 'project-1'
  })

  assert.equal(captured[0].codingMode, true)
  assert.equal(captured[1].codingMode, false)
})

test('Rust facade enables coding mode by default for project runs and supports opt-out', async () => {
  const captured = []
  const client = {
    ...createNativeToolClient(),
    async start () {},
    async chatStream (_sessionId, _conversationId, _text, options, onFrame) {
      captured.push(options)
      onFrame({ kind: 'assistant_message', content: 'ok' })
      onFrame({ kind: 'done' })
      return { streamId: `coding-engine-${captured.length}` }
    }
  }
  const engine = new RustHarnessEngine({ client, services: createServices() })
  engine.setTargetProjectId('project-1')

  for await (const _event of engine.chatStream([
    { role: 'user', content: 'edit the app' }
  ], undefined, {})) {}
  for await (const _event of engine.chatStream([
    { role: 'user', content: 'just answer' }
  ], undefined, { codingMode: false })) {}

  assert.equal(captured[0].codingMode, true)
  assert.equal(captured[0].targetProjectId, 'project-1')
  assert.equal(captured[1].codingMode, false)
})

test('Rust facade forwards scoped semantic-memory settings to chat.send', async () => {
  const captured = []
  const client = {
    ...createNativeToolClient(),
    async start () {},
    async chatStream (sessionId, conversationId, text, options, onFrame) {
      captured.push({ sessionId, conversationId, text, options })
      onFrame({ kind: 'assistant_message', content: '苹果' })
      onFrame({ kind: 'done' })
      return { streamId: 'memory-recall-stream' }
    }
  }
  const engine = new RustHarnessEngine({ client, services: createServices() })
  const memoryEmbedding = {
    providerId: 'provider-memory',
    baseUrl: 'https://embedding.example/v1',
    apiKey: 'test-key',
    modelId: 'embedding-model',
    dimensions: 1024,
    distance: 'cosine'
  }

  for await (const _event of engine.chatStream([
    { role: 'user', content: '我喜欢吃什么' }
  ], undefined, {
    memoryScopes: [{ scopeType: 'user', scopeId: 'local-user' }],
    memoryEmbedding
  })) {}

  assert.equal(captured.length, 1)
  assert.deepEqual(captured[0].options.memoryScopes, [{ scopeType: 'user', scopeId: 'local-user' }])
  assert.equal(captured[0].options.memoryQuery, '我喜欢吃什么')
  assert.deepEqual(captured[0].options.memoryEmbedding, memoryEmbedding)
})

test('Electron provider sync preserves saved temperature and thinking defaults', async () => {
  const calls = []
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-provider-sync-test'),
    getProviders: () => ({
      providers: [
        {
          id: 'provider-1',
          name: 'Compatible provider',
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'secret',
          apiProtocol: 'openai-chat',
          models: ['model-1'],
          activeModel: 'model-1',
          temperature: 0.65,
          enableThinking: true,
          modelCapabilities: {},
          modelContextWindows: {}
        },
        {
          id: 'provider-auto-detected',
          name: 'Auto with probe result',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'secret',
          apiProtocol: '',
          detectedApiProtocol: 'anthropic',
          models: ['claude'],
          activeModel: 'claude',
          modelCapabilities: {},
          modelContextWindows: {}
        },
        {
          id: 'provider-auto-unpinned',
          name: 'Auto without probe result',
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'secret',
          apiProtocol: '',
          models: ['model-1'],
          activeModel: 'model-1',
          modelCapabilities: {},
          modelContextWindows: {}
        }
      ],
      activeProviderId: 'provider-1'
    }),
    onEvent: () => {}
  })
  client.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'provider.list') return { providers: { providers: [] } }
    return {}
  }

  await client.syncProviderSettings()

  const saved = calls.find(call => call.method === 'provider.save')
  assert.ok(saved)
  assert.equal(saved.params.provider.temperature, 0.65)
  assert.equal(saved.params.provider.enableThinking, true)

  // The harness always receives a concrete wire protocol: explicit values
  // pass through, auto entries carry their probe result, and unpinned auto
  // entries fall back to chat/completions.
  const savedById = new Map(calls
    .filter(call => call.method === 'provider.save')
    .map(call => [call.params.provider.id, call.params.provider.apiProtocol]))
  assert.equal(savedById.get('provider-1'), 'openai-chat')
  assert.equal(savedById.get('provider-auto-detected'), 'anthropic')
  assert.equal(savedById.get('provider-auto-unpinned'), 'openai-chat')
})

test('Rust facade promotes historical system and developer messages into run-scoped system sections', async () => {
  const runs = []
  const client = {
    ...createNativeToolClient(),
    async chatStream (sessionId, conversationId, text, options, onFrame) {
      runs.push({ sessionId, conversationId, text, options })
      onFrame({ kind: 'assistant_message', content: 'done' })
      onFrame({ kind: 'done' })
      return { streamId: 'system-history-stream' }
    },
    setModelPricing () {}
  }
  const engine = new RustHarnessEngine({ client, services: createServices() })

  for await (const _event of engine.chatStream([
    { role: 'system', content: 'System policy' },
    { role: 'developer', content: 'Developer policy' },
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Current question' }
  ])) {}

  assert.equal(runs.length, 1)
  assert.deepEqual(runs[0].options.systemPromptSections, ['System policy', 'Developer policy'])
  assert.deepEqual(runs[0].options.history, [
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' }
  ])
})

test('Rust facade preserves assistant image parts in the completed message', async () => {
  const parts = [
    { type: 'text', text: 'generated' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }
  ]
  const client = {
    ...createNativeToolClient(),
    async chatStream (_sessionId, _conversationId, _text, _options, onFrame) {
      onFrame({ kind: 'assistant_message', content: 'generated', parts })
      onFrame({ kind: 'done', stopReason: 'stop' })
      return { streamId: 'image-output-stream' }
    },
    setModelPricing () {}
  }
  const engine = new RustHarnessEngine({ client, services: createServices() })
  const events = []

  for await (const event of engine.chatStream([
    { role: 'user', content: 'draw an image' }
  ])) {
    events.push(event)
  }

  const done = events.find(event => event.type === 'done')
  assert.ok(done)
  assert.deepEqual(done.message.content, parts)
})

test('Rust facade forwards reset frames as the Node stream reset event', async () => {
  const client = {
    ...createNativeToolClient(),
    async chatStream (_sessionId, _conversationId, _text, _options, onFrame) {
      onFrame({ kind: 'assistant_message', content: 'before' })
      onFrame({ kind: 'delta', text: 'partial' })
      onFrame({ kind: 'reset' })
      onFrame({ kind: 'delta', text: 'retry' })
      onFrame({ kind: 'done', stopReason: 'stop' })
      return { streamId: 'reset-stream' }
    },
    setModelPricing () {}
  }
  const engine = new RustHarnessEngine({ client, services: createServices() })
  const events = []

  for await (const event of engine.chatStream([{ role: 'user', content: 'retry this' }])) {
    events.push(event)
  }

  assert.deepEqual(events.map(event => event.type), ['token', 'reset', 'token', 'done'])
  assert.equal(events.at(-1).message.content, 'beforeretry')
})

test('Rust history sync keeps only exactly paired tool calls and does not duplicate result text', async () => {
  const calls = []
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-history-test'),
    onEvent: () => {}
  })
  client.call = async (method, params) => {
    calls.push({ method, params })
    return {}
  }

  await client.syncConversationHistory('conversation-history', [
    { role: 'tool', tool_call_id: 'orphan', content: 'must be removed' },
    {
      role: 'assistant',
      content: 'Running the tool.',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]
    },
    { role: 'tool', tool_call_id: 'call-1', content: '{"text":"ok"}' },
    {
      role: 'assistant',
      content: 'Keep this explanation despite damaged metadata.',
      tool_calls: [{ id: 'call-bad', type: 'function', function: { name: 'read_file', arguments: '{not-json}' } }]
    },
    { role: 'tool', tool_call_id: 'call-bad', content: 'must be removed with damaged metadata' },
    {
      role: 'assistant',
      content: 'Incomplete tool batch.',
      tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'read_file', arguments: '{}' } }]
    },
    { role: 'user', content: 'Continue.' }
  ])

  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'conversation.sync')
  assert.equal(calls[0].params.authoritative, true)
  assert.deepEqual(calls[0].params.messages, [
    {
      role: 'assistant',
      content: 'Running the tool.',
      parts: [{ type: 'text', text: 'Running the tool.' }],
      toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.txt' } }],
      toolResults: []
    },
    {
      role: 'user',
      content: '',
      parts: [],
      toolCalls: [],
      toolResults: [{ toolCallId: 'call-1', name: '', content: '{"text":"ok"}', isError: false }]
    },
    {
      role: 'assistant',
      content: 'Keep this explanation despite damaged metadata.',
      parts: [{ type: 'text', text: 'Keep this explanation despite damaged metadata.' }],
      toolCalls: [],
      toolResults: []
    },
    {
      role: 'user',
      content: 'Continue.',
      parts: [{ type: 'text', text: 'Continue.' }],
      toolCalls: [],
      toolResults: []
    }
  ])
})

test('Rust history sync sends an explicit authoritative empty reset', async () => {
  const calls = []
  const client = new RustHarnessClient({
    workspace: process.cwd(),
    dataDir: path.join(os.tmpdir(), 'worldbase-rust-history-reset-test'),
    onEvent: () => {}
  })
  client.call = async (method, params) => {
    calls.push({ method, params })
    return {}
  }

  await client.syncConversationHistory('conversation-reset', [])

  assert.deepEqual(calls, [{
    method: 'conversation.sync',
    params: {
      id: 'conversation-reset',
      authoritative: true,
      messages: []
    }
  }])
})

test('memory selection synchronizes once, propagates disable, and exposes real index status', async () => {
  const calls = []
  let config = { providerId: 'memory-p', modelId: 'embedding', baseUrl: 'https://example.invalid/v1', apiKey: 'test' }
  const client = new RustHarnessClient({ workspace: process.cwd(), dataDir: path.join(os.tmpdir(), 'memory-settings-test'), onEvent () {}, getMemoryEmbedding: () => config })
  client.start = async () => {}
  client.request = async (method, params) => {
    calls.push({ method, params })
    return method === 'memory.indexStatus' ? { state: 'waiting', documents: { total: 140, indexed: 0, queued: 140, failed: 0 } } : { configured: !!params.config }
  }
  await client.syncMemoryEmbeddingSettings()
  await client.syncMemoryEmbeddingSettings()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { method: 'memory.configureEmbedding', params: { config } })
  const status = await client.getMemoryIndexStatus()
  assert.equal(status.state, 'waiting')
  assert.equal(status.documents.indexed, 0)
  config = undefined
  await client.syncMemoryEmbeddingSettings()
  assert.deepEqual(calls.at(-1), { method: 'memory.configureEmbedding', params: { config: null } })
})

test('memory embedding config survives both facade and actual chat.send serialization', async () => {
  const captured = []
  const client = new RustHarnessClient({ workspace: process.cwd(), dataDir: path.join(os.tmpdir(), 'memory-wire-test'), onEvent () {} })
  client.start = async () => {}
  client.syncSettings = async () => {}
  client.ensureConversation = async () => {}
  client.syncConversationHistory = async () => {}
  client.request = async (method, params) => {
    assert.equal(method, 'chat.send')
    captured.push(params)
    return { streamId: `memory-wire-${captured.length}` }
  }
  const send = client.chatStream.bind(client)
  client.chatStream = async (...args) => {
    const result = await send(...args)
    client.handleEvent({ streamId: result.streamId, kind: 'assistant_message', content: '苹果', seq: 1 })
    client.handleEvent({ streamId: result.streamId, kind: 'done', seq: 2 })
    return result
  }
  const engine = new RustHarnessEngine({ client, services: createServices() })
  const memoryEmbedding = { providerId: 'memory-p', modelId: 'embedding', baseUrl: 'https://example.invalid/v1', apiKey: 'test', queryPrefix: 'query: ', documentPrefix: '' }
  await engine.chat([{ role: 'user', content: '我喜欢吃什么？' }], { memoryScopes: [{ scopeType: 'user', scopeId: 'local-user' }], memoryEmbedding })
  assert.deepEqual(captured[0].memoryEmbedding, memoryEmbedding)
  assert.equal(captured[0].memoryQuery, '我喜欢吃什么？')
  assert.deepEqual(captured[0].memoryScopes, [{ scopeType: 'user', scopeId: 'local-user' }])
  await engine.chat([{ role: 'user', content: 'hi' }], {})
  assert.equal(Object.hasOwn(captured[1], 'memoryEmbedding'), false)
})

test('disabling memory while a chat is preparing cannot re-enable a stale embedding snapshot', async () => {
  let payload
  const stale = { providerId: 'old', modelId: 'embedding', baseUrl: 'https://example.invalid', apiKey: 'test' }
  const client = new RustHarnessClient({ workspace: process.cwd(), dataDir: os.tmpdir(), onEvent () {}, getMemoryEmbedding: () => undefined })
  client.start = async () => {}
  client.syncSettings = async () => {}
  client.ensureConversation = async () => {}
  client.request = async (_method, params) => { payload = params; return { streamId: 'disabled-memory' } }
  await client.chatStream('disabled-session', 'disabled-conversation', 'hello', { memoryEmbedding: stale })
  assert.equal(Object.hasOwn(payload, 'memoryEmbedding'), false)
})

test('web tool results re-emit as rich web_search_result stream events', () => {
  const payload = {
    query: 'electron webview automation',
    engine: 'bing + duckduckgo',
    results: [
      { rank: 1, title: 'Electron docs', url: 'https://www.electronjs.org/docs', snippet: 'webview tag', source: 'bing' },
      { rank: 2, title: 'Example', url: 'https://example.com/', snippet: 'example', source: 'duckduckgo', published_at: '2026-01-01T00:00:00Z' }
    ],
    fetched_at: '2026-01-01T00:00:00Z'
  }
  const events = webToolResultEvents('web_search', JSON.stringify(payload))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'web_search_result')
  assert.equal(events[0].query, 'electron webview automation')
  assert.equal(events[0].results.length, 2)
  assert.equal(events[0].results[1].published_at, '2026-01-01T00:00:00Z')

  // Blocked classification still flows through the card payload untouched.
  const blocked = webToolResultEvents('web_search', JSON.stringify({
    query: 'q', engine: 'bing', results: [], access: 'blocked', access_detail: { reason: 'search_sources_failed' }
  }))
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].results.length, 0)
})

test('web fetch and batch fetch results re-emit as web_fetch_result events', () => {
  const entry = {
    url: 'https://example.com/docs', final_url: 'https://example.com/docs/', ok: false, status: 403,
    content: 'denied', truncated: false, fetched_at: '2026-01-01T00:00:00Z',
    access: 'blocked', access_detail: { reason: 'http_blocked' },
    fallback: { suggested_tools: ['open_workspace_tab', 'read_current_page'], hint: 'use the browser' }
  }
  const single = webToolResultEvents('web_fetch', JSON.stringify(entry))
  assert.equal(single.length, 1)
  assert.equal(single[0].type, 'web_fetch_result')
  assert.equal(single[0].result.access, 'blocked')
  assert.equal(single[0].result.fallback.hint, 'use the browser')

  const batch = webToolResultEvents('fetch_webpage', JSON.stringify({ query: 'q', results: [entry, entry], success_count: 0, failure_count: 2 }))
  assert.equal(batch.length, 2)
  assert.equal(batch[0].query, 'q')

  // Unrecognized shapes degrade to no rich events, not renderer errors.
  assert.deepEqual(webToolResultEvents('web_fetch', 'upstream exploded'), [])
  assert.deepEqual(webToolResultEvents('read_file', JSON.stringify({ content: 'x' })), [])
  assert.deepEqual(webToolResultEvents('fetch_webpage', JSON.stringify({ results: ['nope'] })), [])
})

test('write tool results re-emit as file_preview events with absolute paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-preview-root-'))
  const harnessWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'file-preview-harness-'))
  try {
    await fs.mkdir(path.join(root, 'reports'), { recursive: true })
    await fs.writeFile(path.join(root, 'reports', 'report.md'), '# hi')
    await fs.writeFile(path.join(harnessWorkspace, 'notes.json'), '{}')
    await fs.mkdir(path.join(harnessWorkspace, 'alpha', 'docs'), { recursive: true })
    await fs.writeFile(path.join(harnessWorkspace, 'alpha', 'docs', 'report.md'), 'x')

    // Folder workspace write: the result path resolves against context.workspaceRoot.
    const folderWrite = fileWritePreviewEvents(
      'write_workspace_file',
      JSON.stringify({ success: true, file_path: 'reports/report.md', bytes_written: 4 }),
      { workspaceRoot: root },
      harnessWorkspace
    )
    assert.equal(folderWrite.length, 2)
    assert.equal(folderWrite[0].type, 'file_preview_start')
    assert.equal(folderWrite[0].filePath, path.join(root, 'reports', 'report.md'))
    assert.equal(folderWrite[1].type, 'file_preview_end')
    assert.equal(folderWrite[1].filePath, folderWrite[0].filePath)

    // Harness workspace write: write_file paths live under the harness root,
    // so the folder-root candidate is skipped when the file is not there.
    const harnessWrite = fileWritePreviewEvents(
      'write_file',
      JSON.stringify({ path: 'notes.json', bytes_written: 2 }),
      { workspaceRoot: root },
      harnessWorkspace
    )
    assert.equal(harnessWrite[0].filePath, path.join(harnessWorkspace, 'notes.json'))

    // Project writes take the project root from the tool_call args.
    const projectWrite = fileWritePreviewEvents(
      'write_project_file',
      JSON.stringify({ success: true, file_path: 'docs/report.md' }),
      {},
      harnessWorkspace,
      { project_id: 'alpha' }
    )
    assert.equal(projectWrite[0].filePath, path.join(harnessWorkspace, 'alpha', 'docs', 'report.md'))

    // local_write_file returns an absolute path already.
    const local = fileWritePreviewEvents(
      'local_write_file',
      JSON.stringify({ success: true, file_path: path.join(root, 'notes.xlsx') }),
      {},
      harnessWorkspace
    )
    assert.equal(local[0].filePath, path.join(root, 'notes.xlsx'))

    // Non-write tools, payloads without a path, and undecodable content stay
    // silent so unknown shapes degrade to plain tool runs.
    assert.deepEqual(fileWritePreviewEvents('read_file', JSON.stringify({ path: 'a.md' }), {}, harnessWorkspace), [])
    assert.deepEqual(fileWritePreviewEvents('write_file', JSON.stringify({ bytes_written: 3 }), {}, harnessWorkspace), [])
    assert.deepEqual(fileWritePreviewEvents('doc_write', 'not json', {}, harnessWorkspace), [])
    assert.deepEqual(fileWritePreviewEvents('delete_workspace_file', JSON.stringify({ file_path: 'x' }), {}, harnessWorkspace), [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(harnessWorkspace, { recursive: true, force: true })
  }
})

test('coding tool results map into status and diff stream events', () => {
  const failedVerify = codingEventsForToolResult(
    'coding_verify',
    JSON.stringify({
      passed: false,
      outcomes: [{
        kind: 'typecheck',
        program: 'pnpm',
        args: ['run', 'typecheck'],
        exitCode: 2,
        timedOut: false,
        cancelled: false,
        durationMs: 1200,
        stderr: 'src/main.ts(12,7): error TS2304: Cannot find name x.'
      }],
      diagnostics: [{
        severity: 'error',
        message: "Cannot find name 'x'.",
        code: 'TS2304',
        file: 'src/main.ts',
        line: 12,
        column: 7,
        confidence: 0.95
      }]
    }),
    null,
    null
  )
  assert.equal(failedVerify.status.phase, 'diagnose')
  assert.equal(failedVerify.status.verificationAttempts, 1)
  assert.equal(failedVerify.status.diagnostics[0].code, 'TS2304')
  assert.equal(failedVerify.status.commands[0].exitCode, 2)
  assert.equal(failedVerify.status.stopReason, 'verificationFailed')

  const diagnose = codingEventsForToolResult(
    'coding_diagnose',
    JSON.stringify({
      diagnosis: {
        summary: '1 error(s), 0 warning(s)',
        matches: [{ patternId: 'ts-2304', fixHint: 'Declare the identifier.', files: ['src/main.ts'], confidence: 0.95 }],
        repairInstructions: ['Declare the identifier.']
      },
      dependency: {
        issues: [{ kind: 'missingPackage', package: 'zod', message: "Cannot find module 'zod'.", suggestedFix: { command: 'pnpm add zod' } }]
      },
      repair: { shouldRetry: true, instructions: ['Declare the identifier.'] }
    }),
    failedVerify.status,
    null
  )
  assert.equal(diagnose.status.phase, 'repair')
  assert.equal(diagnose.status.dependencyIssues[0].command, 'pnpm add zod')
  assert.deepEqual(diagnose.status.repairInstructions, ['Declare the identifier.'])

  const edit = codingEventsForToolResult(
    'coding_edit',
    JSON.stringify({
      changed: true,
      operation: 'replace',
      filePath: 'src/main.ts',
      byteRange: { start: 10, end: 20 },
      before: 'const x = 1;',
      after: 'const x = 2;'
    }),
    diagnose.status,
    null
  )
  assert.equal(edit.status.phase, 'edit')
  assert.deepEqual(edit.status.changedFiles, ['src/main.ts'])
  assert.equal(edit.diff.files[0].changes[0].before, 'const x = 1;')
  assert.equal(edit.diff.files[0].changes[0].after, 'const x = 2;')

  const apply = codingEventsForToolResult(
    'coding_apply',
    JSON.stringify({
      applied: true,
      results: [{
        filePath: 'src/a.ts',
        operationCount: 2,
        changes: [
          { operation: 'replace', before: 'a', after: 'b' },
          { operation: 'rename', before: 'foo', after: 'bar' }
        ]
      }]
    }),
    edit.status,
    edit.diff
  )
  assert.equal(apply.status.changedFiles.length, 2)
  assert.equal(apply.diff.files[0].filePath, 'src/main.ts')
  assert.equal(apply.diff.files[1].filePath, 'src/a.ts')
  assert.equal(apply.diff.files[1].changes.length, 2)
})

test('renderer stream contract maps coding status and diff field names', () => {
  const status = { phase: 'edit' }
  const diff = { files: [], updatedAt: 1 }
  assert.deepEqual(toRendererStreamEvent({ type: 'coding_status', status }), {
    type: 'coding_status',
    codingStatus: status
  })
  assert.deepEqual(toRendererStreamEvent({ type: 'coding_diff', diff }), {
    type: 'coding_diff',
    codingDiff: diff
  })
  const token = { type: 'token', content: 'hello' }
  assert.equal(toRendererStreamEvent(token), token)
})

test('AI-selected and implicit coding actions activate coding mode', () => {
  assert.equal(shouldActivateCodingMode('select_work_mode', { mode: 'coding' }), true)
  assert.equal(shouldActivateCodingMode('select_work_mode', { mode: 'document' }), false)
  assert.equal(shouldActivateCodingMode('select_work_mode', { mode: 'chat' }), false)
  assert.equal(shouldActivateCodingMode('create_project', {}), true)
  assert.equal(shouldActivateCodingMode('coding_verify', {}), true)
  assert.equal(shouldActivateCodingMode('write_project_file', { file_path: 'src/main.ts' }), false)
  assert.equal(shouldActivateCodingMode('write_workspace_file', { path: 'src/App.vue' }), false)
  assert.equal(shouldActivateCodingMode('doc_draft', { file_path: 'docs/report.docx' }), false)
})

test('generic code writes map into coding status and diff', () => {
  const written = codingEventsForGenericFileResult(
    'write_workspace_file',
    JSON.stringify({
      success: true,
      file_path: 'src/main.ts',
      before_content: '',
      after_content: 'const a = 1;\n',
      content_truncated: false
    }),
    null,
    null
  )
  assert.equal(written.status.phase, 'edit')
  assert.deepEqual(written.status.changedFiles, ['src/main.ts'])
  assert.deepEqual(written.diff.files[0], {
    filePath: 'src/main.ts',
    operationCount: 1,
    changes: [{ operation: 'write', before: '', after: 'const a = 1;\n' }]
  })

  const truncated = codingEventsForGenericFileResult(
    'patch_workspace_file',
    JSON.stringify({
      success: true,
      file_path: 'src/large.ts',
      content_truncated: true
    }),
    written.status,
    written.diff
  )
  assert.equal(truncated.status.phase, 'edit')
  assert.deepEqual(truncated.status.changedFiles, ['src/main.ts', 'src/large.ts'])
  assert.equal(truncated.diff, null)

  const read = codingEventsForGenericFileResult(
    'read_workspace_file',
    JSON.stringify({ file_path: 'src/main.ts', before_content: 'a', after_content: 'b' }),
    null,
    null
  )
  assert.equal(read.status, null)
  assert.equal(read.diff, null)
})

test('select_work_mode activates coding events for a following generic write', async () => {
  const client = {
    ...createNativeToolClient([{
      name: 'select_work_mode',
      description: 'Select work mode',
      inputSchema: { type: 'object' },
      electronNative: true
    }, {
      name: 'write_project_file',
      description: 'Write a project file',
      inputSchema: { type: 'object' },
      electronNative: true
    }]),
    async chatStream (_sessionId, _conversationId, _text, _options, onFrame) {
      onFrame({ kind: 'tool_call', name: 'select_work_mode', call_id: 'mode-1', args: { mode: 'coding' } })
      onFrame({
        kind: 'tool_result',
        name: 'select_work_mode',
        call_id: 'mode-1',
        content: JSON.stringify({ mode: 'coding', coding: true, acknowledged: true })
      })
      onFrame({ kind: 'tool_call', name: 'write_project_file', call_id: 'write-1', args: { file_path: 'src/main.ts' } })
      onFrame({
        kind: 'tool_result',
        name: 'write_project_file',
        call_id: 'write-1',
        content: JSON.stringify({
          success: true,
          file_path: 'src/main.ts',
          before_content: 'const a = 1;\n',
          after_content: 'const a = 2;\n',
          content_truncated: false
        })
      })
      onFrame({ kind: 'done', stopReason: 'completed' })
      return { streamId: 'mode-activation-stream' }
    }
  }
  const engine = new RustHarnessEngine({ client, services: createServices() })
  const events = []
  for await (const event of engine.chatStream([{ role: 'user', content: 'create an app' }])) {
    events.push(event)
  }

  const statuses = events.filter(event => event.type === 'coding_status').map(event => event.status)
  const diffs = events.filter(event => event.type === 'coding_diff').map(event => event.diff)
  assert.ok(statuses.length >= 1)
  assert.equal(statuses[0].phase, 'plan')
  assert.equal(statuses.at(-1).phase, 'edit')
  assert.deepEqual(statuses.at(-1).changedFiles, ['src/main.ts'])
  assert.equal(diffs.at(-1).files[0].filePath, 'src/main.ts')
  assert.equal(diffs.at(-1).files[0].changes[0].before, 'const a = 1;\n')
  assert.equal(diffs.at(-1).files[0].changes[0].after, 'const a = 2;\n')
})

test('cancelled coding runs map to a blocked cancelled status stream event', async () => {
  const client = {
    ...createNativeToolClient([{
      name: 'coding_verify',
      description: 'Rust coding_verify',
      inputSchema: { type: 'object' },
      electronNative: true
    }]),
    async chatStream (_sessionId, _conversationId, _text, _options, onFrame) {
      onFrame({ kind: 'tool_call', name: 'coding_verify', call_id: 'verify-1', args: {} })
      onFrame({
        kind: 'tool_result',
        name: 'coding_verify',
        call_id: 'verify-1',
        content: JSON.stringify({
          passed: false,
          diagnostics: [{
            severity: 'error',
            message: "Cannot find name 'x'.",
            code: 'TS2304',
            file: 'src/main.ts',
            line: 12,
            column: 7,
            confidence: 0.95
          }]
        })
      })
      onFrame({ kind: 'done', stopReason: 'aborted' })
      return { streamId: 'coding-abort-stream' }
    }
  }
  const engine = new RustHarnessEngine({ client, services: createServices() })
  const events = []

  await assert.rejects(async () => {
    for await (const event of engine.chatStream([{ role: 'user', content: 'fix the project' }])) {
      events.push(event)
    }
  }, /stopped by user/i)

  const statuses = events.filter(event => event.type === 'coding_status').map(event => event.status)
  assert.equal(statuses.length, 3)
  assert.equal(statuses.at(-1).phase, 'blocked')
  assert.equal(statuses.at(-1).stopReason, 'cancelled')
  assert.equal(statuses.at(-1).verificationAttempts, 1)
  assert.equal(statuses.at(-1).diagnostics[0].code, 'TS2304')
})

test('cancelled coding status keeps completed and blocked runs terminal', () => {
  const active = {
    phase: 'repair',
    repairRound: 1,
    verificationAttempts: 1,
    changedFiles: ['src/main.ts'],
    commands: [],
    diagnostics: [],
    dependencyIssues: [],
    repairInstructions: [],
    updatedAt: 1
  }
  const cancelled = codingStatusForCancelledRun(active)
  assert.equal(cancelled.phase, 'blocked')
  assert.equal(cancelled.stopReason, 'cancelled')
  assert.deepEqual(cancelled.changedFiles, ['src/main.ts'])

  const complete = { ...active, phase: 'complete', stopReason: 'verificationPassed' }
  assert.equal(codingStatusForCancelledRun(complete), complete)

  const blocked = { ...active, phase: 'blocked', stopReason: 'maxRepairRounds' }
  assert.equal(codingStatusForCancelledRun(blocked), blocked)
  assert.equal(codingStatusForCancelledRun(null), null)
})

test('coding persistence serializes status and diff with legacy tolerance', () => {
  const status = {
    phase: 'repair',
    repairRound: 1,
    maxRepairRounds: 3,
    verificationAttempts: 2,
    changedFiles: ['src/main.ts'],
    commands: [{
      kind: 'typecheck',
      program: 'pnpm',
      args: ['run', 'typecheck'],
      exitCode: 2,
      timedOut: false,
      cancelled: false,
      durationMs: 1200,
      stderr: 'TS2304'
    }],
    diagnostics: [{
      severity: 'error',
      message: "Cannot find name 'x'.",
      code: 'TS2304',
      file: 'src/main.ts',
      line: 12,
      column: 7,
      confidence: 0.95
    }],
    dependencyIssues: [],
    repairInstructions: ['Import x.'],
    stopReason: 'verificationFailed',
    updatedAt: 10
  }
  const diff = {
    files: [{
      filePath: 'src/main.ts',
      operationCount: 1,
      changes: [{ operation: 'edit', before: 'const a = 1', after: 'const a = 2' }]
    }],
    updatedAt: 11
  }

  const raw = encodeCodingState({ status, diff })
  assert.ok(raw)
  const decoded = decodeCodingState(raw)
  assert.deepEqual(decoded.status, status)
  assert.deepEqual(decoded.diff, diff)

  const legacy = decodeCodingState(JSON.stringify(status))
  assert.equal(legacy.status.phase, 'repair')
  assert.equal(legacy.diff, null)

  assert.deepEqual(decodeCodingState('{not json'), { status: null, diff: null })
  assert.deepEqual(decodeCodingState(JSON.stringify({ phase: 'unknown' })), { status: null, diff: null })
})

test('coding persistence caps oversized diffs and keeps the newest files', () => {
  const diff = {
    files: [
      {
        filePath: 'src/old.ts',
        operationCount: 1,
        changes: [{ operation: 'edit', before: 'x'.repeat(180000), after: 'y'.repeat(180000) }]
      },
      {
        filePath: 'src/new.ts',
        operationCount: 1,
        changes: [{ operation: 'edit', before: 'a', after: 'b' }]
      }
    ],
    updatedAt: 12
  }

  const raw = encodeCodingState({ status: null, diff })
  assert.ok(raw)
  const decoded = decodeCodingState(raw)
  assert.ok(decoded.diff)
  assert.equal(decoded.diff.files.length, 1)
  assert.equal(decoded.diff.files[0].filePath, 'src/new.ts')
  assert.ok(Buffer.byteLength(JSON.stringify(decoded.diff), 'utf8') <= MAX_CODING_DIFF_BYTES)
})

test('coding persistence keys localStorage by conversation and clears it', () => {
  const data = new Map()
  const previousWindow = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => { data.set(key, String(value)) },
      removeItem: (key) => { data.delete(key) }
    }
  }

  try {
    const status = {
      phase: 'complete',
      repairRound: 0,
      verificationAttempts: 1,
      changedFiles: [],
      commands: [],
      diagnostics: [],
      dependencyIssues: [],
      repairInstructions: [],
      stopReason: 'verificationPassed',
      updatedAt: 20
    }
    saveCodingStateNow('conv-a', { status, diff: null })
    assert.ok(data.has(codingStateStorageKey('conv-a')))
    assert.ok(data.has(`${CODING_STATE_STORAGE_PREFIX}conv-a`))
    assert.equal(loadCodingState('conv-a').status.phase, 'complete')
    assert.equal(loadCodingState('conv-b').status, null)

    clearCodingState('conv-a')
    assert.equal(loadCodingState('conv-a').status, null)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
