import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { RustHarnessEngine } from '../src/main/ai-harness/rust-harness-engine.ts'
import { ElectronToolRegistry } from '../src/main/ai-harness/electron-tool-registry.ts'
import { RustHarnessClient } from '../electron/main-process/rust-harness-client.ts'

const SESSION_ID = 'rust-host-test-session'

function createNativeToolClient (domainToolNames = []) {
  return {
    async start () {},
    getAvailableTools: () => [
      { name: 'enter_plan_mode', description: 'Enter plan mode', inputSchema: { type: 'object' } },
      { name: 'exit_plan_mode', description: 'Exit plan mode', inputSchema: { type: 'object' } },
      ...domainToolNames.map(name => ({ name, description: `Rust ${name}`, inputSchema: { type: 'object' } }))
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

test('Rust-advertised project, workspace, image, and MCP tools are not registered as Electron fallbacks', async () => {
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

  for (const name of nativeNames) {
    assert.equal(
      registrations.some(tool => tool.definition.name === name),
      false,
      `${name} must remain Rust-native once the app-server advertises it`
    )
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

test('native Rust project, workspace, image, and MCP tool results notify the Electron bridge', async () => {
  const nativeResults = []
  const client = createNativeToolClient([
    'write_project_file',
    'write_workspace_file',
    'generate_image',
    'mcp_call'
  ])
  const engine = new RustHarnessEngine({
    client,
    services: createServices(),
    onNativeToolResult: async (name, result) => nativeResults.push({ name, result })
  })

  for (const [name, content] of [
    ['write_project_file', '{"success":true,"file_path":"src/main.ts"}'],
    ['write_workspace_file', '{"success":true,"file_path":"notes/from-rust.md"}'],
    ['generate_image', JSON.stringify({
      images: [{
        id: 'rust-image-1',
        file: 'rust-image-1.webp',
        createdAt: '2026-08-30T12:00:00.000Z',
        providerId: 'provider-a',
        model: 'image-model',
        prompt: 'Rust image',
        folder: 'rust-runs',
        tags: ['generated'],
        meta: {
          mode: 'edit',
          negativePrompt: 'blur',
          aspect: '16:9',
          size: '1792x1024',
          quality: 'high',
          format: 'webp'
        }
      }]
    })],
    ['mcp_call', '{"ok":true,"content":[{"type":"text","text":"done"}]}']
  ]) {
    await engine.handleNativeToolResult({ kind: 'tool_result', name, content })
  }

  assert.deepEqual(nativeResults, [
    { name: 'write_project_file', result: { success: true, file_path: 'src/main.ts' } },
    { name: 'write_workspace_file', result: { success: true, file_path: 'notes/from-rust.md' } },
    { name: 'generate_image', result: {
      images: [{
        id: 'rust-image-1',
        file: 'rust-image-1.webp',
        createdAt: '2026-08-30T12:00:00.000Z',
        providerId: 'provider-a',
        model: 'image-model',
        prompt: 'Rust image',
        folder: 'rust-runs',
        tags: ['generated'],
        meta: {
          mode: 'edit',
          negativePrompt: 'blur',
          aspect: '16:9',
          size: '1792x1024',
          quality: 'high',
          format: 'webp'
        }
      }]
    } },
    { name: 'mcp_call', result: { ok: true, content: [{ type: 'text', text: 'done' }] } }
  ])
})

test('native Rust agent workspace mutations reach the Electron result bridge', async () => {
  const nativeResults = []
  const engine = new RustHarnessEngine({
    client: createNativeToolClient(['create_agent', 'create_agent_group', 'install_mcp_server']),
    services: createServices(),
    onNativeToolResult: async (name, result) => nativeResults.push({ name, result })
  })

  await engine.handleNativeToolResult({
    kind: 'tool_result',
    name: 'create_agent',
    content: JSON.stringify({
      success: true,
      agent: { id: 'agent_rust', name: 'Rust Agent', systemPrompt: 'Use Rust tools.' }
    })
  })
  await engine.handleNativeToolResult({
    kind: 'tool_result',
    name: 'create_agent_group',
    content: JSON.stringify({
      success: true,
      group: {
        id: 'group_rust',
        name: 'Rust Group',
        coordinatorAgentId: 'agent_rust',
        memberAgentIds: ['agent_rust']
      }
    })
  })
  await engine.handleNativeToolResult({
    kind: 'tool_result',
    name: 'install_mcp_server',
    content: JSON.stringify({
      success: true,
      server_id: 'mcp_rust',
      server: { name: 'mcp_rust', displayName: 'Rust MCP', transport: 'stdio', target: 'npx' }
    })
  })

  assert.deepEqual(nativeResults, [
    {
      name: 'create_agent',
      result: {
        success: true,
        agent: { id: 'agent_rust', name: 'Rust Agent', systemPrompt: 'Use Rust tools.' }
      }
    },
    {
      name: 'create_agent_group',
      result: {
        success: true,
        group: {
          id: 'group_rust',
          name: 'Rust Group',
          coordinatorAgentId: 'agent_rust',
          memberAgentIds: ['agent_rust']
        }
      }
    },
    {
      name: 'install_mcp_server',
      result: {
        success: true,
        server_id: 'mcp_rust',
        server: { name: 'mcp_rust', displayName: 'Rust MCP', transport: 'stdio', target: 'npx' }
      }
    }
  ])
})

test('Rust chat streams preserve native image results without registering an Electron image fallback', async () => {
  const nativeResults = []
  let runOptions
  const client = {
    ...createNativeToolClient(['generate_image']),
    async chatStream (_sessionId, _conversationId, _text, options, onFrame) {
      runOptions = options
      onFrame({
        kind: 'tool_result',
        name: 'generate_image',
        content: JSON.stringify({
          images: [{
            id: 'streamed-rust-image',
            file: 'streamed-rust-image.png',
            createdAt: '2026-08-30T12:00:00.000Z',
            providerId: 'provider-a',
            model: 'image-model',
            prompt: 'A streamed Rust image',
            meta: { mode: 'generate', format: 'png' }
          }]
        })
      })
      onFrame({ kind: 'done' })
      return { streamId: 'streamed-rust-run' }
    }
  }
  const engine = new RustHarnessEngine({
    client,
    services: createServices(),
    onNativeToolResult: async (name, result) => nativeResults.push({ name, result })
  })
  const events = []
  for await (const event of engine.chatStream([{ role: 'user', content: 'draw an image' }])) {
    events.push(event)
  }

  assert.equal(runOptions.customTools.some(tool => tool.definition.name === 'generate_image'), false)
  assert.deepEqual(events.map(event => event.type), ['tool_end', 'done'])
  assert.deepEqual(nativeResults, [{
    name: 'generate_image',
    result: {
      images: [{
        id: 'streamed-rust-image',
        file: 'streamed-rust-image.png',
        createdAt: '2026-08-30T12:00:00.000Z',
        providerId: 'provider-a',
        model: 'image-model',
        prompt: 'A streamed Rust image',
        meta: { mode: 'generate', format: 'png' }
      }]
    }
  }])
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

test('Rust MCP host callbacks retain Electron permission checks and MCP routing', async () => {
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
  const denied = await dispatchToolExecute(deniedRegistrations, 'mcp_call', {
    server: 'docs-server',
    tool: 'lookup',
    arguments: { query: 'host callback' }
  })
  const deniedDynamic = await dispatchToolExecute(deniedRegistrations, 'mcp__docs__lookup__abc123', {
    query: 'dynamic callback'
  })

  assert.match(denied.result.error, /^Permission denied: External MCP tool invocation$/)
  assert.match(deniedDynamic.result.error, /^Permission denied: External MCP tool invocation$/)
  assert.equal(genericCalls.length, 0, 'strict mode without a renderer approval must not call MCP')
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
    arguments: { query: 'host callback' }
  })
  const dynamic = await dispatchToolExecute(approvedRegistrations, 'mcp__docs__lookup__abc123', {
    query: 'dynamic callback'
  })

  assert.equal(generic.result.source, 'generic-mcp')
  assert.equal(dynamic.result.source, 'dynamic-mcp')
  assert.equal(genericCalls.length, 1)
  const [serverId, remoteTool, genericArgs, genericProgress, genericAllowedServers] = genericCalls[0]
  assert.equal(serverId, 'docs-server')
  assert.equal(remoteTool, 'lookup')
  assert.deepEqual(genericArgs, { query: 'host callback' })
  assert.equal(typeof genericProgress, 'function')
  assert.deepEqual(genericAllowedServers, ['docs-server'])
  assert.equal(dynamicCalls.length, 1)
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
