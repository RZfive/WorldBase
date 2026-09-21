<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  DEFAULT_DAILY_SUGGESTION_PREFERENCES,
  KNOWLEDGE_INTEREST_MAX_LENGTH,
  KNOWLEDGE_MAX_INTERESTS,
  KNOWLEDGE_PROFESSION_MAX_LENGTH,
  KNOWLEDGE_SOURCES,
  LLM_KNOWLEDGE_SOURCES,
  SUGGESTION_TYPES,
  normalizeDailySuggestionPreferences,
  type DailySuggestionCountPerType,
  type DailySuggestionPreferences,
  type DailySuggestionSnapshot,
  type KnowledgeCountPerSource,
  type KnowledgeSource,
  type SuggestionType,
  type WorkSuggestion
} from '../../../shared/daily-suggestion-types.js'
import {
  dailySuggestionSnapshot,
  ensureDailySuggestionSubscription,
  knowledgeShuffling,
  loadDailySuggestions,
  refreshKnowledgeSuggestionCard
} from '../chat/panel/suggestion-state'

interface ProviderChoice {
  id: string
  name: string
  models: string[]
}

const { t, te, locale } = useI18n()

const FEEDBACK_DISPLAY_DURATION_MS = 2200
const COUNT_OPTIONS: DailySuggestionCountPerType[] = [2, 3, 5]

const preferences = ref<DailySuggestionPreferences>(normalizeDailySuggestionPreferences(DEFAULT_DAILY_SUGGESTION_PREFERENCES))
const providers = ref<ProviderChoice[]>([])
const saving = ref(false)
const generating = ref(false)
const feedback = ref('')
const loaded = ref(false)
const interestInput = ref('')
const professionInput = ref('')

const snapshot = computed<DailySuggestionSnapshot | null>(() => dailySuggestionSnapshot.value)
const lastGeneration = computed(() => snapshot.value?.lastGeneration ?? null)
const enabled = computed(() => preferences.value.enabled)
const knowledge = computed(() => preferences.value.knowledge)
const knowledgeEnabled = computed(() => knowledge.value.enabled)
const hasProviders = computed(() => providers.value.length > 0)
const needsInterests = computed(() => knowledge.value.sources.includes('interest') && knowledge.value.interests.length === 0)
const knowledgeCards = computed(() => snapshot.value?.knowledge ?? [])
const knowledgeSourceOptions = computed(() => KNOWLEDGE_SOURCES.map(source => ({
  id: source,
  label: t(`chatUi.suggestions.knowledgeSources.${source}.label`),
  description: t(`chatUi.suggestions.knowledgeSources.${source}.description`),
  needsModel: (LLM_KNOWLEDGE_SOURCES as readonly string[]).includes(source)
})))
const selectedProvider = computed(() => providers.value.find(provider => provider.id === preferences.value.providerId) || null)
const modelChoices = computed(() => selectedProvider.value?.models ?? [])
const typeOptions = computed(() => SUGGESTION_TYPES.map(type => ({
  id: type,
  label: t(`chatUi.suggestions.types.${type}.label`),
  description: t(`chatUi.suggestions.types.${type}.description`),
  uses: t(`chatUi.suggestions.types.${type}.uses`)
})))
const triggerKind = computed({
  get: () => preferences.value.trigger.kind,
  set: (kind: 'time' | 'first-open') => {
    preferences.value = {
      ...preferences.value,
      trigger: kind === 'time' ? { kind: 'time', timeOfDay: preferences.value.trigger.kind === 'time' ? preferences.value.trigger.timeOfDay : '09:00' } : { kind: 'first-open' }
    }
    void persist()
  }
})
const triggerTime = computed({
  get: () => preferences.value.trigger.kind === 'time' ? preferences.value.trigger.timeOfDay : '09:00',
  set: (timeOfDay: string) => {
    if (preferences.value.trigger.kind !== 'time') return
    preferences.value = { ...preferences.value, trigger: { kind: 'time', timeOfDay } }
    void persist()
  }
})
/** Manual refresh is unlimited: the button only waits for a running generation. */
const generateDisabled = computed(() => (!enabled.value && !(knowledgeEnabled.value && knowledge.value.sources.some(source => (LLM_KNOWLEDGE_SOURCES as readonly string[]).includes(source)))) || saving.value || generating.value || snapshot.value?.generating === true)

const replenishing = ref(false)
const knowledgePool = computed(() => snapshot.value?.knowledgePool ?? null)
const randomSelected = computed(() => knowledgeEnabled.value && knowledge.value.sources.includes('random'))
/** Any pool-backed source (random seeds or model-written cards) can be topped up. */
const poolBacked = computed(() => randomSelected.value || knowledge.value.sources.some(source => (LLM_KNOWLEDGE_SOURCES as readonly string[]).includes(source)))
const replenishDisabled = computed(() => !poolBacked.value || !hasProviders.value || saving.value || replenishing.value || knowledgePool.value?.replenishing === true)
const knowledgePoolLabel = computed(() => {
  const pool = knowledgePool.value
  if (!pool) return ''
  return t('settings.dailySuggestions.knowledge.poolSize', { builtin: pool.builtin, generated: pool.generated, unseen: pool.unseen })
})
const knowledgeCardsLabel = computed(() => {
  const pool = knowledgePool.value
  if (!pool) return ''
  return t('settings.dailySuggestions.knowledge.cardPoolSize', { cards: pool.cards, unseen: pool.cardsUnseen })
})
const knowledgePoolStatus = computed(() => {
  const pool = knowledgePool.value
  if (!pool) return ''
  if (pool.lastReplenishError) {
    const reason = pool.lastReplenishError === 'PROVIDER_MISSING'
      ? t('settings.dailySuggestions.errorProviderMissing')
      : pool.lastReplenishError === 'MODEL_OUTPUT_NOT_JSON' || pool.lastReplenishError === 'MODEL_OUTPUT_EMPTY'
        ? t('settings.dailySuggestions.errorNotJson')
        : pool.lastReplenishError
    return t('settings.dailySuggestions.knowledge.poolFailed', { reason })
  }
  if (!pool.lastReplenishAt) {
    return hasProviders.value
      ? t('settings.dailySuggestions.knowledge.poolNeverReplenished')
      : t('settings.dailySuggestions.knowledge.poolNoProvider')
  }
  const when = new Intl.DateTimeFormat(locale.value, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(pool.lastReplenishAt))
  return t('settings.dailySuggestions.knowledge.poolReplenishedAt', { time: when })
})

const lastGenerationLabel = computed(() => {
  const state = lastGeneration.value
  if (!state) return t('settings.dailySuggestions.neverGenerated')
  const when = new Intl.DateTimeFormat(locale.value, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(state.at))
  if (state.status === 'failed') {
    const reason = state.error === 'PROVIDER_MISSING'
      ? t('settings.dailySuggestions.errorProviderMissing')
      : state.error === 'MODEL_OUTPUT_NOT_JSON'
        ? t('settings.dailySuggestions.errorNotJson')
        : (state.error || t('settings.dailySuggestions.errorUnknown'))
    return t('settings.dailySuggestions.lastFailed', { time: when, reason })
  }
  if (state.status === 'partial') return t('settings.dailySuggestions.lastPartial', { time: when })
  return t('settings.dailySuggestions.lastOk', { time: when })
})

function setFeedback (message: string): void {
  feedback.value = message
  window.setTimeout(() => {
    if (feedback.value === message) feedback.value = ''
  }, FEEDBACK_DISPLAY_DURATION_MS)
}

async function loadProviders (): Promise<void> {
  try {
    const config = await window.electronAPI?.getProviders?.()
    const enabledIds = new Set(config?.enabledProviderIds ?? [])
    providers.value = (config?.providers ?? [])
      .filter(provider => enabledIds.size === 0 || enabledIds.has(provider.id))
      .map(provider => ({ id: provider.id, name: provider.name, models: provider.models }))
  } catch {
    providers.value = []
  }
}

async function loadPreferences (): Promise<void> {
  try {
    const next = await window.electronAPI?.getDailySuggestionPreferences?.()
    if (next) preferences.value = normalizeDailySuggestionPreferences(next)
    professionInput.value = preferences.value.knowledge.profession
  } catch {
    /* keep defaults */
  } finally {
    loaded.value = true
  }
}

async function persist (): Promise<void> {
  if (!window.electronAPI?.saveDailySuggestionPreferences) return
  const previous = preferences.value
  saving.value = true
  try {
    // Deep-reactive refs are Proxies; structured clone across the context bridge rejects them.
    const plain = JSON.parse(JSON.stringify(preferences.value)) as DailySuggestionPreferences
    preferences.value = normalizeDailySuggestionPreferences(await window.electronAPI.saveDailySuggestionPreferences(plain))
    setFeedback(t('common.saved'))
  } catch (error) {
    preferences.value = previous
    setFeedback(t('common.saveFailed', { message: (error as Error).message }))
  } finally {
    saving.value = false
  }
}

function toggleEnabled (): void {
  preferences.value = { ...preferences.value, enabled: !preferences.value.enabled }
  void persist()
}

function toggleType (type: SuggestionType): void {
  const current = new Set(preferences.value.types)
  if (current.has(type)) {
    // Keep at least one type selected so generation always has a target.
    if (current.size === 1) {
      setFeedback(t('settings.dailySuggestions.atLeastOneType'))
      return
    }
    current.delete(type)
  } else {
    current.add(type)
  }
  preferences.value = { ...preferences.value, types: SUGGESTION_TYPES.filter(item => current.has(item)) }
  void persist()
}

function setCount (count: DailySuggestionCountPerType): void {
  if (preferences.value.countPerType === count) return
  preferences.value = { ...preferences.value, countPerType: count }
  void persist()
}

function onProviderChange (event: Event): void {
  const providerId = (event.target as HTMLSelectElement).value || null
  preferences.value = { ...preferences.value, providerId, modelId: null }
  void persist()
}

function onModelChange (event: Event): void {
  const modelId = (event.target as HTMLSelectElement).value || null
  preferences.value = { ...preferences.value, modelId }
  void persist()
}

function toggleContext (key: keyof DailySuggestionPreferences['context']): void {
  preferences.value = {
    ...preferences.value,
    context: { ...preferences.value.context, [key]: !preferences.value.context[key] }
  }
  void persist()
}

// ── Knowledge exploration ────────────────────────────────────────────────
function patchKnowledge (patch: Partial<DailySuggestionPreferences['knowledge']>): void {
  preferences.value = { ...preferences.value, knowledge: { ...preferences.value.knowledge, ...patch } }
  void persist()
}

function toggleKnowledgeEnabled (): void {
  patchKnowledge({ enabled: !knowledge.value.enabled })
}

function toggleKnowledgeSource (source: KnowledgeSource): void {
  const current = new Set(knowledge.value.sources)
  if (current.has(source)) {
    if (current.size === 1) {
      setFeedback(t('settings.dailySuggestions.knowledge.atLeastOneSource'))
      return
    }
    current.delete(source)
  } else {
    current.add(source)
  }
  patchKnowledge({ sources: KNOWLEDGE_SOURCES.filter(item => current.has(item)) })
}

function addInterest (): void {
  const value = interestInput.value.trim().replace(/\s+/g, ' ')
  if (!value) return
  if (knowledge.value.interests.length >= KNOWLEDGE_MAX_INTERESTS) {
    setFeedback(t('settings.dailySuggestions.knowledge.interestsFull', { max: KNOWLEDGE_MAX_INTERESTS }))
    return
  }
  const next = value.slice(0, KNOWLEDGE_INTEREST_MAX_LENGTH)
  if (knowledge.value.interests.some(item => item.toLowerCase() === next.toLowerCase())) {
    interestInput.value = ''
    return
  }
  interestInput.value = ''
  patchKnowledge({ interests: [...knowledge.value.interests, next] })
}

function removeInterest (interest: string): void {
  patchKnowledge({ interests: knowledge.value.interests.filter(item => item !== interest) })
}

function commitProfession (): void {
  const next = professionInput.value.trim().replace(/\s+/g, ' ').slice(0, KNOWLEDGE_PROFESSION_MAX_LENGTH)
  professionInput.value = next
  if (next === knowledge.value.profession) return
  patchKnowledge({ profession: next })
}

function setKnowledgeCount (count: KnowledgeCountPerSource): void {
  if (knowledge.value.countPerSource === count) return
  patchKnowledge({ countPerSource: count })
}

/** Built-in seeds carry i18n keys; generated copy carries literal model text. */
function knowledgeCardText (item: WorkSuggestion, field: 'title' | 'description'): string {
  const raw = item[field]
  if (!raw) return ''
  return item.source === 'static' && te(raw) ? t(raw) : raw
}

function knowledgeCardSourceLabel (item: WorkSuggestion): string {
  const source = item.knowledge?.source
  if (!source) return ''
  return t(`chatUi.suggestions.knowledgeSources.${source}.label`)
}

/** Swap one knowledge card for the next pool entry; unlimited. */
async function refreshCard (item: WorkSuggestion): Promise<void> {
  await refreshKnowledgeSuggestionCard(item.id)
  setFeedback(t('settings.dailySuggestions.knowledge.cardRefreshed'))
}

async function replenishPool (): Promise<void> {
  if (replenishDisabled.value || !window.electronAPI?.replenishKnowledgePool) return
  replenishing.value = true
  try {
    const before = knowledgePool.value?.generated ?? 0
    dailySuggestionSnapshot.value = await window.electronAPI.replenishKnowledgePool()
    const after = dailySuggestionSnapshot.value.knowledgePool?.generated ?? before
    setFeedback(t('settings.dailySuggestions.knowledge.poolReplenishDone', { count: Math.max(0, after - before) }))
  } catch (error) {
    const message = (error as Error).message || ''
    setFeedback(message.includes('PROVIDER_MISSING')
      ? t('settings.dailySuggestions.errorProviderMissing')
      : t('settings.dailySuggestions.generateFailedWith', { message }))
  } finally {
    replenishing.value = false
  }
}

async function generateNow (): Promise<void> {
  if (generateDisabled.value || !window.electronAPI?.generateDailySuggestionsNow) return
  generating.value = true
  try {
    dailySuggestionSnapshot.value = await window.electronAPI.generateDailySuggestionsNow()
    const state = dailySuggestionSnapshot.value.lastGeneration
    // The random card may be a generated seed; only count items this run produced.
    const count = dailySuggestionSnapshot.value.daily.length + dailySuggestionSnapshot.value.knowledge.filter(item => item.source === 'llm' && item.knowledge?.source !== 'random').length
    setFeedback(state?.status === 'failed'
      ? t('settings.dailySuggestions.generateFailed')
      : t('settings.dailySuggestions.generateDone', { count }))
  } catch (error) {
    setFeedback(t('settings.dailySuggestions.generateFailedWith', { message: (error as Error).message }))
  } finally {
    generating.value = false
  }
}

onMounted(() => {
  // Shared with the chat empty state; the subscription lives for the app session.
  ensureDailySuggestionSubscription()
  void Promise.all([loadPreferences(), loadProviders(), loadDailySuggestions()])
})
</script>

<template>
  <div class="ds-root">
    <header class="ds-header">
      <div class="ds-header-copy">
        <h3>{{ $t('settings.dailySuggestions.title') }}</h3>
        <p>{{ $t('settings.dailySuggestions.description') }}</p>
      </div>
      <p v-if="feedback" class="ds-feedback">{{ feedback }}</p>
    </header>

    <section class="ds-card ds-toggle-card">
      <div class="ds-card-copy">
        <span class="ds-card-title">{{ $t('settings.dailySuggestions.enableTitle') }}</span>
        <p class="ds-card-hint">{{ $t('settings.dailySuggestions.enableHint') }}</p>
      </div>
      <button
        type="button"
        class="ds-switch"
        role="switch"
        :aria-checked="enabled"
        :disabled="saving || !loaded"
        @click="toggleEnabled"
      >
        <span class="ds-switch-track" :class="{ on: enabled }"><span class="ds-switch-thumb" /></span>
      </button>
    </section>

    <div class="ds-body" :class="{ disabled: !enabled }" :aria-disabled="!enabled">
      <section class="ds-card">
        <div class="ds-section-head">
          <span class="ds-card-title">{{ $t('settings.dailySuggestions.typesTitle') }}</span>
          <span class="ds-section-meta">{{ $t('settings.dailySuggestions.typesSelected', { count: preferences.types.length }) }}</span>
        </div>
        <p class="ds-card-hint">{{ $t('settings.dailySuggestions.typesHint') }}</p>
        <div class="ds-type-grid">
          <button
            v-for="option in typeOptions"
            :key="option.id"
            type="button"
            class="ds-type-card"
            :class="{ active: preferences.types.includes(option.id) }"
            :disabled="!enabled || saving"
            :aria-pressed="preferences.types.includes(option.id)"
            @click="toggleType(option.id)"
          >
            <span class="ds-type-check" aria-hidden="true">{{ preferences.types.includes(option.id) ? '✓' : '' }}</span>
            <span class="ds-type-copy">
              <strong>{{ option.label }}</strong>
              <small>{{ option.description }}</small>
              <em>{{ $t('settings.dailySuggestions.typeUses', { data: option.uses }) }}</em>
            </span>
          </button>
        </div>
      </section>

      <div class="ds-grid-two">
        <section class="ds-card">
          <span class="ds-card-title">{{ $t('settings.dailySuggestions.countTitle') }}</span>
          <p class="ds-card-hint">{{ $t('settings.dailySuggestions.countHint') }}</p>
          <div class="ds-segmented" role="radiogroup">
            <button
              v-for="count in COUNT_OPTIONS"
              :key="count"
              type="button"
              class="ds-segment"
              :class="{ active: preferences.countPerType === count }"
              role="radio"
              :aria-checked="preferences.countPerType === count"
              :disabled="!enabled || saving"
              @click="setCount(count)"
            >
              {{ count }}
            </button>
          </div>
        </section>

        <section class="ds-card">
          <span class="ds-card-title">{{ $t('settings.dailySuggestions.triggerTitle') }}</span>
          <p class="ds-card-hint">{{ $t('settings.dailySuggestions.triggerHint') }}</p>
          <div class="ds-trigger">
            <label class="ds-radio">
              <input v-model="triggerKind" type="radio" value="first-open" :disabled="!enabled || saving" />
              <span>{{ $t('settings.dailySuggestions.triggerFirstOpen') }}</span>
            </label>
            <label class="ds-radio">
              <input v-model="triggerKind" type="radio" value="time" :disabled="!enabled || saving" />
              <span>{{ $t('settings.dailySuggestions.triggerTime') }}</span>
              <input
                v-model.lazy="triggerTime"
                class="ds-time"
                type="time"
                :disabled="!enabled || saving || triggerKind !== 'time'"
              />
            </label>
          </div>
        </section>
      </div>

      <div class="ds-grid-two">
        <section class="ds-card">
          <span class="ds-card-title">{{ $t('settings.dailySuggestions.modelTitle') }}</span>
          <p class="ds-card-hint">{{ $t('settings.dailySuggestions.modelHint') }}</p>
          <div class="ds-fields">
            <label class="ds-field">
              <span>{{ $t('settings.dailySuggestions.provider') }}</span>
              <select :value="preferences.providerId || ''" :disabled="!enabled || saving" @change="onProviderChange">
                <option value="">{{ $t('settings.dailySuggestions.followDefault') }}</option>
                <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
              </select>
            </label>
            <label class="ds-field">
              <span>{{ $t('settings.dailySuggestions.model') }}</span>
              <select :value="preferences.modelId || ''" :disabled="!enabled || saving || !selectedProvider" @change="onModelChange">
                <option value="">{{ $t('settings.dailySuggestions.followDefault') }}</option>
                <option v-for="model in modelChoices" :key="model" :value="model">{{ model }}</option>
              </select>
            </label>
          </div>
        </section>

        <section class="ds-card">
          <span class="ds-card-title">{{ $t('settings.dailySuggestions.contextTitle') }}</span>
          <p class="ds-card-hint">{{ $t('settings.dailySuggestions.contextHint') }}</p>
          <div class="ds-checks">
            <label class="ds-check">
              <input type="checkbox" :checked="preferences.context.projects" :disabled="!enabled || saving" @change="toggleContext('projects')" />
              <span>
                <strong>{{ $t('settings.dailySuggestions.contextProjects') }}</strong>
                <small>{{ $t('settings.dailySuggestions.contextProjectsHint') }}</small>
              </span>
            </label>
            <label class="ds-check">
              <input type="checkbox" :checked="preferences.context.conversationTitles" :disabled="!enabled || saving" @change="toggleContext('conversationTitles')" />
              <span>
                <strong>{{ $t('settings.dailySuggestions.contextTitles') }}</strong>
                <small>{{ $t('settings.dailySuggestions.contextTitlesHint') }}</small>
              </span>
            </label>
            <label class="ds-check">
              <input type="checkbox" :checked="preferences.context.conversationSummaries" :disabled="!enabled || saving || !preferences.context.conversationTitles" @change="toggleContext('conversationSummaries')" />
              <span>
                <strong>{{ $t('settings.dailySuggestions.contextSummaries') }}</strong>
                <small>{{ $t('settings.dailySuggestions.contextSummariesHint') }}</small>
              </span>
            </label>
          </div>
        </section>
      </div>

      <section class="ds-card ds-status-card">
        <div class="ds-card-copy">
          <span class="ds-card-title">{{ $t('settings.dailySuggestions.statusTitle') }}</span>
          <p class="ds-card-hint" :class="{ failed: lastGeneration?.status === 'failed' }">{{ lastGenerationLabel }}</p>
        </div>
        <button type="button" class="ds-primary-btn" :disabled="generateDisabled" @click="generateNow">
          {{ generating || snapshot?.generating ? $t('settings.dailySuggestions.generating') : $t('settings.dailySuggestions.generateNow') }}
        </button>
      </section>
    </div>

    <!-- Knowledge exploration: independent of the daily-picks switch because the random seed needs no model. -->
    <section class="ds-card ds-toggle-card ds-knowledge-head">
      <div class="ds-card-copy">
        <span class="ds-card-title">{{ $t('settings.dailySuggestions.knowledge.title') }}</span>
        <p class="ds-card-hint">{{ $t('settings.dailySuggestions.knowledge.hint') }}</p>
      </div>
      <button
        type="button"
        class="ds-switch"
        role="switch"
        :aria-checked="knowledgeEnabled"
        :disabled="saving || !loaded"
        @click="toggleKnowledgeEnabled"
      >
        <span class="ds-switch-track" :class="{ on: knowledgeEnabled }"><span class="ds-switch-thumb" /></span>
      </button>
    </section>

    <div class="ds-body" :class="{ disabled: !knowledgeEnabled }" :aria-disabled="!knowledgeEnabled">
      <!-- Today's knowledge cards; each one can be swapped for the next pool entry right here. -->
      <section v-if="knowledgeCards.length > 0" class="ds-card">
        <div class="ds-section-head">
          <span class="ds-card-title">{{ $t('settings.dailySuggestions.knowledge.todayTitle') }}</span>
          <span class="ds-section-meta">{{ $t('settings.dailySuggestions.knowledge.todayMeta', { count: knowledgeCards.length }) }}</span>
        </div>
        <p class="ds-card-hint">{{ $t('settings.dailySuggestions.knowledge.todayHint') }}</p>
        <div class="ds-today-list">
          <div v-for="item in knowledgeCards" :key="item.id" class="ds-today-item">
            <div class="ds-today-copy">
              <span class="ds-today-source">{{ knowledgeCardSourceLabel(item) }}</span>
              <span class="ds-today-title">{{ knowledgeCardText(item, 'title') }}</span>
              <p class="ds-card-hint">{{ knowledgeCardText(item, 'description') }}</p>
            </div>
            <button
              type="button"
              class="ds-secondary-btn"
              :disabled="knowledgeShuffling"
              :title="$t('chatUi.suggestions.shuffleHint')"
              @click="refreshCard(item)"
            >↻ {{ $t('chatUi.suggestions.shuffle') }}</button>
          </div>
        </div>
      </section>

      <!-- Pools: built-in seeds cover the cold start; the model tops both pools up once a provider exists. -->
      <section v-if="knowledgePool" class="ds-card ds-status-card">
        <div class="ds-card-copy">
          <span class="ds-card-title">{{ $t('settings.dailySuggestions.knowledge.poolTitle') }}</span>
          <p class="ds-card-hint">{{ knowledgePoolLabel }}</p>
          <p class="ds-card-hint">{{ knowledgeCardsLabel }}</p>
          <p class="ds-card-hint" :class="{ failed: !!knowledgePool.lastReplenishError }">{{ knowledgePoolStatus }}</p>
        </div>
        <button type="button" class="ds-primary-btn" :disabled="replenishDisabled" @click="replenishPool">
          {{ replenishing || knowledgePool.replenishing ? $t('settings.dailySuggestions.knowledge.poolReplenishing') : $t('settings.dailySuggestions.knowledge.poolReplenishNow') }}
        </button>
      </section>

      <section class="ds-card">
        <div class="ds-section-head">
          <span class="ds-card-title">{{ $t('settings.dailySuggestions.knowledge.sourcesTitle') }}</span>
          <span class="ds-section-meta">{{ $t('settings.dailySuggestions.typesSelected', { count: knowledge.sources.length }) }}</span>
        </div>
        <p class="ds-card-hint">{{ $t('settings.dailySuggestions.knowledge.sourcesHint') }}</p>
        <p v-if="!hasProviders" class="ds-card-hint ds-inline-warn">{{ $t('settings.dailySuggestions.knowledge.needsProvider') }}</p>
        <div class="ds-type-grid">
          <button
            v-for="option in knowledgeSourceOptions"
            :key="option.id"
            type="button"
            class="ds-type-card"
            :class="{ active: knowledge.sources.includes(option.id) }"
            :disabled="!knowledgeEnabled || saving || (option.needsModel && !hasProviders && !knowledge.sources.includes(option.id))"
            :aria-pressed="knowledge.sources.includes(option.id)"
            @click="toggleKnowledgeSource(option.id)"
          >
            <span class="ds-type-check" aria-hidden="true">{{ knowledge.sources.includes(option.id) ? '✓' : '' }}</span>
            <span class="ds-type-copy">
              <strong>{{ option.label }}</strong>
              <small>{{ option.description }}</small>
              <em>{{ option.needsModel ? $t('settings.dailySuggestions.knowledge.needsModel') : $t('settings.dailySuggestions.knowledge.noModel') }}</em>
            </span>
          </button>
        </div>
      </section>

      <div class="ds-grid-two">
        <section class="ds-card">
          <span class="ds-card-title">{{ $t('settings.dailySuggestions.knowledge.interestsTitle') }}</span>
          <p class="ds-card-hint">{{ $t('settings.dailySuggestions.knowledge.interestsHint', { max: KNOWLEDGE_MAX_INTERESTS }) }}</p>
          <p v-if="needsInterests" class="ds-card-hint ds-inline-warn">{{ $t('settings.dailySuggestions.knowledge.interestsRequired') }}</p>
          <div class="ds-tags">
            <span v-for="interest in knowledge.interests" :key="interest" class="ds-tag">
              {{ interest }}
              <button type="button" class="ds-tag-rm" :disabled="!knowledgeEnabled || saving" :aria-label="$t('common.delete')" @click="removeInterest(interest)">×</button>
            </span>
          </div>
          <input
            v-model="interestInput"
            class="ds-input"
            type="text"
            :maxlength="KNOWLEDGE_INTEREST_MAX_LENGTH"
            :placeholder="$t('settings.dailySuggestions.knowledge.interestsPlaceholder')"
            :disabled="!knowledgeEnabled || saving"
            @keydown.enter.prevent="addInterest"
            @blur="addInterest"
          />
        </section>

        <section class="ds-card">
          <span class="ds-card-title">{{ $t('settings.dailySuggestions.knowledge.professionTitle') }}</span>
          <p class="ds-card-hint">{{ $t('settings.dailySuggestions.knowledge.professionHint') }}</p>
          <input
            v-model="professionInput"
            class="ds-input"
            type="text"
            :maxlength="KNOWLEDGE_PROFESSION_MAX_LENGTH"
            :placeholder="$t('settings.dailySuggestions.knowledge.professionPlaceholder')"
            :disabled="!knowledgeEnabled || saving"
            @keydown.enter.prevent="commitProfession"
            @blur="commitProfession"
          />
          <span class="ds-card-title ds-sub-title">{{ $t('settings.dailySuggestions.knowledge.countTitle') }}</span>
          <p class="ds-card-hint">{{ $t('settings.dailySuggestions.knowledge.countHint') }}</p>
          <div class="ds-segmented ds-segmented-two" role="radiogroup">
            <button
              v-for="count in ([1, 2] as KnowledgeCountPerSource[])"
              :key="count"
              type="button"
              class="ds-segment"
              :class="{ active: knowledge.countPerSource === count }"
              role="radio"
              :aria-checked="knowledge.countPerSource === count"
              :disabled="!knowledgeEnabled || saving"
              @click="setKnowledgeCount(count)"
            >
              {{ count }}
            </button>
          </div>
        </section>
      </div>

      <p class="ds-card-hint ds-privacy-note">{{ $t('settings.dailySuggestions.knowledge.privacyNote') }}</p>
    </div>
  </div>
</template>

<style scoped>
.ds-root {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-height: 0;
  padding: 20px 24px;
  overflow-y: auto;
  color: var(--app-text);
  background: var(--app-main-surface);
}

.ds-root * {
  box-sizing: border-box;
  min-width: 0;
}

.ds-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.ds-header h3 {
  margin: 0 0 4px;
  color: var(--app-text-strong);
}

.ds-header p,
.ds-card-hint {
  margin: 0;
  color: var(--app-text-soft);
  font-size: 0.82rem;
  line-height: 1.55;
}

.ds-card-hint.failed {
  color: #b91c1c;
}

.ds-feedback {
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  color: #075985;
  background: rgba(14, 165, 233, 0.12);
  border: 1px solid rgba(14, 165, 233, 0.24);
  font-size: 0.8rem;
  white-space: nowrap;
}

.ds-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
}

.ds-toggle-card,
.ds-status-card {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}

.ds-card-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.ds-card-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--app-text);
}

.ds-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.ds-section-meta {
  font-size: 0.76rem;
  color: var(--app-text-faint);
}

.ds-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  transition: opacity 0.16s ease;
}

.ds-body.disabled {
  opacity: 0.55;
}

.ds-switch {
  flex: 0 0 auto;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}

.ds-switch:disabled {
  cursor: default;
  opacity: 0.72;
}

.ds-switch-track {
  display: block;
  position: relative;
  width: 54px;
  height: 30px;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.22);
  border: 1px solid var(--app-border);
  transition: background 0.16s ease;
}

.ds-switch-track.on {
  background: var(--app-accent);
  border-color: transparent;
}

.ds-switch-thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: #fff;
  transition: transform 0.16s ease;
}

.ds-switch-track.on .ds-switch-thumb {
  transform: translateX(24px);
}

.ds-type-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  margin-top: 4px;
}

.ds-type-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel);
  color: var(--app-text);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}

.ds-type-card:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border));
}

.ds-type-card.active {
  border-color: var(--app-accent);
  background: var(--app-accent-soft);
}

.ds-type-card:disabled {
  cursor: default;
}

.ds-type-check {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
  border-radius: 6px;
  border: 1px solid var(--app-border-strong);
  font-size: 0.72rem;
  color: #fff;
  background: transparent;
}

.ds-type-card.active .ds-type-check {
  background: var(--app-accent);
  border-color: var(--app-accent);
}

.ds-type-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.ds-type-copy strong {
  font-size: 0.86rem;
  color: var(--app-text-strong);
}

.ds-type-copy small {
  font-size: 0.76rem;
  color: var(--app-text-soft);
  line-height: 1.5;
}

.ds-type-copy em {
  font-style: normal;
  font-size: 0.7rem;
  color: var(--app-text-faint);
}

.ds-grid-two {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
}

.ds-segmented {
  display: inline-grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: min(100%, 240px);
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
}

.ds-segment {
  padding: 6px 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-soft);
  font-size: 0.84rem;
  cursor: pointer;
}

.ds-segment.active {
  background: var(--app-accent-soft);
  color: var(--app-accent);
  font-weight: 600;
}

.ds-segment:disabled {
  cursor: default;
}

.ds-trigger {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ds-radio {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.84rem;
  cursor: pointer;
}

.ds-time {
  margin-left: auto;
  padding: 4px 8px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-panel);
  color: var(--app-text);
  font-size: 0.82rem;
}

.ds-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}

.ds-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--app-text-soft);
}

.ds-field select {
  padding: 7px 9px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel);
  color: var(--app-text);
  font-size: 0.82rem;
}

.ds-checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ds-check {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}

.ds-check input {
  margin-top: 3px;
}

.ds-check span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ds-check strong {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--app-text);
}

.ds-check small {
  font-size: 0.74rem;
  color: var(--app-text-faint);
  line-height: 1.5;
}

.ds-primary-btn {
  flex: 0 0 auto;
  min-height: 34px;
  padding: 7px 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #f8fbff;
  background: linear-gradient(135deg, #0284c7, #0ea5e9);
  font-size: 0.82rem;
  cursor: pointer;
}

.ds-primary-btn:disabled {
  cursor: default;
  opacity: 0.55;
}

/* ── Knowledge exploration ────────────────────────────────────────────── */
.ds-knowledge-head {
  margin-top: 6px;
}

.ds-today-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ds-today-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, #f59e0b 32%, var(--app-border));
  border-radius: 10px;
  background: color-mix(in srgb, #f59e0b 7%, transparent);
}

.ds-today-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.ds-today-source {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: #b45309;
}

:root[data-theme='dark'] .ds-today-source {
  color: #fbbf24;
}

.ds-today-title {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--app-text-strong);
}

.ds-secondary-btn {
  flex: 0 0 auto;
  min-height: 30px;
  padding: 5px 12px;
  border: 1px solid var(--app-border-strong);
  border-radius: 8px;
  background: var(--app-panel);
  color: var(--app-text-soft);
  font-size: 0.78rem;
  cursor: pointer;
  white-space: nowrap;
}

.ds-secondary-btn:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border-strong));
  color: var(--app-text);
}

.ds-secondary-btn:disabled {
  cursor: default;
  opacity: 0.55;
}

.ds-inline-warn {
  color: #b45309;
}

.ds-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ds-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px 3px 10px;
  border-radius: 999px;
  background: var(--app-accent-soft);
  color: var(--app-accent);
  font-size: 0.78rem;
}

.ds-tag-rm {
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font-size: 0.9rem;
  line-height: 1;
  cursor: pointer;
}

.ds-tag-rm:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-accent) 20%, transparent);
}

.ds-input {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel);
  color: var(--app-text);
  font-size: 0.82rem;
}

.ds-input:focus {
  outline: none;
  border-color: var(--app-accent);
}

.ds-sub-title {
  margin-top: 6px;
}

.ds-segmented-two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  width: min(100%, 160px);
}

.ds-privacy-note {
  padding: 0 4px;
}
</style>
