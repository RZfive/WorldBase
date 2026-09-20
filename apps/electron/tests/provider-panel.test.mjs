import assert from 'node:assert/strict'
import test from 'node:test'
import { createI18n } from 'vue-i18n'
import './register-ts-hooks.mjs'
import { messages } from '../src/locales/index.ts'
import { getRecommendedProviderTemplate } from '../src/shared/provider-templates.ts'
import { flush, loadSetupComponent, rendererFixture } from './helpers/renderer-fixture.mjs'

// Settings > Providers, "choose models from provider". The picker's trigger
// badge used to show only the selected count, so a freshly fetched catalog
// always read as "0" until the user picked something. The badge now reads
// selected/available and the hint below counts both.

const MultiSelectDropdown = await loadSetupComponent(new URL('../src/renderer/components/settings/MultiSelectDropdown.vue', import.meta.url))
const ProviderPanel = await loadSetupComponent(new URL('../src/renderer/components/settings/ProviderPanel.vue', import.meta.url))

const zh = messages['zh-CN'].settings.provider

function i18n () {
  return createI18n({ legacy: false, locale: 'zh-CN', messages })
}

test('the multi-select badge counts available options, not only selected ones', t => {
  const fixture = rendererFixture(t)
  const options = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'].map(value => ({ value, label: value }))

  const empty = fixture.mount(MultiSelectDropdown, { modelValue: [], options, label: 'Models' }, [i18n()])
  assert.equal(empty.state.countText, '0/3')
  assert.equal(empty.state.countTitle, '已选 0 项，共 3 项可选')

  const picked = fixture.mount(MultiSelectDropdown, { modelValue: ['deepseek-flash', 'deepseek-v4-pro'], options, label: 'Models' }, [i18n()])
  assert.equal(picked.state.countText, '2/3')

  const none = fixture.mount(MultiSelectDropdown, { modelValue: [], options: [], label: 'Models' }, [i18n()])
  assert.equal(none.state.countText, '0/0')
})

test('fetched provider models are offered and counted before any is selected', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fixture = rendererFixture(t)
  const catalog = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']
  const fetches = []
  fixture.window.electronAPI = {
    getProviders: async () => ({ providers: [], activeProviderId: '', enabledProviderIds: [] }),
    getCostSettings: async () => ({ modelPricing: [], budgetLimit: null }),
    fetchProviderModels: async input => { fetches.push(input); return { models: catalog } },
    detectProviderProtocol: async () => { throw new Error('an explicit protocol must not be probed') }
  }
  const { state } = fixture.mount(ProviderPanel, {}, [i18n()])
  await flush()

  const template = getRecommendedProviderTemplate()
  state.useTemplate(template)
  await flush()
  assert.equal(state.editing, true)
  assert.deepEqual(state.editDraft.models, ['deepseek-flash', 'deepseek-v4-pro'])
  assert.equal(state.editDraft.activeModel, 'deepseek-flash')
  assert.equal(state.remoteModelOptions.length, 0, 'nothing is fetched without a key')
  assert.equal(state.remoteModelsPlaceholder, zh.remoteModelsPlaceholder)

  // Pasting a key schedules the debounced catalog fetch.
  state.editDraft.apiKey = 'sk-' + 'a'.repeat(32)
  await flush()
  t.mock.timers.tick(700)
  await flush()
  await flush()

  assert.equal(fetches.length, 1)
  assert.equal(fetches[0].baseUrl, template.baseUrl)
  assert.equal(fetches[0].apiProtocol, 'openai-chat')
  assert.equal(state.remoteModelsLoading, false)
  assert.equal(state.remoteModelsError, '')
  assert.equal(state.remoteModels.length, 4)
  assert.deepEqual(
    state.remoteModelOptions.map(option => option.value),
    ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
    'models the template already configured are not offered twice'
  )
  assert.equal(state.selectedRemoteModels.length, 0)
  assert.equal(state.remoteModelsPlaceholder, zh.remoteModelsPlaceholder)

  // Adding everything that was offered leaves an honest "all added" state.
  state.selectedRemoteModels = state.remoteModelOptions.map(option => option.value)
  await flush()
  state.addSelectedRemoteModels()
  await flush()
  assert.equal(state.editDraft.models.length, 4)
  assert.equal(state.remoteModelOptions.length, 0)
  assert.equal(state.remoteModelsPlaceholder, zh.remoteModelsAllAdded)
  assert.equal(state.statusMsg, '已添加 2 个远端模型')
})
