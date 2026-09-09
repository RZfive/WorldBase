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
      apiProtocol: 'openai'
    })
    assert.deepEqual(models, ['model-a', 'model-b'])
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
