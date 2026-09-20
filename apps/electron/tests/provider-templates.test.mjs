import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import './register-ts-hooks.mjs'
import {
  PROVIDER_TEMPLATES,
  getRecommendedProviderTemplate,
  isAllowedExternalUrl,
  looksLikeApiKey,
  providerTemplateHosts
} from '../src/shared/provider-templates.ts'
import { SettingsStore } from '../src/main/settings/settings-store.ts'
import { resolveDefaultModelPricing } from '../src/main/ai-engine/cost-tracker.ts'
import zhCN from '../src/locales/zh-CN/index.ts'
import enUS from '../src/locales/en-US/index.ts'

// Built-in provider templates: read-only, pre-filled provider forms. They must
// be internally consistent, must only ever open https links on their own
// hosts, and must round-trip through the settings store once copied into a
// real provider.

test('every template is well-formed and exactly one is recommended', () => {
  const ids = new Set()
  let recommended = 0
  for (const template of PROVIDER_TEMPLATES) {
    assert.ok(!ids.has(template.id), `duplicate template id ${template.id}`)
    ids.add(template.id)
    assert.equal(new URL(template.baseUrl).protocol, 'https:')
    for (const [key, url] of Object.entries(template.links)) {
      assert.ok(url, `${template.id}.links.${key} is empty`)
      assert.equal(new URL(url).protocol, 'https:', `${template.id}.links.${key} must be https`)
    }
    assert.ok(template.links.homepage)
    assert.ok(template.models.some(model => model.id === template.defaultModel), `${template.id} defaultModel must be in models`)
    assert.ok(template.models.every(model => model.contextWindow > 0))
    if (template.apiKeyPattern) assert.doesNotThrow(() => new RegExp(template.apiKeyPattern))
    assert.match(template.verifiedAt, /^\d{4}-\d{2}-\d{2}$/)
    if (template.recommended) recommended += 1
    for (const [name, locale] of [['zh-CN', zhCN], ['en-US', enUS]]) {
      assert.ok(locale.settings.provider.templates[template.id]?.tagline, `${name} tagline missing for ${template.id}`)
    }
  }
  assert.equal(recommended, 1)
  assert.equal(getRecommendedProviderTemplate().id, 'deepseek')
})

// Checked against https://api-docs.deepseek.com/quick_start/pricing on
// 2026-09-20: the API lists deepseek-flash (V4.1-Flash) and deepseek-v4-pro,
// both with a 1M context; the quick-start examples all call deepseek-flash.
// deepseek-chat / deepseek-reasoner were retired on 2026-07-24.
test('the DeepSeek template mirrors the official model list and prices it like the cost tracker', () => {
  const deepseek = PROVIDER_TEMPLATES.find(template => template.id === 'deepseek')
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com')
  assert.equal(deepseek.apiProtocol, 'openai-chat')
  assert.deepEqual(deepseek.models.map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro'])
  assert.equal(deepseek.defaultModel, 'deepseek-flash', 'the default is the model the official quick start calls')
  for (const retired of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.ok(!deepseek.models.some(model => model.id === retired), `${retired} is no longer offered by DeepSeek`)
  }
  for (const model of deepseek.models) {
    assert.equal(model.contextWindow, 1_000_000, `${model.id} has a 1M context`)
    assert.deepEqual(
      resolveDefaultModelPricing(model.id),
      model.pricing,
      `${model.id}: the template price must equal the cost tracker's built-in price`
    )
  }
  // DeepSeek still serves the legacy flash names at the Flash price.
  assert.deepEqual(resolveDefaultModelPricing('deepseek-v4-flash-vision-exp'), resolveDefaultModelPricing('deepseek-flash'))
  assert.equal(resolveDefaultModelPricing('deepseek-chat'), undefined, 'retired names carry no stale price')
})

test('the external-url allow-list admits template hosts over https and nothing else', () => {
  const hosts = providerTemplateHosts()
  assert.ok(hosts.has('platform.deepseek.com'))
  for (const template of PROVIDER_TEMPLATES) {
    for (const url of Object.values(template.links)) assert.ok(isAllowedExternalUrl(url), `${url} should be allowed`)
  }
  assert.equal(isAllowedExternalUrl('http://platform.deepseek.com/api_keys'), false, 'http is refused')
  assert.equal(isAllowedExternalUrl('https://example.com'), false)
  assert.equal(isAllowedExternalUrl('https://platform.deepseek.com.evil.com/'), false)
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false)
  assert.equal(isAllowedExternalUrl('not a url'), false)
  assert.equal(isAllowedExternalUrl('https://example.com', ['example.com']), true, 'extra hosts can be granted explicitly')
})

test('clipboard key detection uses the template pattern first and a generic rule otherwise', () => {
  const deepseek = PROVIDER_TEMPLATES.find(template => template.id === 'deepseek')
  assert.equal(looksLikeApiKey('sk-' + 'a'.repeat(32), deepseek), true)
  assert.equal(looksLikeApiKey('  sk-' + 'a'.repeat(32) + '\n', deepseek), true, 'surrounding whitespace is trimmed')
  assert.equal(looksLikeApiKey('sk-short', deepseek), false)
  assert.equal(looksLikeApiKey('sk-' + 'a'.repeat(16) + ' ' + 'b'.repeat(16), deepseek), false, 'inner whitespace is not a key')
  assert.equal(looksLikeApiKey('这是一段普通的中文文本，不是密钥。', deepseek), false)
  assert.equal(looksLikeApiKey('sk-ant-' + 'x'.repeat(40), null), true, 'generic rule knows common prefixes')
  assert.equal(looksLikeApiKey('x'.repeat(40), null), true, 'generic rule accepts long unspaced tokens')
  assert.equal(looksLikeApiKey('x'.repeat(19), null), false)
  assert.equal(looksLikeApiKey('x'.repeat(201), null), false)
  assert.equal(looksLikeApiKey('sk-' + 'a'.repeat(32), { apiKeyPattern: '[' }), true, 'a broken pattern falls back to the generic rule')
})

test('providers created from a template keep templateId and links through the settings store', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worldbase-provider-templates-'))
  try {
    const store = new SettingsStore(directory)
    const template = getRecommendedProviderTemplate()
    store.saveProviders({
      providers: [
        {
          id: 'deepseek_abc',
          name: 'DeepSeek',
          baseUrl: template.baseUrl,
          apiKey: 'sk-test',
          apiProtocol: template.apiProtocol,
          models: template.models.map(model => model.id),
          activeModel: template.defaultModel,
          templateId: template.id,
          links: { ...template.links, billing: 'http://insecure.example', bogus: 'https://x.y' }
        },
        { id: 'manual', name: 'Manual', baseUrl: 'https://api.example.com/v1', apiKey: 'k', models: ['m'], activeModel: 'm' }
      ],
      activeProviderId: 'deepseek_abc',
      enabledProviderIds: ['deepseek_abc']
    })
    const reloaded = new SettingsStore(directory).getProviders()
    const fromTemplate = reloaded.providers.find(provider => provider.id === 'deepseek_abc')
    assert.equal(fromTemplate.templateId, 'deepseek')
    assert.equal(fromTemplate.links.homepage, template.links.homepage)
    assert.equal(fromTemplate.links.apiKeys, template.links.apiKeys)
    assert.equal(fromTemplate.links.billing, undefined, 'non-https links are dropped')
    assert.equal('bogus' in fromTemplate.links, false, 'unknown link keys are dropped')
    const manual = reloaded.providers.find(provider => provider.id === 'manual')
    assert.equal('templateId' in manual, false)
    assert.equal('links' in manual, false)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
