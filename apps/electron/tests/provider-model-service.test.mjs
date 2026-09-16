import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import './register-ts-hooks.mjs'
import {
  buildProviderModelsUrl,
  fetchProviderModels,
  parseProviderModels
} from '../src/main/settings/provider-model-service.ts'

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
