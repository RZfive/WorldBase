<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DailySuggestionSnapshot, WorkSuggestion } from '../../../../shared/daily-suggestion-types.js'

/**
 * Chat empty state rendered as one "hand" of cards. Today's LLM picks (opt-in),
 * the knowledge hooks and the weekly capability tips sit side by side in a
 * fanned row; hovering a card lifts it and spreads its neighbours, like picking
 * a card from a hand. Picking a card hands the resolved prompt + scene to the
 * container, which applies composer toggles and fills the message.
 *
 * With no provider configured at all, a non-dismissable setup card leads the
 * hand and takes the user straight to the recommended provider template.
 */
const props = defineProps<{
  snapshot: DailySuggestionSnapshot | null
  loading?: boolean
  refreshing?: boolean
  shuffling?: boolean
  projectNames?: Record<string, string>
  /** True once the provider list is known to be empty. */
  providersMissing?: boolean
}>()

const emit = defineEmits<{
  (e: 'pick', suggestion: WorkSuggestion, payload: { prompt: string; projectName?: string }): void
  (e: 'dismiss', suggestion: WorkSuggestion): void
  (e: 'refresh'): void
  (e: 'refreshCard', suggestion: WorkSuggestion): void
  (e: 'shuffle'): void
  (e: 'openSettings'): void
  (e: 'setupProvider', mode: 'recommended' | 'browse'): void
  (e: 'seen'): void
}>()

const { t, te } = useI18n()

const MAX_CARDS = 9
const MAX_DAILY_CARDS = 5
const MAX_KNOWLEDGE_CARDS = 3
const CARD_WIDTH = 208
const MIN_OVERLAP = 28
const SPREAD = 34

type CardGroup = 'daily' | 'explore' | 'knowledge'

type HandCard =
  | { kind: 'item'; id: string; item: WorkSuggestion; group: CardGroup }
  | { kind: 'enable'; id: 'enable' }
  | { kind: 'setup'; id: 'setup' }

// Hover is tracked by hand slot, not card id: the ↻ tool swaps a knowledge
// card for a new id, and an id-keyed hover would drop the lift the moment the
// snapshot lands (no mouseenter refires on a stationary cursor).
const hoveredIndex = ref(-1)
const seenTimer = ref<number | null>(null)
const handRef = ref<HTMLElement | null>(null)
const handWidth = ref(0)
let handObserver: ResizeObserver | null = null

const preferences = computed(() => props.snapshot?.preferences ?? null)
const dailyEnabled = computed(() => preferences.value?.enabled === true)
const knowledgeEnabled = computed(() => preferences.value?.knowledge?.enabled === true)
/** Knowledge sources that need a model — they make the knowledge group refreshable. */
const knowledgeModelOn = computed(() => {
  const sources = preferences.value?.knowledge?.sources ?? []
  return knowledgeEnabled.value && sources.some(source => source !== 'random')
})
const dailyItems = computed(() => (props.snapshot?.daily ?? []).slice(0, MAX_DAILY_CARDS))
const knowledgeItems = computed(() => (props.snapshot?.knowledge ?? []).slice(0, MAX_KNOWLEDGE_CARDS))
const exploreItems = computed(() => props.snapshot?.explore ?? [])
const hasFreshDaily = computed(() => dailyItems.value.some(item => item.fresh) || knowledgeItems.value.some(item => item.fresh))
const generating = computed(() => props.snapshot?.generating === true || props.refreshing === true)
const lastGeneration = computed(() => props.snapshot?.lastGeneration ?? null)
const refreshDisabled = computed(() => generating.value)
const shuffleDisabled = computed(() => props.shuffling === true)
const todayDiscipline = computed(() => {
  const random = knowledgeItems.value.find(item => item.knowledge?.source === 'random')
  return random ? disciplineLabel(random) : ''
})

/** Setup card first (when no provider), then daily picks, knowledge hooks, weekly tips, then (when opted out) a ghost card that opens Settings. */
const cards = computed<HandCard[]>(() => {
  const list: HandCard[] = []
  if (props.providersMissing) list.push({ kind: 'setup', id: 'setup' })
  for (const item of dailyItems.value) list.push({ kind: 'item', id: item.id, item, group: 'daily' })
  for (const item of knowledgeItems.value) list.push({ kind: 'item', id: item.id, item, group: 'knowledge' })
  const exploreBudget = Math.max(0, MAX_CARDS - list.length - (dailyEnabled.value ? 0 : 1))
  for (const item of exploreItems.value.slice(0, exploreBudget)) {
    list.push({ kind: 'item', id: item.id, item, group: 'explore' })
  }
  if (!dailyEnabled.value && props.snapshot) list.push({ kind: 'enable', id: 'enable' })
  return list
})

/** Horizontal step between card origins so the whole hand, plus its hover spread, fits the strip. */
const cardStep = computed(() => {
  const count = cards.value.length
  if (count <= 1 || handWidth.value <= 0) return CARD_WIDTH
  const fit = Math.floor((handWidth.value - CARD_WIDTH - SPREAD * 2) / (count - 1))
  return Math.max(48, Math.min(CARD_WIDTH - MIN_OVERLAP, fit))
})

const handStyle = computed(() => {
  const count = cards.value.length
  const width = count === 0 ? 0 : CARD_WIDTH + cardStep.value * (count - 1)
  return { width: `${width}px`, height: '176px' }
})

function cardStyle (index: number): Record<string, string> {
  const count = cards.value.length
  const mid = (count - 1) / 2
  const offset = index - mid
  const hovered = hoveredIndex.value
  let x = index * cardStep.value
  let y = Math.abs(offset) * 4
  let rotate = offset * 2.4
  let scale = 1
  let z = index + 1
  if (hovered >= 0) {
    if (index === hovered) {
      y = -22
      rotate = 0
      scale = 1.05
      z = count + 10
    } else {
      x += index < hovered ? -SPREAD : SPREAD
      z = index < hovered ? index + 1 : count - index
    }
  }
  return {
    transform: `translate(${x}px, ${y}px) rotate(${rotate}deg) scale(${scale})`,
    zIndex: String(z)
  }
}

const weekThemeLabel = computed(() => {
  const theme = props.snapshot?.weekTheme
  if (!theme) return ''
  const key = `chatUi.suggestions.themes.${theme}`
  return te(key) ? t(key) : theme
})

const dailyStatusLine = computed(() => {
  if (!dailyEnabled.value) return ''
  if (generating.value) return t('chatUi.suggestions.generating')
  if (dailyItems.value.length > 0) return ''
  // The setup card already says there is no provider; do not say it twice.
  if (props.snapshot?.providerMissing) return props.providersMissing ? '' : t('chatUi.suggestions.providerMissing')
  if (lastGeneration.value?.status === 'failed') return t('chatUi.suggestions.generationFailed')
  return t('chatUi.suggestions.dailyEmpty')
})

function resolveText (item: WorkSuggestion, field: 'title' | 'description' | 'prompt'): string {
  const raw = item[field]
  if (!raw) return ''
  if (item.source === 'static') return te(raw) ? t(raw) : raw
  return raw
}

function typeLabel (item: WorkSuggestion): string {
  const key = `chatUi.suggestions.types.${item.type}.label`
  return te(key) ? t(key) : String(item.type)
}

function featureLabel (item: WorkSuggestion): string {
  if (!item.featureTag) return ''
  const key = `chatUi.suggestions.features.${item.featureTag}`
  return te(key) ? t(key) : item.featureTag
}

function knowledgeSourceLabel (item: WorkSuggestion): string {
  const source = item.knowledge?.source
  if (!source) return t('chatUi.suggestions.knowledgeTitle')
  const key = `chatUi.suggestions.knowledgeSources.${source}.label`
  return te(key) ? t(key) : source
}

/** Seed disciplines (built-in or generated) are keys; model-written disciplines are literal text. */
function disciplineLabel (item: WorkSuggestion): string {
  const discipline = item.knowledge?.discipline
  if (!discipline) return ''
  const key = `chatUi.suggestions.disciplines.${discipline}`
  return te(key) ? t(key) : discipline
}

function chipLabel (card: Extract<HandCard, { kind: 'item' }>): string {
  if (card.group === 'daily') return typeLabel(card.item)
  if (card.group === 'knowledge') return knowledgeSourceLabel(card.item)
  return featureLabel(card.item) || t('chatUi.suggestions.exploreTitle')
}

function projectName (projectId?: string): string | undefined {
  if (!projectId) return undefined
  return props.projectNames?.[projectId] || projectId
}

/** Human-readable list of what picking a card will switch on. */
function sceneSummary (item: WorkSuggestion): string {
  const scene = item.scene
  if (!scene) return ''
  const parts: string[] = []
  if (scene.targetProjectId) parts.push(t('chatUi.suggestions.sceneProject', { name: projectName(scene.targetProjectId) || '' }))
  if (scene.planMode) parts.push(t('chatUi.suggestions.scenePlanMode'))
  if (scene.computerUse) parts.push(t('chatUi.suggestions.sceneComputerUse'))
  if (scene.authMode === 'auto') parts.push(t('chatUi.suggestions.sceneAutoMode'))
  if (scene.authMode === 'strict') parts.push(t('chatUi.suggestions.sceneStrictMode'))
  if (parts.length === 0) return ''
  return t('chatUi.suggestions.sceneWillEnable', { items: parts.join(' · ') })
}

function pick (item: WorkSuggestion): void {
  emit('pick', item, {
    prompt: resolveText(item, 'prompt'),
    projectName: projectName(item.scene?.targetProjectId)
  })
}

function dismiss (event: Event, index: number, item: WorkSuggestion): void {
  event.stopPropagation()
  if (hoveredIndex.value === index) hoveredIndex.value = -1
  emit('dismiss', item)
}

function shuffle (event: Event): void {
  event.stopPropagation()
  if (shuffleDisabled.value) return
  emit('shuffle')
}

function refreshCard (event: Event, item: WorkSuggestion): void {
  event.stopPropagation()
  if (shuffleDisabled.value) return
  emit('refreshCard', item)
}

function setupProvider (event: Event, mode: 'recommended' | 'browse'): void {
  event.stopPropagation()
  emit('setupProvider', mode)
}

function leaveCard (index: number): void {
  if (hoveredIndex.value === index) hoveredIndex.value = -1
}

function scheduleSeen (): void {
  if (seenTimer.value != null) window.clearTimeout(seenTimer.value)
  if (!hasFreshDaily.value) return
  // The "new" badge stays for the visit that revealed it, then clears.
  seenTimer.value = window.setTimeout(() => {
    seenTimer.value = null
    emit('seen')
  }, 4000)
}

watch(hasFreshDaily, (fresh) => {
  if (fresh) scheduleSeen()
}, { immediate: true })

function measureHand (): void {
  const el = handRef.value
  if (!el) return
  handWidth.value = el.clientWidth
}

onMounted(() => {
  scheduleSeen()
  measureHand()
  if (typeof ResizeObserver !== 'undefined' && handRef.value) {
    handObserver = new ResizeObserver(() => measureHand())
    handObserver.observe(handRef.value)
  }
})

onBeforeUnmount(() => {
  if (seenTimer.value != null) window.clearTimeout(seenTimer.value)
  handObserver?.disconnect()
  handObserver = null
})
</script>

<template>
  <div class="ess-root">
    <div class="ess-strip-head">
      <div class="ess-strip-title">
        <template v-if="dailyEnabled">
          <span class="ess-strip-name">{{ $t('chatUi.suggestions.dailyTitle') }}</span>
          <span v-if="hasFreshDaily" class="ess-badge-new">{{ $t('chatUi.suggestions.badgeNew') }}</span>
          <span class="ess-strip-sep" aria-hidden="true">·</span>
        </template>
        <span class="ess-strip-name" :class="{ soft: dailyEnabled }">{{ $t('chatUi.suggestions.exploreTitle') }}</span>
        <span v-if="weekThemeLabel" class="ess-strip-theme">{{ $t('chatUi.suggestions.weekTheme', { theme: weekThemeLabel }) }}</span>
        <template v-if="knowledgeEnabled && knowledgeItems.length > 0">
          <span class="ess-strip-sep" aria-hidden="true">·</span>
          <span class="ess-strip-name soft">{{ $t('chatUi.suggestions.knowledgeTitle') }}</span>
          <span v-if="todayDiscipline" class="ess-strip-theme">{{ $t('chatUi.suggestions.knowledgeToday', { discipline: todayDiscipline }) }}</span>
        </template>
      </div>
      <div v-if="dailyEnabled || knowledgeModelOn" class="ess-strip-actions">
        <span v-if="generating" class="ess-generating">
          <span class="ess-spinner" aria-hidden="true" />
          {{ $t('chatUi.suggestions.generating') }}
        </span>
        <button
          v-else
          type="button"
          class="ess-link-btn"
          :disabled="refreshDisabled"
          :title="$t('chatUi.suggestions.refreshHint')"
          @click="emit('refresh')"
        >
          {{ $t('chatUi.suggestions.refresh') }}
        </button>
        <button type="button" class="ess-link-btn" @click="emit('openSettings')">{{ $t('chatUi.suggestions.settings') }}</button>
      </div>
    </div>

    <p v-if="dailyStatusLine && !generating" class="ess-status-line">{{ dailyStatusLine }}</p>

    <div ref="handRef" class="ess-hand-viewport" @mouseleave="hoveredIndex = -1">
      <div class="ess-hand" :style="handStyle">
        <!-- Key by hand slot, not item id: the ↻ refresh swaps a card for a
             new id, and an id-keyed node would unmount/remount — dropping the
             hover chain (and any focus) so the card visibly collapsed back
             into the fan. Slot keys patch the same node in place. -->
        <template v-for="(card, index) in cards" :key="`${index}-${card.kind}`">
          <button
            v-if="card.kind === 'item'"
            type="button"
            class="ess-card"
            :class="{ lifted: hoveredIndex === index, fresh: card.item.fresh, daily: card.group === 'daily', knowledge: card.group === 'knowledge' }"
            :style="cardStyle(index)"
            :title="sceneSummary(card.item)"
            @mouseenter="hoveredIndex = index"
            @focus="hoveredIndex = index"
            @blur="leaveCard(index)"
            @click="pick(card.item)"
          >
            <span class="ess-card-top">
              <span class="ess-chip" :class="card.group">{{ chipLabel(card) }}</span>
              <span v-if="card.group === 'daily' && card.item.source === 'static'" class="ess-chip muted">{{ $t('chatUi.suggestions.staticFallback') }}</span>
            </span>
            <span class="ess-card-title">{{ resolveText(card.item, 'title') }}</span>
            <span class="ess-card-desc">{{ resolveText(card.item, 'description') }}</span>
            <span class="ess-card-foot">
              <span v-if="card.group === 'knowledge' && disciplineLabel(card.item)" class="ess-foot-tag knowledge">{{ disciplineLabel(card.item) }}</span>
              <span v-else-if="card.item.scene?.targetProjectId" class="ess-foot-tag">{{ projectName(card.item.scene.targetProjectId) }}</span>
              <span v-else-if="card.group === 'daily' && featureLabel(card.item)" class="ess-foot-tag">{{ featureLabel(card.item) }}</span>
              <span v-if="sceneSummary(card.item)" class="ess-scene">{{ sceneSummary(card.item) }}</span>
            </span>
            <span class="ess-card-tools">
              <span
                v-if="card.group === 'knowledge'"
                class="ess-tool"
                :class="{ disabled: shuffleDisabled }"
                role="button"
                :aria-disabled="shuffleDisabled"
                :aria-label="$t('chatUi.suggestions.shuffle')"
                :title="$t('chatUi.suggestions.shuffleHint')"
                @click="card.item.knowledge?.source === 'random' ? shuffle($event) : refreshCard($event, card.item)"
              >↻</span>
              <span
                class="ess-tool"
                role="button"
                :aria-label="$t('chatUi.suggestions.dismiss')"
                :title="$t('chatUi.suggestions.dismiss')"
                @click="dismiss($event, index, card.item)"
              >×</span>
            </span>
          </button>

          <button
            v-else-if="card.kind === 'setup'"
            type="button"
            class="ess-card ess-card-setup"
            :class="{ lifted: hoveredIndex === index }"
            :style="cardStyle(index)"
            @mouseenter="hoveredIndex = index"
            @focus="hoveredIndex = index"
            @blur="leaveCard(index)"
            @click="setupProvider($event, 'recommended')"
          >
            <span class="ess-chip setup">{{ $t('chatUi.onboarding.noProvider.chip') }}</span>
            <span class="ess-card-title">{{ $t('chatUi.onboarding.noProvider.title') }}</span>
            <span class="ess-card-desc">{{ $t('chatUi.onboarding.noProvider.body') }}</span>
            <span class="ess-card-foot ess-setup-foot">
              <span class="ess-setup-cta">{{ $t('chatUi.onboarding.noProvider.cta') }}</span>
              <span class="ess-setup-other" role="button" @click="setupProvider($event, 'browse')">{{ $t('chatUi.onboarding.noProvider.other') }}</span>
            </span>
          </button>

          <button
            v-else
            type="button"
            class="ess-card ess-card-enable"
            :class="{ lifted: hoveredIndex === index }"
            :style="cardStyle(index)"
            @mouseenter="hoveredIndex = index"
            @focus="hoveredIndex = index"
            @blur="leaveCard(index)"
            @click="emit('openSettings')"
          >
            <span class="ess-enable-glyph" aria-hidden="true">＋</span>
            <span class="ess-card-title">{{ $t('chatUi.suggestions.enableCtaTitle') }}</span>
            <span class="ess-card-desc">{{ $t('chatUi.suggestions.enableCtaDesc') }}</span>
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ess-root {
  width: min(820px, 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
  color: var(--app-text);
}

/* ── Strip header ─────────────────────────────────────────────────────── */
.ess-strip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 6px;
}

.ess-strip-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex-wrap: wrap;
}

.ess-strip-name {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--app-text-soft);
  letter-spacing: 0.02em;
}

.ess-strip-name.soft {
  font-weight: 500;
  color: var(--app-text-muted);
}

.ess-strip-sep {
  color: var(--app-text-faint);
}

.ess-strip-theme {
  font-size: 0.72rem;
  color: var(--app-text-faint);
}

.ess-badge-new {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--app-accent);
  color: #fff;
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.ess-strip-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.ess-link-btn {
  padding: 4px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text-muted);
  font-size: 0.74rem;
  cursor: pointer;
}

.ess-link-btn:hover:not(:disabled) {
  background: var(--app-panel-subtle);
  color: var(--app-text);
}

.ess-link-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

.ess-generating {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.74rem;
  color: var(--app-text-muted);
}

.ess-spinner {
  width: 11px;
  height: 11px;
  border-radius: 999px;
  border: 2px solid color-mix(in srgb, var(--app-accent) 30%, transparent);
  border-top-color: var(--app-accent);
  animation: ess-spin 0.9s linear infinite;
}

@keyframes ess-spin {
  to { transform: rotate(360deg); }
}

.ess-status-line {
  margin: -4px 0 0;
  padding: 0 6px;
  font-size: 0.76rem;
  color: var(--app-text-muted);
}

/* ── Hand ─────────────────────────────────────────────────────────────── */
.ess-hand-viewport {
  display: flex;
  justify-content: center;
  padding: 28px 8px 8px;
  overflow: visible;
}

.ess-hand {
  position: relative;
  max-width: 100%;
}

.ess-card {
  position: absolute;
  top: 0;
  left: 0;
  width: 208px;
  height: 148px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  padding: 12px 14px 11px;
  border: 1px solid color-mix(in srgb, var(--app-border-strong) 70%, transparent);
  border-radius: 16px;
  /* Opaque base + tint layers. The tints below use `background-image` so
     they never reset this colour: the earlier `background:` shorthands mixed
     a low-alpha accent into the panel and the fanned cards behind bled
     through as ghost text. No backdrop-filter here on purpose (8+ moving
     blurred layers spiked GPU power on every hover frame). */
  --ess-card-base: #ffffff;
  background-color: var(--ess-card-base);
  background-image:
    linear-gradient(160deg, rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0.04)),
    linear-gradient(color-mix(in srgb, var(--app-panel) 96%, transparent), color-mix(in srgb, var(--app-panel) 96%, transparent));
  color: var(--app-text);
  text-align: left;
  cursor: pointer;
  transform-origin: 50% 100%;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.45),
    0 6px 18px rgba(15, 23, 42, 0.08);
  transition:
    transform 0.26s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.26s ease,
    border-color 0.2s ease;
  will-change: transform;
}

.ess-card.daily {
  background-image:
    linear-gradient(160deg, rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0.04)),
    linear-gradient(color-mix(in srgb, var(--app-accent-soft) 40%, color-mix(in srgb, var(--app-panel) 96%, transparent)), color-mix(in srgb, var(--app-accent-soft) 40%, color-mix(in srgb, var(--app-panel) 96%, transparent)));
}

.ess-card.lifted {
  border-color: color-mix(in srgb, var(--app-accent) 60%, var(--app-border-strong));
  background-image:
    linear-gradient(160deg, rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0.06)),
    linear-gradient(color-mix(in srgb, var(--app-panel) 98%, transparent), color-mix(in srgb, var(--app-panel) 98%, transparent));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.55),
    0 22px 40px rgba(15, 23, 42, 0.18);
}

/* The app always stamps the resolved theme on <html>, so one dark selector suffices. */
:root[data-theme='dark'] .ess-card {
  /* rgba(15,23,42,.92) panel flattened onto the #0b1018 surface. */
  --ess-card-base: #0f1629;
  border-color: color-mix(in srgb, var(--app-border-strong) 80%, transparent);
  background-image:
    linear-gradient(160deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.015)),
    linear-gradient(color-mix(in srgb, var(--app-panel) 96%, transparent), color-mix(in srgb, var(--app-panel) 96%, transparent));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.12),
    0 6px 18px rgba(0, 0, 0, 0.28);
}

:root[data-theme='dark'] .ess-card.daily {
  background-image:
    linear-gradient(160deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.015)),
    linear-gradient(color-mix(in srgb, var(--app-accent-soft) 35%, color-mix(in srgb, var(--app-panel) 96%, transparent)), color-mix(in srgb, var(--app-accent-soft) 35%, color-mix(in srgb, var(--app-panel) 96%, transparent)));
}

:root[data-theme='dark'] .ess-card.lifted {
  background-image:
    linear-gradient(160deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.02)),
    linear-gradient(color-mix(in srgb, var(--app-panel) 98%, transparent), color-mix(in srgb, var(--app-panel) 98%, transparent));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    0 22px 40px rgba(0, 0, 0, 0.45);
}

.ess-card:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--app-accent) 60%, transparent);
  outline-offset: 2px;
}

.ess-card.fresh::before {
  content: '';
  position: absolute;
  top: 12px;
  right: 34px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--app-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 22%, transparent);
}

.ess-card-top {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding-right: 22px;
}

.ess-chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--app-panel-subtle);
  color: var(--app-text-soft);
  font-size: 0.64rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.ess-chip.daily {
  background: var(--app-accent-soft);
  color: var(--app-accent);
}

.ess-chip.muted {
  font-weight: 500;
  color: var(--app-text-faint);
}

.ess-card-title {
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--app-text-strong);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.ess-card-desc {
  font-size: 0.72rem;
  color: var(--app-text-muted);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.ess-card-foot {
  margin-top: auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 0;
}

.ess-foot-tag {
  font-size: 0.66rem;
  font-weight: 600;
  color: var(--app-accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ess-scene {
  font-size: 0.64rem;
  color: var(--app-text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-height: 0;
  opacity: 0;
  transition: max-height 0.2s ease, opacity 0.2s ease;
}

.ess-card.lifted .ess-scene {
  max-height: 16px;
  opacity: 1;
}

.ess-dismiss {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--app-text-faint);
  font-size: 0.95rem;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.12s ease, background 0.12s ease;
}

.ess-card.lifted .ess-dismiss {
  opacity: 1;
}

.ess-dismiss:hover {
  background: var(--app-panel-subtle);
  color: var(--app-text);
}

/* Per-card tools (shuffle, dismiss) in the top-right corner, shown on lift. */
.ess-card-tools {
  position: absolute;
  top: 7px;
  right: 7px;
  display: inline-flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.ess-card.lifted .ess-card-tools {
  opacity: 1;
}

.ess-tool {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--app-text-faint);
  font-size: 0.95rem;
  line-height: 1;
  transition: background 0.12s ease, color 0.12s ease;
}

.ess-tool:hover {
  background: var(--app-panel-subtle);
  color: var(--app-text);
}

.ess-tool.disabled {
  opacity: 0.4;
  cursor: default;
}

.ess-tool.disabled:hover {
  background: transparent;
  color: var(--app-text-faint);
}

/* Knowledge cards: a warm tint so the group reads apart from tasks and tips. */
.ess-card.knowledge {
  background-image:
    linear-gradient(160deg, rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0.04)),
    linear-gradient(color-mix(in srgb, #f59e0b 12%, color-mix(in srgb, var(--app-panel) 84%, transparent)), color-mix(in srgb, #f59e0b 12%, color-mix(in srgb, var(--app-panel) 84%, transparent)));
}

:root[data-theme='dark'] .ess-card.knowledge {
  background-image:
    linear-gradient(160deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.015)),
    linear-gradient(color-mix(in srgb, #f59e0b 14%, color-mix(in srgb, var(--app-panel) 80%, transparent)), color-mix(in srgb, #f59e0b 14%, color-mix(in srgb, var(--app-panel) 80%, transparent)));
}

.ess-card.knowledge .ess-card-title {
  font-size: 0.9rem;
}

.ess-chip.knowledge {
  background: color-mix(in srgb, #f59e0b 18%, transparent);
  color: color-mix(in srgb, #b45309 85%, var(--app-text));
}

:root[data-theme='dark'] .ess-chip.knowledge {
  color: #fbbf24;
}

.ess-foot-tag.knowledge {
  color: color-mix(in srgb, #b45309 80%, var(--app-text));
}

:root[data-theme='dark'] .ess-foot-tag.knowledge {
  color: #fbbf24;
}

/* Setup card: no provider yet. Leads the hand and cannot be dismissed. */
.ess-card-setup {
  border-style: solid;
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  background-image:
    linear-gradient(160deg, rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0.04)),
    linear-gradient(color-mix(in srgb, var(--app-accent-soft) 70%, color-mix(in srgb, var(--app-panel) 84%, transparent)), color-mix(in srgb, var(--app-accent-soft) 70%, color-mix(in srgb, var(--app-panel) 84%, transparent)));
}

.ess-chip.setup {
  background: var(--app-accent);
  color: #fff;
}

.ess-setup-foot {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ess-setup-cta {
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--app-accent);
}

.ess-setup-other {
  font-size: 0.66rem;
  color: var(--app-text-muted);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.ess-setup-other:hover {
  color: var(--app-text);
}

/* Ghost card that opens Settings when daily picks are off. */
.ess-card-enable {
  justify-content: center;
  align-items: center;
  text-align: center;
  gap: 6px;
  border-style: dashed;
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border));
  background-image:
    linear-gradient(160deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.02)),
    linear-gradient(color-mix(in srgb, var(--app-accent-soft) 50%, color-mix(in srgb, var(--app-panel) 80%, transparent)), color-mix(in srgb, var(--app-accent-soft) 50%, color-mix(in srgb, var(--app-panel) 80%, transparent)));
}

@media (max-width: 720px) {
  .ess-hand-viewport {
    padding-top: 22px;
  }
}

.ess-card-enable .ess-card-title {
  color: var(--app-accent);
  text-align: center;
}

.ess-card-enable .ess-card-desc {
  text-align: center;
  -webkit-line-clamp: 3;
}

.ess-enable-glyph {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--app-accent);
  color: #fff;
  font-size: 0.9rem;
  line-height: 1;
}
</style>
