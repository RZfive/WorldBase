import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import './register-ts-hooks.mjs'
import {
  buildProviderModelsUrl,
  clampReasoningEffort,
  fetchProviderModels,
  parseProviderModelMetadata,
  parseProviderModels
} from '../src/main/settings/provider-model-service.ts'
import { normalizeModelCapabilities } from '../src/main/settings/model-capabilities.ts'

async function withServer (handler, run) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

test('buildProviderModelsUrl handles OpenAI and Anthropic version paths', () => {
  assert.equal(buildProviderModelsUrl('https://api.openai.com/v1/', 'openai'), 'https://api.openai.com/v1/models')
  assert.equal(buildProviderModelsUrl('https://api.anthropic.com', 'anthropic'), 'https://api.anthropic.com/v1/models')
  assert.equal(buildProviderModelsUrl('https://api.anthropic.com/v1', 'anthropic'), 'https://api.anthropic.com/v1/models')
})

test('parseProviderModels deduplicates, sorts, and accepts compatible response shapes', () => {
  assert.deepEqual(parseProviderModels({
    data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'a-model' }, { id: ' ' }]
  }), ['a-model', 'z-model'])
  assert.deepEqual(parseProviderModels({ models: ['model-b', { id: 'model-a' }] }), ['model-a', 'model-b'])
})

test('parseProviderModels accepts slug-keyed entries', () => {
  assert.deepEqual(parseProviderModels({
    models: [{ slug: 'glm-5.3' }, { slug: 'glm-5.3-flash' }, { id: 'other' }]
  }), ['glm-5.3', 'glm-5.3-flash', 'other'])
})

test('parseProviderModelMetadata extracts declared effort levels and context windows', () => {
  assert.deepEqual(parseProviderModelMetadata({
    models: [
      {
        slug: 'glm-5.3',
        supported_reasoning_levels: [
          { effort: 'low', description: 'Light reasoning' },
          { effort: 'high', description: 'Enhanced reasoning' },
          { effort: 'max', description: 'Maximum reasoning' }
        ],
        default_reasoning_level: 'max',
        context_window: 1048576
      },
      { slug: 'glm-5-turbo', supported_reasoning_levels: [] },
      { slug: 'context-only', context_window: 204800 }
    ]
  }), {
    'glm-5.3': { supportedReasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max', contextWindow: 1048576 },
    'context-only': { supportedReasoningEfforts: [], contextWindow: 204800 }
  })
  assert.deepEqual(parseProviderModelMetadata({ data: [{ id: 'gpt-5.1' }] }), {})
  assert.deepEqual(parseProviderModelMetadata('not an object'), {})
})

test('parseProviderModelMetadata understands the deepseek effort nesting', () => {
  assert.deepEqual(parseProviderModelMetadata({
    data: [{
      id: 'deepseek-flash',
      context_window: 1048576,
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' }
    }]
  }), {
    'deepseek-flash': { supportedReasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', contextWindow: 1048576 }
  })
})

test('clampReasoningEffort keeps supported requests and passes through unknown declarations', () => {
  const supported = ['low', 'high', 'max']
  assert.equal(clampReasoningEffort('high', supported), 'high')
  assert.equal(clampReasoningEffort('max', supported), 'max')
  assert.equal(clampReasoningEffort('medium', undefined), 'medium')
  assert.equal(clampReasoningEffort('medium', []), 'medium')
  assert.equal(clampReasoningEffort('medium', ['low', 'high', 'max']), 'high')
  assert.equal(clampReasoningEffort('medium', ['low', 'high']), 'high')
  assert.equal(clampReasoningEffort('low', ['medium', 'high']), 'medium')
  assert.equal(clampReasoningEffort('max', ['low', 'high']), 'high')
  assert.equal(clampReasoningEffort('minimal', ['low', 'max']), 'low')
  assert.equal(clampReasoningEffort('low', ['nonsense']), 'low')
  assert.equal(clampReasoningEffort('xhigh', ['low', 'high', 'xhigh']), 'xhigh')
  assert.equal(clampReasoningEffort('max', ['low', 'high', 'xhigh']), 'xhigh')
  assert.equal(clampReasoningEffort('xhigh', ['low', 'high', 'max']), 'max')
  assert.equal(clampReasoningEffort('xhigh', undefined), 'xhigh')
  // cc-switch canonical set: none < minimal < low < medium < high < xhigh < max < ultra
  assert.equal(clampReasoningEffort('ultra', ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']), 'ultra')
  assert.equal(clampReasoningEffort('none', ['minimal', 'low', 'medium', 'high']), 'minimal')
  assert.equal(clampReasoningEffort('ultra', ['low', 'high', 'xhigh']), 'xhigh')
  assert.equal(clampReasoningEffort('none', undefined), 'none')
})

test('fetchProviderModels uses OpenAI bearer authentication', async () => {
  await withServer((request, response) => {
    assert.equal(request.url, '/v1/models')
    assert.equal(request.headers.authorization, 'Bearer test-secret')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }))
  }, async baseUrl => {
    const models = await fetchProviderModels({
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'test-secret',
      apiProtocol: 'openai-chat'
    })
    assert.deepEqual(models, ['model-a', 'model-b'])
  })
})

test('fetchProviderModels treats both OpenAI wire protocols as Bearer catalog style', async () => {
  await withServer((request, response) => {
    assert.equal(request.url, '/v1/models')
    assert.equal(request.headers.authorization, 'Bearer test-secret')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'gpt-5.1' }] }))
  }, async baseUrl => {
    const models = await fetchProviderModels({
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'test-secret',
      apiProtocol: 'openai-responses'
    })
    assert.deepEqual(models, ['gpt-5.1'])
  })
})

test('fetchProviderModels auto entries retry with Anthropic headers on auth failures', async () => {
  const seen = []
  await withServer((request, response) => {
    seen.push({ url: request.url, auth: request.headers.authorization, apiKey: request.headers['x-api-key'] })
    if (request.url === '/models') {
      // First OpenAI-style attempt fails with an auth error.
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: { message: 'no bearer' } }))
      return
    }
    assert.equal(request.url, '/v1/models')
    assert.equal(request.headers['x-api-key'], 'anthropic-secret')
    assert.equal(request.headers['anthropic-version'], '2023-06-01')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'claude-sonnet' }] }))
  }, async baseUrl => {
    const models = await fetchProviderModels({ baseUrl, apiKey: 'anthropic-secret' })
    assert.deepEqual(models, ['claude-sonnet'])
    assert.equal(seen.length, 2)
  })
})

test('fetchProviderModels auto entries do not retry on non-auth failures', async () => {
  let calls = 0
  await withServer((request, response) => {
    calls += 1
    response.statusCode = 500
    response.end(JSON.stringify({ error: { message: 'upstream down' } }))
  }, async baseUrl => {
    await assert.rejects(
      fetchProviderModels({ baseUrl, apiKey: 'secret' }),
      /\(500\)/
    )
    assert.equal(calls, 1)
  })
})

test('fetchProviderModels uses Anthropic headers and surfaces remote errors', async () => {
  await withServer((request, response) => {
    assert.equal(request.url, '/v1/models')
    assert.equal(request.headers['x-api-key'], 'anthropic-secret')
    assert.equal(request.headers['anthropic-version'], '2023-06-01')
    response.statusCode = 401
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ error: { message: 'invalid credentials' } }))
  }, async baseUrl => {
    await assert.rejects(
      fetchProviderModels({ baseUrl, apiKey: 'anthropic-secret', apiProtocol: 'anthropic' }),
      /\(401\): invalid credentials/
    )
  })
})

test('normalizeModelCapabilities preserves reasoning-effort metadata across saves', () => {
  // Regression: the sanitizer used to rebuild each entry with only the image
  // flags, so gateway-declared levels and the user's allowed multi-pick were
  // dropped on every save — models fell back to the full 8-level enum.
  const normalized = normalizeModelCapabilities({
    'glm-4.6': {
      imageGeneration: true,
      imageEditing: false,
      reasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'high',
      reasoningEffort: 'high',
      allowedReasoningEfforts: ['low', 'high']
    }
  }, ['glm-4.6'])

  assert.deepEqual(normalized['glm-4.6'], {
    imageGeneration: true,
    imageEditing: false,
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
    reasoningEffort: 'high',
    allowedReasoningEfforts: ['low', 'high']
  })
})

test('normalizeModelCapabilities drops malformed effort fields and backfills image flags', () => {
  const normalized = normalizeModelCapabilities({
    broken: { reasoningEfforts: [], allowedReasoningEfforts: 'nope', reasoningEffort: 'turbo' },
    declared: { reasoningEfforts: ['medium'] }
  }, ['broken', 'declared'])

  assert.deepEqual(normalized.broken, { imageGeneration: false, imageEditing: false })
  assert.deepEqual(normalized.declared, { imageGeneration: false, imageEditing: false, reasoningEfforts: ['medium'] })
})
