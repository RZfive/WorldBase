import assert from 'node:assert/strict'
import test from 'node:test'
import './register-ts-hooks.mjs'
import {
  buildAnthropicRequestBody,
  mapAnthropicUsage,
  normalizeAnthropicResponse,
  resolveAnthropicThinking
} from '../src/main/ai-engine/providers/anthropic-provider/convert.ts'
import { createProvider } from '../src/main/ai-engine/providers/index.ts'
import { OpenAIProvider } from '../src/main/ai-engine/providers/openai-provider.ts'
import { AnthropicProvider } from '../src/main/ai-engine/providers/anthropic-provider.ts'
import { resolveApiProtocol } from '../src/main/ai-engine/providers/openai-provider/runtime/models.ts'
import { getAnthropicMessagesUrl } from '../src/main/ai-engine/providers/openai-provider/runtime/urls.ts'

function createAnthropicProvider () {
  return createProvider({ baseUrl: 'https://api.anthropic.com/v1', apiProtocol: 'anthropic' })
}

test('resolveApiProtocol maps explicit values without URL sniffing', () => {
  // Auto never guesses from the base URL; probe-based detection is pinned
  // upstream by the settings page before values reach the engine.
  assert.equal(resolveApiProtocol('https://api.anthropic.com/v1'), 'openai')
  assert.equal(resolveApiProtocol('https://openrouter.ai/api/v1'), 'openai')
  // Explicit settings always win.
  assert.equal(resolveApiProtocol('https://api.anthropic.com/v1', 'anthropic'), 'anthropic')
  assert.equal(resolveApiProtocol('https://gateway.example.com/v1', 'anthropic'), 'anthropic')
  // Legacy 'openai' and 'openai-chat' are the same wire protocol.
  assert.equal(resolveApiProtocol('https://api.anthropic.com/v1', 'openai'), 'openai')
  assert.equal(resolveApiProtocol('https://api.anthropic.com/v1', 'openai-chat'), 'openai')
  assert.equal(resolveApiProtocol('https://api.openai.com/v1', 'openai-responses'), 'openai-responses')
})

test('createProvider dispatches by protocol', () => {
  // No URL sniffing: auto defaults to the OpenAI chat provider everywhere.
  assert.ok(createProvider({ baseUrl: 'https://api.openai.com/v1' }) instanceof OpenAIProvider)
  assert.ok(createProvider({ baseUrl: 'https://api.anthropic.com/v1' }) instanceof OpenAIProvider)
  assert.ok(createProvider({ baseUrl: 'https://openrouter.ai/api/v1' }) instanceof OpenAIProvider)
  // Explicit protocol overrides.
  assert.ok(createProvider({ baseUrl: 'https://gateway.example.com/v3', apiProtocol: 'anthropic' }) instanceof AnthropicProvider)
  assert.ok(createProvider({ baseUrl: 'https://api.anthropic.com/v1', apiProtocol: 'anthropic' }) instanceof AnthropicProvider)
  // The Responses wire protocol is Rust-harness-only and must fail loudly.
  assert.throws(() => createProvider({ apiProtocol: 'openai-responses' }), /Rust harness/)
})

function anthropicRuntime () {
  const provider = createAnthropicProvider()
  provider.setApiKey('test-key')
  provider.setModel('claude-sonnet-4-5')
  return provider.getRuntime()
}

test('buildAnthropicRequestBody hoists system messages with a cache breakpoint', () => {
  const runtime = anthropicRuntime()
  const body = buildAnthropicRequestBody(runtime, [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hi' }
  ], [], false)

  assert.equal(body.system?.length, 1)
  assert.equal(body.system[0].text, 'You are helpful.')
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' })
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].role, 'user')
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'hi' }])
  assert.equal(body.max_tokens, 8192)
  assert.equal(body.temperature, 0.3)
  assert.equal(body.stream, undefined)
})

test('buildAnthropicRequestBody converts tool calls and tool results', () => {
  const runtime = anthropicRuntime()
  const body = buildAnthropicRequestBody(runtime, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'list files' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'toolu_1', type: 'function', function: { name: 'list_files', arguments: '{"path":"/tmp"}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'toolu_1', content: '["a.ts","b.ts"]' }
  ], [], false)

  assert.equal(body.messages.length, 3)

  const assistant = body.messages[1]
  assert.equal(assistant.role, 'assistant')
  const toolUse = assistant.content.find(block => block.type === 'tool_use')
  assert.equal(toolUse.id, 'toolu_1')
  assert.equal(toolUse.name, 'list_files')
  assert.deepEqual(toolUse.input, { path: '/tmp' })

  const result = body.messages[2]
  assert.equal(result.role, 'user')
  const toolResult = result.content.find(block => block.type === 'tool_result')
  assert.equal(toolResult.tool_use_id, 'toolu_1')
  assert.equal(toolResult.content, '["a.ts","b.ts"]')
})

test('buildAnthropicRequestBody merges consecutive turns and enforces user-first', () => {
  const runtime = anthropicRuntime()
  const body = buildAnthropicRequestBody(runtime, [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'hello' },
    { role: 'tool', tool_call_id: 't1', content: 'ok' },
    { role: 'tool', tool_call_id: 't2', content: 'ok2' }
  ], [], false)

  assert.equal(body.messages[0].role, 'user')
  assert.equal(body.messages.length, 3)
  assert.equal(body.messages[1].role, 'assistant')
  // Both tool results merged into a single user turn.
  const results = body.messages[2].content.filter(block => block.type === 'tool_result')
  assert.equal(results.length, 2)
})

test('buildAnthropicRequestBody maps tools and thinking config', () => {
  const provider = createAnthropicProvider()
  provider.setApiKey('k')
  provider.setEnableThinking(true)
  provider.setReasoningEffort('high')
  const runtime = provider.getRuntime()

  const body = buildAnthropicRequestBody(runtime, [
    { role: 'user', content: 'go' }
  ], [
    { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
  ], true)

  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 16384 })
  assert.ok(body.max_tokens > body.thinking.budget_tokens)
  // Extended thinking requires the default temperature.
  assert.equal(body.temperature, undefined)
  assert.equal(body.stream, true)
  assert.equal(body.tools[0].name, 'read_file')
  assert.deepEqual(body.tools[0].input_schema, { type: 'object', properties: { path: { type: 'string' } } })
  assert.deepEqual(body.tool_choice, { type: 'auto' })
})

test('buildAnthropicRequestBody converts image data URLs to base64 sources', () => {
  const runtime = anthropicRuntime()
  const body = buildAnthropicRequestBody(runtime, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        { type: 'image_url', image_url: { url: 'https://cdn.example.com/cat.png' } }
      ]
    }
  ], [], false)

  const blocks = body.messages[0].content
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'image')
  assert.deepEqual(blocks[1].source, { type: 'base64', media_type: 'image/png', data: 'QUJD' })
  assert.deepEqual(blocks[2].source, { type: 'url', url: 'https://cdn.example.com/cat.png' })
})

test('buildAnthropicRequestBody replays signed and redacted thinking blocks unchanged', () => {
  const runtime = anthropicRuntime()
  const body = buildAnthropicRequestBody(runtime, [
    { role: 'user', content: 'continue the lookup' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'inspect the file', signature: 'opaque-signature' },
        { type: 'text', text: 'I found it.' },
        { type: 'redacted_thinking', data: 'opaque-redacted-payload' }
      ],
      tool_calls: [{
        id: 'toolu_signed',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/tmp/x"}' }
      }]
    },
    { role: 'tool', tool_call_id: 'toolu_signed', content: 'contents' }
  ], [], false)

  assert.deepEqual(body.messages[1].content.slice(0, 3), [
    { type: 'thinking', thinking: 'inspect the file', signature: 'opaque-signature' },
    { type: 'text', text: 'I found it.' },
    { type: 'redacted_thinking', data: 'opaque-redacted-payload' }
  ])
})

test('normalizeAnthropicResponse retains replayable thinking blocks', () => {
  const { message } = normalizeAnthropicResponse({
    content: [
      { type: 'thinking', thinking: 'inspect', signature: 'sig-1' },
      { type: 'redacted_thinking', data: 'redacted-1' },
      { type: 'text', text: 'done' }
    ]
  })

  assert.deepEqual(message.content, [
    { type: 'thinking', thinking: 'inspect', signature: 'sig-1' },
    { type: 'redacted_thinking', data: 'redacted-1' },
    { type: 'text', text: 'done' }
  ])
  assert.equal(message.reasoning_content, 'inspect')
})

test('normalizeAnthropicResponse assembles text, thinking and tool calls', () => {
  const { message, usage } = normalizeAnthropicResponse({
    content: [
      { type: 'thinking', thinking: 'pondering' },
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
      { type: 'tool_use', id: 'toolu_9', name: 'write_file', input: { path: '/tmp/x' } }
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10
    }
  })

  assert.equal(message.role, 'assistant')
  assert.equal(message.content, 'hello world')
  assert.equal(message.reasoning_content, 'pondering')
  assert.equal(message.tool_calls.length, 1)
  assert.equal(message.tool_calls[0].id, 'toolu_9')
  assert.equal(message.tool_calls[0].function.name, 'write_file')
  assert.equal(message.tool_calls[0].function.arguments, '{"path":"/tmp/x"}')

  assert.deepEqual(usage, {
    prompt_tokens: 170,
    completion_tokens: 40,
    total_tokens: 210,
    prompt_tokens_details: { cached_tokens: 60 }
  })
})

test('mapAnthropicUsage tolerates missing fields', () => {
  assert.equal(mapAnthropicUsage(undefined), undefined)
  assert.deepEqual(mapAnthropicUsage({ output_tokens: 5 }), {
    prompt_tokens: undefined,
    completion_tokens: 5,
    total_tokens: 5,
    prompt_tokens_details: undefined
  })
})

test('resolveAnthropicThinking follows the effort mapping', () => {
  const provider = createAnthropicProvider()
  provider.setApiKey('k')
  provider.setEnableThinking(true)

  provider.setReasoningEffort('low')
  assert.equal(resolveAnthropicThinking(provider.getRuntime()).budget_tokens, 2048)
  provider.setReasoningEffort('max')
  assert.equal(resolveAnthropicThinking(provider.getRuntime()).budget_tokens, 32000)

  provider.setEnableThinking(false)
  assert.equal(resolveAnthropicThinking(provider.getRuntime()), undefined)
})

test('getAnthropicMessagesUrl follows the Anthropic SDK path convention', () => {
  // Versioned bases append only the endpoint segment.
  assert.equal(getAnthropicMessagesUrl('https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1/messages')
  assert.equal(getAnthropicMessagesUrl('https://ark.cn-beijing.volces.com/api/v3'), 'https://ark.cn-beijing.volces.com/api/v3/messages')
  // Bare / unversioned bases get the SDK-style /v1/messages suffix.
  assert.equal(getAnthropicMessagesUrl('https://ark.cn-beijing.volces.com/api/coding'), 'https://ark.cn-beijing.volces.com/api/coding/v1/messages')
  assert.equal(getAnthropicMessagesUrl('https://open.bigmodel.cn/api/anthropic'), 'https://open.bigmodel.cn/api/anthropic/v1/messages')
  assert.equal(getAnthropicMessagesUrl('https://api.moonshot.cn/anthropic'), 'https://api.moonshot.cn/anthropic/v1/messages')
  // Full endpoint pasted as-is, or OpenAI-style path swapped in place.
  assert.equal(getAnthropicMessagesUrl('https://gw.example.com/v1/messages'), 'https://gw.example.com/v1/messages')
  assert.equal(getAnthropicMessagesUrl('https://gw.example.com/v1/chat/completions'), 'https://gw.example.com/v1/messages')
})

test('anthropic streaming end-to-end with a mocked fetch', async () => {
  const provider = createAnthropicProvider()
  provider.setApiKey('test-key')
  provider.setModel('claude-sonnet-4-5')

  let capturedUrl = ''
  let capturedInit = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url)
    capturedInit = init
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 30 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'He' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_42', name: 'read_file' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"/a"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' }
    ]
    const payload = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const body = new ReadableStream({
      start (controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      }
    })
    return new Response(body, { status: 200 })
  }

  const usages = []
  provider.setOnUsage(usage => usages.push(usage))
  const events = []

  try {
    for await (const event of provider.chatCompletionStream(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }]
    )) {
      events.push(event)
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages')
  // Both auth styles: x-api-key for the native API, Bearer for gateways.
  assert.equal(capturedInit.headers['x-api-key'], 'test-key')
  assert.equal(capturedInit.headers.Authorization, 'Bearer test-key')
  assert.equal(capturedInit.headers['anthropic-version'], '2023-06-01')
  const sentBody = JSON.parse(capturedInit.body)
  assert.equal(sentBody.system[0].cache_control.type, 'ephemeral')
  assert.equal(sentBody.tools[0].input_schema.type, 'object')
  assert.equal(sentBody.stream, true)

  const tokenEvents = events.filter(event => event.type === 'token')
  assert.deepEqual(tokenEvents.map(event => event.content), ['He', 'llo'])

  const toolCallEvent = events.find(event => event.type === 'tool_calls')
  assert.equal(toolCallEvent.message.tool_calls[0].id, 'toolu_42')
  assert.equal(toolCallEvent.message.tool_calls[0].function.name, 'read_file')
  assert.equal(toolCallEvent.message.tool_calls[0].function.arguments, '{"path":"/a"}')

  const doneEvent = events[events.length - 1]
  assert.equal(doneEvent.type, 'done')
  assert.equal(doneEvent.message.content, 'Hello')
  assert.deepEqual(usages, [{
    prompt_tokens: 80,
    completion_tokens: 12,
    total_tokens: 92,
    prompt_tokens_details: { cached_tokens: 30 }
  }])
})

test('anthropic streaming preserves thinking signatures and redacted payloads', async () => {
  const provider = createAnthropicProvider()
  provider.setApiKey('test-key')
  provider.setEnableThinking(true)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'inspect' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '1' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'done' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' }
    ]
    const payload = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const body = new ReadableStream({
      start (controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      }
    })
    return new Response(body, { status: 200 })
  }

  try {
    let doneMessage
    for await (const event of provider.chatCompletionStream([{ role: 'user', content: 'go' }])) {
      if (event.type === 'done') doneMessage = event.message
    }
    assert.deepEqual(doneMessage?.content, [
      { type: 'thinking', thinking: 'inspect', signature: 'sig-1' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'done' }
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('anthropic non-streaming completion routes to /messages', async () => {
  const provider = createAnthropicProvider()
  provider.setApiKey('test-key')
  provider.setModel('claude-sonnet-4-5')

  let capturedUrl = ''
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url)
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 3 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const message = await provider.chatCompletion([{ role: 'user', content: 'ping' }])
    assert.equal(message.content, 'ok')
    assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages')
  } finally {
    globalThis.fetch = originalFetch
  }
})
