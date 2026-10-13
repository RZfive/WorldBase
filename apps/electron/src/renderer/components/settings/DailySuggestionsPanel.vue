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

/** One-line per-type / per-source breakdown of what a run just produced. */
function generationReport (snapshotAfter: DailySuggestionSnapshot): string {
  const parts: string[] = []
  for (const type of SUGGESTION_TYPES) {
    const count = snapshotAfter.daily.filter(item => item.type === type).length
    if (count > 0) parts.push(`${t(`chatUi.suggestions.types.${type}.label`)} ×${count}`)
  }
  for (const source of KNOWLEDGE_SOURCES) {
    const count = snapshotAfter.knowledge.filter(item => item.knowledge?.source === source).length
    if (count > 0) parts.push(`${t(`chatUi.suggestions.knowledgeSources.${source}.label`)} ×${count}`)
  }
  return parts.join('、')
}

async function generateNow (): Promise<void> {
  if (generateDisabled.value || !window.electronAPI?.generateDailySuggestionsNow) return
  generating.value = true
  try {
    dailySuggestionSnapshot.value = await window.electronAPI.generateDailySuggestionsNow()
    const snapshotAfter = dailySuggestionSnapshot.value
    const state = snapshotAfter.lastGeneration
    if (state?.status === 'failed') {
      setFeedback(t('settings.dailySuggestions.generateFailed'))
      return
    }
    const detail = generationReport(snapshotAfter)
    setFeedback(detail
      ? t('settings.dailySuggestions.generateDoneDetail', { detail })
      : t('settings.dailySuggestions.generateDone', { count: snapshotAfter.daily.length + snapshotAfter.knowledge.length }))
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

    <!-- ── One card per row: switches on the left, shared generation on the right ── -->
    <section class="ds-card">
      <div class="ds-split">
        <div class="ds-pane">
          <div class="ds-toggle-row">
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
          </div>
          <div class="ds-toggle-row">
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
          </div>
        </div>
        <div class="ds-pane">
          <span class="ds-card-title">{{ $t('settings.dailySuggestions.generationTitle') }}</span>
          <p class="ds-card-hint">{{ $t('settings.dailySuggestions.generationHint') }}</p>
          <div class="ds-fields-row">
            <label class="ds-field">
              <span>{{ $t('settings.dailySuggestions.provider') }}</span>
              <select :value="preferences.providerId || ''" :disabled="saving" @change="onProviderChange">
                <option value="">{{ $t('settings.dailySuggestions.followDefault') }}</option>
                <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
              </select>
            </label>
            <label class="ds-field">
              <span>{{ $t('settings.dailySuggestions.model') }}</span>
              <select :value="preferences.modelId || ''" :disabled="saving || !selectedProvider" @change="onModelChange">
                <option value="">{{ $t('settings.dailySuggestions.followDefault') }}</option>
                <option v-for="model in modelChoices" :key="model" :value="model">{{ model }}</option>
              </select>
            </label>
          </div>
          <div class="ds-status-row">
            <div class="ds-card-copy">
              <span class="ds-card-title ds-sub-title">{{ $t('settings.dailySuggestions.statusTitle') }}</span>
              <p class="ds-card-hint" :class="{ failed: lastGeneration?.status === 'failed' }">{{ lastGenerationLabel }}</p>
            </div>
            <div class="ds-status-actions">
              <button type="button" class="ds-primary-btn" :disabled="generateDisabled" @click="generateNow">
                {{ generating || snapshot?.generating ? $t('settings.dailySuggestions.generating') : $t('settings.dailySuggestions.generateNow') }}
              </button>
              <button
                type="button"
                class="ds-secondary-btn"
                :disabled="replenishDisabled"
                :title="knowledgePoolStatus"
                @click="replenishPool"
              >
                {{ replenishing || knowledgePool?.replenishing ? $t('settings.dailySuggestions.knowledge.poolReplenishing') : $t('settings.dailySuggestions.knowledge.poolReplenishNow') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Daily picks: which cards ∥ scope + cadence, one card ────────────── -->
    <div class="ds-body" :class="{ disabled: !enabled }" :aria-disabled="!enabled">
      <section class="ds-card">
        <div class="ds-split">
          <div class="ds-pane">
            <div class="ds-section-head">
              <span class="ds-card-title">{{ $t('settings.dailySuggestions.typesTitle') }}</span>
              <span class="ds-section-meta">{{ $t('settings.dailySuggestions.typesSelected', { count: preferences.types.length }) }}</span>
            </div>
            <p class="ds-card-hint">{{ $t('settings.dailySuggestions.typesHint') }}</p>
            <div class="ds-opt-grid">
              <button
                v-for="option in typeOptions"
                :key="option.id"
                type="button"
                class="ds-opt-card"
                :class="{ active: preferences.types.includes(option.id) }"
                :disabled="!enabled || saving"
                :aria-pressed="preferences.types.includes(option.id)"
                :title="option.description + ' · ' + $t('settings.dailySuggestions.typeUses', { data: option.uses })"
                @click="toggleType(option.id)"
              >
                <span class="ds-opt-check" aria-hidden="true">{{ preferences.types.includes(option.id) ? '✓' : '' }}</span>
                <span class="ds-opt-copy">
                  <strong><span class="ds-opt-label">{{ option.label }}</span></strong>
                  <small>{{ option.description }}</small>
                </span>
              </button>
            </div>
          </div>
          <div class="ds-pane">
            <span class="ds-card-title">{{ $t('settings.dailySuggestions.contextTitle') }}</span>
            <p class="ds-card-hint">{{ $t('settings.dailySuggestions.contextHint') }}</p>
            <div class="ds-check-grid">
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
            <div class="ds-inline-row">
              <div class="ds-inline-field" :title="$t('settings.dailySuggestions.countHint')">
                <span class="ds-inline-label">{{ $t('settings.dailySuggestions.countTitle') }}</span>
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
              </div>
              <div class="ds-inline-field" :title="$t('settings.dailySuggestions.triggerHint')">
                <span class="ds-inline-label">{{ $t('settings.dailySuggestions.triggerTitle') }}</span>
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
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- ── Knowledge: sources ∥ per-source count + supplement info, one card ── -->
    <div class="ds-body" :class="{ disabled: !knowledgeEnabled }" :aria-disabled="!knowledgeEnabled">
      <section class="ds-card">
        <div class="ds-split">
          <div class="ds-pane">
            <div class="ds-section-head">
              <span class="ds-card-title">{{ $t('settings.dailySuggestions.knowledge.sourcesTitle') }}</span>
              <span class="ds-section-meta">{{ $t('settings.dailySuggestions.typesSelected', { count: knowledge.sources.length }) }}</span>
            </div>
            <p class="ds-card-hint">{{ $t('settings.dailySuggestions.knowledge.sourcesHint') }}</p>
            <p v-if="!hasProviders" class="ds-card-hint ds-inline-warn">{{ $t('settings.dailySuggestions.knowledge.needsProvider') }}</p>
            <div class="ds-opt-grid">
              <button
                v-for="option in knowledgeSourceOptions"
                :key="option.id"
                type="button"
                class="ds-opt-card"
                :class="{ active: knowledge.sources.includes(option.id) }"
                :disabled="!knowledgeEnabled || saving || (option.needsModel && !hasProviders && !knowledge.sources.includes(option.id))"
                :aria-pressed="knowledge.sources.includes(option.id)"
                :title="option.description"
                @click="toggleKnowledgeSource(option.id)"
              >
                <span class="ds-opt-check" aria-hidden="true">{{ knowledge.sources.includes(option.id) ? '✓' : '' }}</span>
                <span class="ds-opt-copy">
                  <strong>
                    <span class="ds-opt-label">{{ option.label }}</span>
                    <em class="ds-opt-flag" :class="{ free: !option.needsModel }">{{ option.needsModel ? $t('settings.dailySuggestions.knowledge.needsModel') : $t('settings.dailySuggestions.knowledge.noModel') }}</em>
                  </strong>
                  <small>{{ option.description }}</small>
                </span>
              </button>
            </div>
          </div>
          <div class="ds-pane">
            <span class="ds-card-title">{{ $t('settings.dailySuggestions.supplementTitle') }}</span>
            <p class="ds-card-hint">{{ $t('settings.dailySuggestions.supplementHint') }}</p>
            <div class="ds-fields">
              <label class="ds-field">
                <span>{{ $t('settings.dailySuggestions.knowledge.professionTitle') }}</span>
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
                <small>{{ $t('settings.dailySuggestions.knowledge.professionHint') }}</small>
              </label>
              <div class="ds-field">
                <span>{{ $t('settings.dailySuggestions.knowledge.interestsTitle') }}</span>
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
                <small :class="{ 'ds-inline-warn': needsInterests }">
                  {{ needsInterests
                    ? $t('settings.dailySuggestions.knowledge.interestsRequired')
                    : $t('settings.dailySuggestions.knowledge.interestsHint', { max: KNOWLEDGE_MAX_INTERESTS }) }}
                </small>
              </div>
            </div>
            <div class="ds-inline-row">
              <div class="ds-inline-field" :title="$t('settings.dailySuggestions.knowledge.countHint')">
                <span class="ds-inline-label">{{ $t('settings.dailySuggestions.knowledge.countTitle') }}</span>
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
              </div>
            </div>
            <p class="ds-card-hint ds-privacy-note">{{ $t('settings.dailySuggestions.knowledge.privacyNote') }}</p>
          </div>
        </div>
      </section>

      <!-- ── Today's preview ∥ pool status, one card ─────────────────────────── -->
      <section v-if="knowledgeCards.length > 0 || knowledgePool" class="ds-card">
        <div class="ds-split">
          <div v-if="knowledgeCards.length > 0" class="ds-pane">
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
          </div>
          <div v-if="knowledgePool" class="ds-pane">
            <span class="ds-card-title">{{ $t('settings.dailySuggestions.knowledge.poolTitle') }}</span>
            <p class="ds-card-hint">{{ knowledgePoolLabel }}</p>
            <p class="ds-card-hint">{{ knowledgeCardsLabel }}</p>
            <p class="ds-card-hint" :class="{ failed: !!knowledgePool.lastReplenishError }">{{ knowledgePoolStatus }}</p>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ds-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
  max-width: 55%;
}

/* ── One card per row; each card splits into a left and a right pane ──── */
.ds-split {
  display: grid;
  /* min(100%, 340px) keeps two panes side by side on wide cards and stacks
     them when the settings window is narrow. */
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
  gap: 12px 32px;
  align-items: stretch;
}

.ds-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.ds-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: opacity 0.16s ease;
}

.ds-body.disabled {
  opacity: 0.55;
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

.ds-sub-title {
  font-size: 0.84rem;
}

/* ── Toggle rows (left pane of the first card) ────────────────────────── */
.ds-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 8px 0;
}

.ds-toggle-row + .ds-toggle-row {
  border-top: 1px solid var(--app-border);
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

/* ── Selectable option cards: one shared style for types and sources ────
   Compact list-item density: title row + one clamped description line; the
   long copy (uses / description) lives on the hover tooltip. */
.ds-opt-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  margin-top: 4px;
}

.ds-opt-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel);
  color: var(--app-text);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}

.ds-opt-card:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border));
}

.ds-opt-card.active {
  border-color: var(--app-accent);
  background: var(--app-accent-soft);
}

.ds-opt-card:disabled {
  cursor: default;
}

.ds-opt-check {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
  border-radius: 5px;
  border: 1px solid var(--app-border-strong);
  font-size: 0.68rem;
  color: #fff;
  background: transparent;
}

.ds-opt-card.active .ds-opt-check {
  background: var(--app-accent);
  border-color: var(--app-accent);
}

.ds-opt-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.ds-opt-copy strong {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 0.82rem;
  color: var(--app-text-strong);
}

.ds-opt-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ds-opt-copy small {
  font-size: 0.72rem;
  color: var(--app-text-soft);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ds-opt-flag {
  flex: 0 0 auto;
  font-style: normal;
  font-size: 0.62rem;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent) 18%, transparent);
  color: var(--app-accent);
}

.ds-opt-flag.free {
  background: transparent;
  color: var(--app-text-faint);
}

/* ── Compact inline settings inside a pane ────────────────────────────── */
.ds-inline-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 14px 32px;
  margin-top: 2px;
  padding-top: 12px;
  border-top: 1px solid var(--app-border);
}

.ds-inline-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ds-inline-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--app-text-soft);
}

.ds-segmented {
  display: inline-grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: min(100%, 180px);
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

.ds-segmented-two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  width: min(100%, 120px);
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
  padding: 4px 8px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-panel);
  color: var(--app-text);
  font-size: 0.82rem;
}

/* ── Context checkboxes ───────────────────────────────────────────────── */
.ds-check-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px 18px;
  margin-top: 2px;
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

/* ── Shared fields (model config, supplement info) ────────────────────── */
.ds-fields-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 14px;
}

.ds-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px 18px;
}

.ds-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.78rem;
  color: var(--app-text-soft);
}

.ds-field > span {
  font-weight: 600;
}

.ds-field small {
  font-size: 0.72rem;
  color: var(--app-text-faint);
  line-height: 1.5;
}

.ds-field select {
  padding: 7px 9px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel);
  color: var(--app-text);
  font-size: 0.82rem;
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

/* ── Buttons ──────────────────────────────────────────────────────────── */
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

.ds-secondary-btn {
  flex: 0 0 auto;
  min-height: 34px;
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

/* ── Status row: text left, actions right ─────────────────────────────── */
.ds-status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 18px;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--app-border);
}

.ds-status-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ── Today's knowledge cards ──────────────────────────────────────────── */
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
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel);
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
  color: var(--app-accent);
}

.ds-today-title {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--app-text-strong);
}

.ds-inline-warn {
  color: #b45309;
}

/* ── Interest tags ────────────────────────────────────────────────────── */
.ds-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ds-tags:empty {
  display: none;
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

.ds-privacy-note {
  margin-top: 2px;
  padding-top: 10px;
  border-top: 1px solid var(--app-border);
  font-size: 0.74rem;
}
</style>
