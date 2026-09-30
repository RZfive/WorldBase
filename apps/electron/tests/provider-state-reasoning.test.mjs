import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, ref } from 'vue'
import './register-ts-hooks.mjs'
import { createChatProviderState } from '../src/renderer/components/chat/panel/provider-state.ts'
import { rendererFixture } from './helpers/renderer-fixture.mjs'

/**
 * Reasoning-strength behavior on provider/model switches: the strength must
 * follow the selected model in real time for every provider, not only for
 * gateways whose /models catalog declares effort metadata (deepseek-style).
 * Per-provider ids keep the module-level strength memory isolated per test.
 */
function providerFixture (t, { providers, providersConfig }) {
  rendererFixture(t)
  const refs = {
    activeProviderId: ref(providersConfig.activeProviderId),
    selectedModel: ref(''),
    reasoningStrength: ref('max')
  }
  const state = createChatProviderState({
    conversations: ref([]),
    currentConversationId: ref('conv-1'),
    providers: ref(providers),
    providersConfig: ref({
      providers: providersConfig.providers,
      activeProviderId: providersConfig.activeProviderId,
      enabledProviderIds: providersConfig.providers.map(provider => provider.id)
    }),
    ...refs,
    conversationTemperature: ref(null),
    currentAuthMode: ref('strict'),
    selectedAgentId: ref(''),
    selectedGroupId: ref(''),
    selectedChannelBindingId: ref(''),
    syncingProviderOptions: ref(false),
    planModeActive: ref(false),
    activeStreamSessionIds: new Map(),
    agentsById: computed(() => new Map()),
    providersById: computed(() => new Map(providers.map(provider => [provider.id, provider]))),
    getDefaultAgentId: () => 'default',
    saveConversationMetadata: async () => ({ success: true })
  })
  return { state, refs }
}

test('undeclared models still switch strength in real time via the per-model memory', async t => {
  const { state, refs } = providerFixture(t, {
    providers: [{ id: 'relay', models: ['m-fast', 'm-deep'], activeModel: 'm-fast' }],
    providersConfig: {
      activeProviderId: 'relay',
      providers: [{ id: 'relay', models: ['m-fast', 'm-deep'] }]
    }
  })
  refs.activeProviderId.value = 'relay'
  refs.selectedModel.value = 'm-fast'

  // User picks a strength for m-fast, then moves to a model with no metadata
  // and sets a different one there.
  await state.handleReasoningStrengthChange('low')
  await state.handleProviderModelSelectionChange({ providerId: 'relay', model: 'm-deep' })
  await state.handleReasoningStrengthChange('ultra')
  assert.equal(refs.reasoningStrength.value, 'ultra')

  // Returning to m-fast restores its own strength even though the gateway
  // declares nothing — the switch is no longer deepseek-only.
  await state.handleProviderModelSelectionChange({ providerId: 'relay', model: 'm-fast' })
  assert.equal(refs.reasoningStrength.value, 'low')
})

test('declared metadata: memory wins over the declared default; unsupported values snap', async t => {
  const { state, refs } = providerFixture(t, {
    providers: [{ id: 'ds-like', models: ['d1', 'd2'], activeModel: 'd1' }],
    providersConfig: {
      activeProviderId: 'ds-like',
      providers: [{
        id: 'ds-like',
        modelCapabilities: {
          d1: { reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
          d2: { reasoningEfforts: ['medium', 'max'] }
        }
      }]
    }
  })
  refs.activeProviderId.value = 'ds-like'
  refs.selectedModel.value = 'd2'

  // Session strength 'max' is not accepted by d1 → snaps to the declared default.
  await state.handleProviderModelSelectionChange({ providerId: 'ds-like', model: 'd1' })
  assert.equal(refs.reasoningStrength.value, 'high')

  // An explicit pick is remembered and wins over the default on return.
  await state.handleReasoningStrengthChange('low')
  await state.handleProviderModelSelectionChange({ providerId: 'ds-like', model: 'd2' })
  assert.equal(refs.reasoningStrength.value, 'medium')
  await state.handleProviderModelSelectionChange({ providerId: 'ds-like', model: 'd1' })
  assert.equal(refs.reasoningStrength.value, 'low')

  // Returning to d2 without any pick for it keeps the remembered 'low' only if
  // accepted; d2 declares medium/max, so it clamps to the nearest instead.
  await state.handleProviderModelSelectionChange({ providerId: 'ds-like', model: 'd2' })
  assert.equal(refs.reasoningStrength.value, 'medium')
})

test('user-chosen model default applies when the model has no remembered pick', async t => {
  const { state, refs } = providerFixture(t, {
    providers: [{ id: 'cfg', models: ['c1'], activeModel: 'c1' }],
    providersConfig: {
      activeProviderId: 'cfg',
      providers: [{
        id: 'cfg',
        modelCapabilities: {
          c1: { reasoningEfforts: ['minimal', 'low', 'medium'], reasoningEffort: 'low' }
        }
      }]
    }
  })
  refs.activeProviderId.value = 'cfg'
  refs.selectedModel.value = ''

  // 'high' (session default) is outside the declared set → falls to the
  // user-chosen per-model default before considering a clamp.
  await state.handleProviderModelSelectionChange({ providerId: 'cfg', model: 'c1' })
  assert.equal(refs.reasoningStrength.value, 'low')
})
