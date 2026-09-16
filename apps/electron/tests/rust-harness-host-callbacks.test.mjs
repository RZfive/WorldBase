import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { RustHarnessEngine } from '../src/main/ai-harness/rust-harness-engine.ts'
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

test('Rust tool.execute falls back to the Electron project handler when Rust does not advertise it', async () => {
  const writes = []
  const services = createServices({
    projectFS: {
      async readFile (projectId, filePath) {
        assert.equal(projectId, 'project-alpha')
        assert.equal(filePath, 'src/main.ts')
        return 'const previous = true\n'
      },
      async writeFile (...args) {
        writes.push(args)
      },
      async listProjects () { return [] }
    }
  })
  const registrations = await collectHostTools(createHarnessEngine(services), { authMode: 'strict' })
  const projectTool = getTool(registrations, 'write_project_file')

  assert.equal(projectTool.domain, 'electron_host_override')
  const { result, progress } = await dispatchToolExecute(registrations, 'write_project_file', {
    project_id: 'project-alpha',
    file_path: 'src/main.ts',
    content: 'export const fromRust = true\n'
  })

  assert.deepEqual(writes, [[
    'project-alpha',
    'src/main.ts',
    'export const fromRust = true\n'
  ]])
  assert.deepEqual(result, {
    success: true,
    file_path: 'src/main.ts',
    message: 'File src/main.ts written successfully'
  })
  assert.ok(progress.some(frame => frame.kind === 'progress' && frame.stage === '__electron_progress__'))
})

test('Rust tool.execute falls back to the selected Electron folder workspace when needed', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'worldbase-rust-workspace-'))
  const workspaceChanges = []
  try {
    const services = createServices({
      notifyFolderWorkspaceChanged: event => workspaceChanges.push(event)
    })
    const registrations = await collectHostTools(createHarnessEngine(services), {
      authMode: 'strict',
      workspaceRoot
    })
    const workspaceTool = getTool(registrations, 'write_workspace_file')

    assert.equal(workspaceTool.domain, 'electron_host_override')
    const { result } = await dispatchToolExecute(registrations, 'write_workspace_file', {
      file_path: 'notes/from-rust.md',
      content: '# Rust host callback\n'
    })

    assert.deepEqual(result, { success: true, file_path: 'notes/from-rust.md' })
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'notes/from-rust.md'), 'utf8'), '# Rust host callback\n')
    assert.deepEqual(workspaceChanges, [{
      action: 'created',
      rootPath: path.resolve(workspaceRoot),
      filePath: 'notes/from-rust.md'
    }])
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('Rust tool.execute falls back to Electron Studio image services when needed', async () => {
  const imageBatches = []
  const services = createServices({
    settingsStore: {
      getProviders: () => ({
        providers: [{
          id: 'image-provider',
          name: 'Image Provider',
          apiKey: 'test-key',
          baseUrl: 'https://images.example.test/v1',
          models: ['image-model'],
          activeModel: 'image-model',
          modelCapabilities: { 'image-model': { imageGeneration: true } }
        }],
        activeProviderId: 'image-provider',
        enabledProviderIds: ['image-provider']
      })
    },
    imageLibraryStore: {},
    enqueueStudioImageTasks: requests => imageBatches.push(requests)
  })
  const registrations = await collectHostTools(createHarnessEngine(services), { authMode: 'strict' })
  const imageTool = getTool(registrations, 'generate_image')

  assert.equal(imageTool.domain, 'electron_host_override')
  const { result } = await dispatchToolExecute(registrations, 'generate_image', {
    tasks: [{
      prompt: 'A red lantern over a rainy city',
      aspect_ratio: '1:1',
      resolution: '1K',
      n: 2,
      folder: 'rust-runs',
      tags: ['host-callback']
    }]
  })

  assert.equal(result.ok, true)
  assert.equal(result.queued, 1)
  assert.deepEqual(imageBatches, [[{
    providerId: 'image-provider',
    model: 'image-model',
    mode: 'generate',
    prompt: 'A red lantern over a rainy city',
    negativePrompt: undefined,
    aspectRatio: '1:1',
    size: '1024x1024',
    quality: 'high',
    outputFormat: 'png',
    n: 2,
    folder: 'rust-runs',
    tags: ['host-callback']
  }]])
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

test('canonical discovery includes intrinsic plan schemas without registering Node plan handlers', () => {
  const registry = new ElectronToolRegistry({
    services: createServices(),
    getNativeToolDefinitions: () => []
  })
  const definitions = registry.getToolDefinitions()
  const registrations = registry.createRegistrations({})

  for (const name of ['enter_plan_mode', 'exit_plan_mode']) {
    const definition = definitions.find(tool => tool.name === name)
    assert.ok(definition, `${name} must be part of the canonical contract catalog`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(registrations.some(tool => tool.definition.name === name), false)
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

test('all 68 canonical Electron tools have an explicit execution owner', async () => {
  const services = createServices({
    documentStore: {},
    skillStore: {},
    agentStore: {},
    agentGroupStore: {},
    settingsStore: {},
    imageLibraryStore: {},
    enqueueStudioImageTasks: () => {},
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
  assert.equal(canonicalNames.length, 68)
  assert.equal(new Set(canonicalNames).size, 68)

  const registrations = await collectHostTools(
    createHarnessEngine(services, canonicalNames),
    { authMode: 'auto', workspaceRoot: process.cwd() }
  )
  const hostNames = registrations
    .filter(tool => tool.domain === 'electron_host_override')
    .map(tool => tool.definition.name)
    .sort()
  const nativeNames = ['enter_plan_mode', 'exit_plan_mode']
  const expectedHostNames = canonicalNames.filter(name => !nativeNames.includes(name))

  assert.deepEqual(hostNames, expectedHostNames)
  assert.deepEqual(canonicalNames.filter(name => !hostNames.includes(name)), nativeNames)
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

  for (const name of canonicalNames.filter(name => !['enter_plan_mode', 'exit_plan_mode'].includes(name))) {
    assert.equal(hostNames.has(name), true, `${name} must retain an explicit Electron owner`)
  }

  for (const name of [
    'list_documents',
    'read_document',
    'read_current_page',
    'generate_image',
    'list_workspace_files'
  ]) {
    const { result } = await dispatchToolExecute(registrations, name, {})
    assert.deepEqual(result, {
      error: `Electron host service unavailable for ${name}`
    })
  }
})

test('fixed MCP discovery and resource tools execute through the Node MCP service', async () => {
  const mcpService = new MCPService()
  const names = [
    'mcp_list_servers',
    'mcp_list_resources',
    'mcp_read_resource',
    'mcp_list_prompts',
    'mcp_get_prompt'
  ]
  const registrations = await collectHostTools(
    createHarnessEngine(createServices({ mcpService }), names),
    { authMode: 'strict' }
  )

  for (const name of names) {
    assert.equal(getTool(registrations, name).domain, 'electron_host_override')
  }
  const { result } = await dispatchToolExecute(registrations, 'mcp_list_servers', {})
  assert.deepEqual(result.servers, [])
  assert.equal(typeof result.updatedAt, 'string')
})

test('a server installed during a Rust turn is immediately available to generic mcp_call', async () => {
  let savedServers = []
  let activeServers = []
  const calls = []
  const mcpService = {
    async updateServers (servers) {
      activeServers = servers
    },
    async refreshServer (serverId) {
      const server = activeServers.find(candidate => candidate.id === serverId)
      assert.ok(server, 'installed server must be active before refresh')
      return { id: server.id, name: server.name, status: 'connected' }
    },
    async executeServerTool (...args) {
      calls.push(args)
      return { source: 'same-turn-mcp' }
    }
  }
  const services = createServices({
    settingsStore: {
      getMcpServers: () => savedServers,
      saveMcpServers: servers => { savedServers = servers }
    },
    mcpService,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send () {} }
    })
  })
  const context = {
    authMode: 'auto',
    allowedMcpServerIds: ['mcp_docs']
  }
  const registrations = await collectHostTools(
    createHarnessEngine(services, ['install_mcp_server', 'mcp_call']),
    context
  )

  assert.equal(getTool(registrations, 'install_mcp_server').domain, 'electron_host_override')
  assert.equal(getTool(registrations, 'mcp_call').domain, 'electron_host_override')

  const installed = await dispatchToolExecute(registrations, 'install_mcp_server', {
    name: 'Docs',
    transport: 'streamable-http',
    url: 'https://mcp.example.test'
  })
  assert.equal(installed.result.success, true)
  assert.equal(installed.result.server.id, 'mcp_docs')

  const called = await dispatchToolExecute(registrations, 'mcp_call', {
    server: 'mcp_docs',
    tool: 'lookup',
    arguments: { query: 'new server' }
  })
  assert.equal(called.result.source, 'same-turn-mcp')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'mcp_docs')
  assert.equal(calls[0][1], 'lookup')
  assert.deepEqual(calls[0][2], { query: 'new server' })
  assert.deepEqual(calls[0][4], ['mcp_docs'])
})

test('Rust project command callbacks share the exact Electron command status registry', async () => {
  const projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldbase-rust-command-'))
  try {
    await fs.mkdir(path.join(projectsDir, 'project-alpha'))
    const services = createServices({
      projectFS: {
        projectsDir,
        async readFile () { return '' },
        async writeFile () {},
        async listProjects () { return [] }
      },
      builderService: {
        async syncManualBuildState () { return { synced: true } }
      }
    })
    const registrations = await collectHostTools(
      createHarnessEngine(services, ['run_project_command', 'get_project_command_status']),
      { authMode: 'auto' }
    )

    for (const name of ['run_project_command', 'get_project_command_status']) {
      assert.equal(getTool(registrations, name).domain, 'electron_host_override')
    }
    const started = await dispatchToolExecute(registrations, 'run_project_command', {
      project_id: 'project-alpha',
      command: 'node -e "process.stdout.write(\'node-exact-command\')"',
      timeout_seconds: 5
    })
    assert.equal(started.result.status, 'completed')
    assert.equal(started.result.exitCode, 0)
    assert.equal(started.result.stdout, 'node-exact-command')

    const polled = await dispatchToolExecute(registrations, 'get_project_command_status', {
      command_id: started.result.command_id
    })
    assert.equal(polled.result.command_id, started.result.command_id)
    assert.equal(polled.result.status, 'completed')
    assert.equal(polled.result.stdout, 'node-exact-command')
  } finally {
    await fs.rm(projectsDir, { recursive: true, force: true })
  }
})

test('Rust-advertised spawn_subagents is always executed by the Electron Rust facade', async () => {
  const childRuns = []
  const client = {
    ...createNativeToolClient(['spawn_subagents']),
    async chatStream (sessionId, conversationId, text, options, onFrame) {
      childRuns.push({ sessionId, conversationId, text, options })
      onFrame({ kind: 'assistant_message', content: 'Child result' })
      onFrame({ kind: 'done' })
      return { streamId: `child-stream-${childRuns.length}` }
    }
  }
  const engine = new RustHarnessEngine({ client, services: createServices() })
  const context = { authMode: 'auto', sessionId: 'parent-session', conversationId: 'parent-conversation' }
  const registrations = await collectHostTools(engine, context)
  const subagents = getTool(registrations, 'spawn_subagents')

  assert.equal(subagents.domain, 'electron_host_override')
  const { result } = await dispatchToolExecute(registrations, 'spawn_subagents', {
    tasks: [{
      description: 'Review routing',
      prompt: 'Review the Rust routing boundary.',
      allowed_tools: ['read_project_file'],
      system_prompt: 'Focus on native ownership.'
    }]
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.completed_count, 1)
  assert.equal(result.results[0].result, 'Child result')
  assert.equal(childRuns.length, 1)
  assert.deepEqual(childRuns[0].options.allowedToolNames, ['read_project_file'])
  assert.ok(childRuns[0].options.systemPromptSections.includes('Focus on native ownership.'))
  assert.match(childRuns[0].options.systemPromptSections.join('\n'), /nesting depth 1/)

  const limitRegistrations = await collectHostTools(engine, {
    ...context,
    subagentNestingDepth: 2
  })
  const atLimit = getTool(limitRegistrations, 'spawn_subagents')
  assert.equal(atLimit.domain, 'electron_host_override')
  const limited = await dispatchToolExecute(limitRegistrations, 'spawn_subagents', {
    tasks: [{ description: 'Blocked child', prompt: 'This must not start.' }]
  })

  assert.equal(limited.result.status, 'completed_with_failures')
  assert.match(limited.result.results[0].error, /nesting limit/i)
  assert.equal(childRuns.length, 1, 'the facade must reject at the limit before creating a Rust child run')
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

test('Rust MCP ownership routes generic calls through Electron while dynamic callbacks retain permission routing', async () => {
  const genericCalls = []
  const dynamicCalls = []
  const dynamicDefinition = {
    name: 'mcp__docs__lookup__abc123',
    description: 'Look up documentation',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  }
  const mcpService = {
    async executeServerTool (...args) {
      genericCalls.push(args)
      return { source: 'generic-mcp', args }
    },
    async executeDynamicTool (...args) {
      dynamicCalls.push(args)
      return { source: 'dynamic-mcp', args }
    }
  }

  const deniedServices = createServices({ mcpService })
  const deniedContext = {
    authMode: 'strict',
    allowedMcpServerIds: ['docs-server']
  }
  const deniedRegistry = new ElectronToolRegistry({
    services: deniedServices,
    getNativeToolDefinitions: () => []
  })
  const deniedRegistrations = [
    ...await collectHostTools(createHarnessEngine(deniedServices), deniedContext),
    deniedRegistry.createExternalRegistration(deniedContext, {
      definition: dynamicDefinition,
      handler: async (args, onProgress) => await mcpService.executeDynamicTool(
        dynamicDefinition.name,
        args,
        onProgress,
        deniedContext.allowedMcpServerIds
      )
    })
  ]
  assert.equal(getTool(deniedRegistrations, 'mcp_call').domain, 'electron_host_override')
  const deniedGeneric = await dispatchToolExecute(deniedRegistrations, 'mcp_call', {
    server: 'docs-server',
    tool: 'lookup',
    arguments: { query: 'generic callback' }
  })
  const deniedDynamic = await dispatchToolExecute(deniedRegistrations, 'mcp__docs__lookup__abc123', {
    query: 'dynamic callback'
  })

  assert.match(deniedGeneric.result.error, /^Permission denied: External MCP tool invocation$/)
  assert.match(deniedDynamic.result.error, /^Permission denied: External MCP tool invocation$/)
  assert.equal(genericCalls.length, 0, 'denied generic MCP tools must not reach Electron MCP execution')
  assert.equal(dynamicCalls.length, 0, 'dynamic MCP tools must use the same Electron permission path')

  const permissionEvents = []
  const approvedServices = createServices({
    mcpService,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => permissionEvents.push({ channel, payload })
      }
    })
  })
  const approvedContext = {
    authMode: 'auto',
    sessionId: 'rust-nested-session',
    conversationId: 'rust-nested-conversation',
    hostSessionId: 'electron-parent-session',
    hostConversationId: 'electron-parent-conversation',
    allowedMcpServerIds: ['docs-server']
  }
  const approvedRegistry = new ElectronToolRegistry({
    services: approvedServices,
    getNativeToolDefinitions: () => []
  })
  const approvedRegistrations = [
    ...await collectHostTools(createHarnessEngine(approvedServices), approvedContext),
    approvedRegistry.createExternalRegistration(approvedContext, {
      definition: dynamicDefinition,
      handler: async (args, onProgress) => await mcpService.executeDynamicTool(
        dynamicDefinition.name,
        args,
        onProgress,
        approvedContext.allowedMcpServerIds
      )
    })
  ]

  const generic = await dispatchToolExecute(approvedRegistrations, 'mcp_call', {
    server: 'docs-server',
    tool: 'lookup',
    arguments: { query: 'generic callback' }
  })
  const dynamic = await dispatchToolExecute(approvedRegistrations, 'mcp__docs__lookup__abc123', {
    query: 'dynamic callback'
  })

  assert.equal(generic.result.source, 'generic-mcp')
  assert.equal(dynamic.result.source, 'dynamic-mcp')
  assert.equal(genericCalls.length, 1)
  assert.equal(dynamicCalls.length, 1)
  const [genericServer, genericTool, genericArgs, genericProgress, genericAllowedServers] = genericCalls[0]
  assert.equal(genericServer, 'docs-server')
  assert.equal(genericTool, 'lookup')
  assert.deepEqual(genericArgs, { query: 'generic callback' })
  assert.equal(typeof genericProgress, 'function')
  assert.deepEqual(genericAllowedServers, ['docs-server'])
  const [dynamicName, dynamicArgs, dynamicProgress, dynamicAllowedServers] = dynamicCalls[0]
  assert.equal(dynamicName, 'mcp__docs__lookup__abc123')
  assert.deepEqual(dynamicArgs, { query: 'dynamic callback' })
  assert.equal(typeof dynamicProgress, 'function')
  assert.deepEqual(dynamicAllowedServers, ['docs-server'])
  assert.deepEqual(permissionEvents.map(event => {
    if (event.channel === 'auth:request') {
      return {
        channel: event.channel,
        conversationId: event.payload.conversationId,
        sessionId: event.payload.sessionId
      }
    }
    return { channel: event.channel, approved: event.payload.approved }
  }), [
    { channel: 'auth:request', conversationId: 'electron-parent-conversation', sessionId: 'electron-parent-session' },
    { channel: 'auth:resolved', approved: true },
    { channel: 'auth:request', conversationId: 'electron-parent-conversation', sessionId: 'electron-parent-session' },
    { channel: 'auth:resolved', approved: true }
  ])
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
