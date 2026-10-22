<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CODING_STOP_REASON_LABEL_KEYS,
  isCodingStatusActive,
  isCodingStatusRetryable,
  type CodingCommandOutcome,
  type CodingStatus,
} from '../../../../shared/coding-status-types.js'
import ProviderModelDropdown from './ProviderModelDropdown.vue'
import ProviderDropdown from './ProviderDropdown.vue'

interface ChannelBindingOption {
  id: string
  connectorType: string
  externalChannelId: string
}

interface ProviderItem {
  id: string
  name: string
  models: string[]
}

interface AgentOption {
  id: string
  name: string
  icon?: string
}

type ReasoningStrength = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

const props = defineProps<{
  contextLabel: string
  contextDetail: string
  availableChannelBindings: ChannelBindingOption[]
  selectedChannelBindingId: string
  providers?: ProviderItem[]
  activeProviderId?: string
  selectedModel?: string
  showProviderSelector?: boolean
  reasoningStrength?: ReasoningStrength
  /** Levels the active model declares; rendered as the strength control's choices. */
  reasoningEffortOptions?: string[]
  temperature?: number | null
  providerDefaultTemperature?: number
  isGroupConversation?: boolean
  /** New-conversation agent switcher, pinned next to the agent name (design v1.7). */
  showAgentSelector?: boolean
  availableAgents?: AgentOption[]
  selectedAgentId?: string
  /** Latest coding run status for the conversation, if any. */
  codingStatus?: CodingStatus | null
  codingDiffFileCount?: number
  codingLoading?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:selected-channel-binding-id', channelBindingId: string): void
  (e: 'selectProviderModel', selection: { providerId: string; model: string }): void
  (e: 'update:reasoning-strength', value: ReasoningStrength): void
  (e: 'update:temperature', value: number | null): void
  (e: 'update:selected-agent-id', id: string): void
  (e: 'openCodingDiagnostics'): void
  (e: 'openCodingDiff'): void
  (e: 'cancelCoding'): void
  (e: 'retryCoding'): void
}>()

function onChannelBindingChange (event: Event) {
  emit('update:selected-channel-binding-id', (event.target as HTMLSelectElement).value)
}

const showAgentPicker = computed(() => Boolean(
  props.showAgentSelector &&
  props.availableAgents &&
  props.availableAgents.length > 0
))

// The trigger reads the selected agent (falling back to the default agent
// label) instead of a static prompt, so the header states who will answer.
const { t } = useI18n()
const agentPickerLabel = computed(() => {
  if (props.selectedAgentId) {
    const found = (props.availableAgents || []).find(agent => agent.id === props.selectedAgentId)
    if (found) return (found.icon ? found.icon + ' ' : '') + found.name
  }
  return t('chatUi.defaultAgent')
})

// The right-side provider pill already shows the model identity — only keep
// the detail line when it carries unique info (goal status, group size).
const showContextDetail = computed(() => Boolean(
  props.contextDetail &&
  !showAgentPicker.value &&
  !(props.showProviderSelector && props.providers && props.providers.length > 0)
))

const CODING_PHASE_LABEL_KEYS: Record<CodingStatus['phase'], string> = {
  idle: 'chatUi.codingPhaseIdle',
  plan: 'chatUi.codingPhasePlan',
  inspect: 'chatUi.codingPhaseInspect',
  edit: 'chatUi.codingPhaseEdit',
  verify: 'chatUi.codingPhaseVerify',
  diagnose: 'chatUi.codingPhaseDiagnose',
  repair: 'chatUi.codingPhaseRepair',
  complete: 'chatUi.codingPhaseComplete',
  blocked: 'chatUi.codingPhaseBlocked',
}

const codingPillRef = ref<HTMLElement | null>(null)
const codingPopoverOpen = ref(false)

const showCodingPill = computed(() => Boolean(
  props.codingStatus && props.codingStatus.phase !== 'idle'
))
const codingPhaseLabel = computed(() => (
  props.codingStatus ? t(CODING_PHASE_LABEL_KEYS[props.codingStatus.phase]) : ''
))
const codingErrorCount = computed(() => (
  props.codingStatus?.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length ?? 0
))
const codingRepairRound = computed(() => props.codingStatus?.repairRound ?? 0)
const codingMaxRepairRounds = computed(() => props.codingStatus?.maxRepairRounds ?? 0)
const codingDiffCount = computed(() => Math.max(0, props.codingDiffFileCount ?? 0))
const codingLatestCommand = computed<CodingCommandOutcome | null>(() => {
  const commands = props.codingStatus?.commands ?? []
  return commands[commands.length - 1] ?? null
})
const codingActive = computed(() => isCodingStatusActive(props.codingStatus))
const codingPulsing = computed(() => props.codingLoading === true && codingActive.value)
const canCancelCoding = computed(() => props.codingLoading === true && codingActive.value)
const canRetryCoding = computed(
  () => props.codingLoading !== true && isCodingStatusRetryable(props.codingStatus),
)
const codingStopReasonLabel = computed(() => {
  const reason = props.codingStatus?.stopReason
  if (!reason) {
    return t(codingActive.value ? 'chatUi.codingAwaitingVerification' : 'chatUi.codingAllClear')
  }
  const key = CODING_STOP_REASON_LABEL_KEYS[reason]
  return key ? t(key) : reason
})
const codingDotClass = computed(() => {
  const phase = props.codingStatus?.phase
  if (phase === 'complete') return 'is-complete'
  if (phase === 'blocked') return 'is-blocked'
  if (phase === 'repair') return 'is-repair'
  if (phase === 'verify' || phase === 'diagnose') return 'is-active'
  return ''
})
const codingPillMeta = computed(() => {
  if (codingErrorCount.value > 0) {
    return t('chatUi.codingErrorsCount', { count: codingErrorCount.value })
  }
  if (codingMaxRepairRounds.value > 0) {
    return t('chatUi.codingRepairRound', {
      current: codingRepairRound.value,
      max: codingMaxRepairRounds.value,
    })
  }
  return ''
})

function formatCodingCommand (command: CodingCommandOutcome): string {
  const parts = [command.program, ...command.args].filter(part => part.length > 0)
  return parts.length > 0 ? parts.join(' ') : '—'
}

function formatCodingDuration (durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—'
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`
}

function toggleCodingPopover (): void {
  if (!showCodingPill.value) return
  codingPopoverOpen.value = !codingPopoverOpen.value
}

function openCodingDiagnostics (): void {
  codingPopoverOpen.value = false
  emit('openCodingDiagnostics')
}

function openCodingDiff (): void {
  if (codingDiffCount.value === 0) return
  codingPopoverOpen.value = false
  emit('openCodingDiff')
}

function cancelCoding (): void {
  if (!canCancelCoding.value) return
  codingPopoverOpen.value = false
  emit('cancelCoding')
}

function retryCoding (): void {
  if (!canRetryCoding.value) return
  codingPopoverOpen.value = false
  emit('retryCoding')
}

function onDocumentClick (event: MouseEvent): void {
  if (!codingPopoverOpen.value) return
  if (codingPillRef.value?.contains(event.target as Node)) return
  codingPopoverOpen.value = false
}

function onDocumentKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape') codingPopoverOpen.value = false
}

watch(showCodingPill, (visible) => {
  if (!visible) codingPopoverOpen.value = false
})

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick, true)
  document.removeEventListener('keydown', onDocumentKeydown)
})
</script>

<template>
  <div class="chat-header">
    <div class="chat-header-copy">
      <!-- Agent capsule: a picker for new conversations, a subdued badge once
           the conversation is bound (design v1.7). -->
      <div v-if="showAgentPicker" class="header-agent-picker">
        <ProviderDropdown
          :model-value="selectedAgentId || ''"
          :options="[{ value: '', label: $t('chatUi.defaultAgent') }, ...(availableAgents || []).map(a => ({ value: a.id, label: (a.icon ? a.icon + ' ' : '') + a.name }))]"
          :title="agentPickerLabel"
          @update:model-value="emit('update:selected-agent-id', $event)"
        />
      </div>
      <div v-else class="header-agent-badge">
        <span class="header-agent-badge-label">{{ contextLabel }}</span>
      </div>

      <!-- The model identity lives in the right-side provider pill; only show
           the detail line when it carries unique info (goal/group status). -->
      <template v-if="showContextDetail">
        <span class="header-meta-separator" aria-hidden="true">·</span>
        <p :title="contextDetail">{{ contextDetail }}</p>
      </template>
    </div>

    <div class="header-controls">
      <div v-if="showCodingPill" ref="codingPillRef" class="header-coding">
        <button
          class="header-coding-pill"
          :class="{ open: codingPopoverOpen }"
          type="button"
          aria-haspopup="dialog"
          :aria-expanded="codingPopoverOpen"
          :aria-controls="codingPopoverOpen ? 'header-coding-popover' : undefined"
          :title="`${codingPhaseLabel}${codingPillMeta ? ' · ' + codingPillMeta : ''}`"
          @click.stop="toggleCodingPopover"
        >
          <span
            class="header-coding-dot"
            :class="[codingDotClass, { 'is-pulsing': codingPulsing }]"
            aria-hidden="true"
          />
          <span class="header-coding-phase">{{ codingPhaseLabel }}</span>
          <span v-if="codingPillMeta" class="header-coding-meta">{{ codingPillMeta }}</span>
          <svg
            class="header-coding-caret"
            :class="{ 'is-open': codingPopoverOpen }"
            width="9"
            height="9"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>

        <div
          v-if="codingPopoverOpen"
          id="header-coding-popover"
          class="header-coding-popover"
          role="dialog"
          :aria-label="$t('chatUi.codingStatusAria')"
          @click.stop
        >
          <div class="header-coding-popover-head">
            <span
              class="header-coding-dot"
              :class="[codingDotClass, { 'is-pulsing': codingPulsing }]"
              aria-hidden="true"
            />
            <strong>{{ codingPhaseLabel }}</strong>
            <span v-if="codingErrorCount > 0" class="header-coding-popover-danger">
              {{ $t('chatUi.codingErrorsCount', { count: codingErrorCount }) }}
            </span>
            <span v-if="codingMaxRepairRounds > 0" class="header-coding-popover-muted">
              {{ $t('chatUi.codingRepairRound', { current: codingRepairRound, max: codingMaxRepairRounds }) }}
            </span>
          </div>

          <div class="header-coding-popover-row">
            <span class="header-coding-popover-label">{{ $t('chatUi.codingCommands') }}</span>
            <span v-if="codingLatestCommand" class="header-coding-popover-command">
              <code>{{ formatCodingCommand(codingLatestCommand) }}</code>
              <span>{{ formatCodingDuration(codingLatestCommand.durationMs) }}</span>
            </span>
            <span v-else class="header-coding-popover-muted">{{ $t('chatUi.codingNoCommands') }}</span>
          </div>

          <div class="header-coding-popover-row">
            <span class="header-coding-popover-label">{{ $t('chatUi.codingStopReason') }}</span>
            <span class="header-coding-popover-value">{{ codingStopReasonLabel }}</span>
          </div>

          <div v-if="codingDiffCount > 0" class="header-coding-popover-row">
            <span class="header-coding-popover-label">{{ $t('chatUi.codingOpenDiff') }}</span>
            <span class="header-coding-popover-value">
              {{ $t('chatUi.codingDiffFileCount', { count: codingDiffCount }) }}
            </span>
          </div>

          <div class="header-coding-popover-actions">
            <button type="button" class="header-coding-action" @click="openCodingDiagnostics">
              {{ $t('chatUi.codingOpenDiagnostics') }}
            </button>
            <button
              type="button"
              class="header-coding-action"
              :disabled="codingDiffCount === 0"
              @click="openCodingDiff"
            >
              {{ $t('chatUi.codingOpenDiff') }}
            </button>
            <button
              v-if="codingLoading"
              type="button"
              class="header-coding-action"
              :disabled="!canCancelCoding"
              @click="cancelCoding"
            >
              {{ $t('chatUi.codingCancelRun') }}
            </button>
            <button
              v-else-if="canRetryCoding"
              type="button"
              class="header-coding-action is-primary"
              @click="retryCoding"
            >
              {{ $t('chatUi.codingRetryRun') }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="availableChannelBindings.length > 0" class="channel-binding-selector">
        <select :value="selectedChannelBindingId" class="select-input" @change="onChannelBindingChange">
          <option value="">{{ $t('chatUi.noImBinding') }}</option>
          <option v-for="binding in availableChannelBindings" :key="binding.id" :value="binding.id">
            {{ binding.connectorType }} · {{ binding.externalChannelId }}
          </option>
        </select>
      </div>

      <!-- Provider switch capsule on the far side of the header (design v1.7). -->
      <div v-if="showProviderSelector && providers && providers.length > 0" class="header-model-picker">
        <ProviderModelDropdown
          :providers="providers"
          :active-provider-id="activeProviderId"
          :selected-model="selectedModel"
          :title="$t('chatUi.providerModelTitle')"
          :show-tuning="true"
          :reasoning-strength="reasoningStrength"
          :reasoning-effort-options="reasoningEffortOptions"
          :temperature="temperature"
          :provider-default-temperature="providerDefaultTemperature"
          :is-group-conversation="isGroupConversation"
          @select="emit('selectProviderModel', $event)"
          @update:reasoning-strength="emit('update:reasoning-strength', $event)"
          @update:temperature="emit('update:temperature', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-header {
  /*
   * --app-panel is rgba(...0.92) — not fully opaque, so message text bled
   * through the "solid" region. Use --app-chat-canvas: the opaque flatten of
   * --app-main-surface over --app-shell-bg, i.e. the exact solid color the
   * semi-transparent message-list canvas reads as. The header fully occludes
   * scrolling text while colour-matching the text-area background (raw
   * --app-shell-bg is bluer than the canvas and caused a visible tint seam).
   */
  --chat-header-solid: var(--app-chat-canvas);
  position: relative;
  flex: 0 0 49px;
  width: 100%;
  z-index: 12;
  height: 49px;
  min-height: 49px;
  padding: 0 15px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  /*
   * No backdrop blur. The header is a solid panel surface across the top
   * (where the controls live, so they stay readable) that fades to transparent
   * toward the bottom edge, with a hairline seam (design v1.7 chat head).
   */
  background: var(--chat-header-solid);
  /*
   * Own compositing layer. The Electron window paints a translucent shell over
   * a blurred backdrop, so GPU layer rebuilds (streaming repaints, sidebar
   * churn) could momentarily drop this panel behind the message list and let
   * scrolled-under text bleed through the header zone.
   */
  transform: translateZ(0);
}

.chat-header::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: color-mix(in srgb, var(--app-border) 55%, transparent);
  pointer-events: none;
}

/* Bound conversations drop the capsule chrome entirely — plain identity
   text. The pill look stays only on the new-conversation picker, where the
   capsule signals "this is a control you can change". */
.header-agent-badge {
  flex: 0 1 auto;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: min(260px, 30vw);
  color: var(--app-text-muted);
}

.header-agent-badge-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.72rem;
  font-weight: 500;
}

.chat-header-copy {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.chat-header-copy p {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  color: var(--app-text-soft);
  font-size: 0.82rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-meta-separator {
  flex: 0 0 auto;
  color: var(--app-text-muted);
  font-size: 0.82rem;
  opacity: 0.7;
}

.header-model-picker {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  max-width: min(420px, 44vw);
  min-width: 0;
}

.header-model-picker :deep(.provider-model-trigger) {
  height: 24px;
  max-width: 100%;
  padding: 0 10px 0 20px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-panel-strong) 72%, transparent);
  color: var(--app-text-muted);
  font-size: 0.68rem;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  letter-spacing: 0.02em;
  box-shadow: none;
}

/* Signature dot in front of the model pill (design v1.7 chat head). */
.header-model-picker :deep(.provider-model-trigger)::before {
  content: '';
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--app-sig);
}

.header-model-picker :deep(.provider-model-trigger:hover:not(:disabled)),
.header-model-picker :deep(.provider-model-trigger.open),
.header-model-picker :deep(.provider-model-trigger:focus) {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
  background: var(--app-panel-strong);
  color: var(--app-text-strong);
  box-shadow: none;
}

.header-model-picker :deep(.provider-model-trigger) {
  position: relative;
}

.header-model-picker :deep(.provider-model-value) {
  max-width: 100%;
}

.header-controls {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* Compact coding-run pill: status at a glance, details in the popover. */
.header-coding {
  position: relative;
  flex: 0 1 auto;
  min-width: 0;
  max-width: min(210px, 30vw);
}

.header-coding-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  height: 24px;
  padding: 0 9px;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-panel-strong) 72%, transparent);
  color: var(--app-text-muted);
  font: inherit;
  font-size: 0.68rem;
  white-space: nowrap;
  cursor: pointer;
}

.header-coding-pill:hover,
.header-coding-pill.open {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
  color: var(--app-text-strong);
}

.header-coding-pill:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}

.header-coding-dot {
  --coding-dot-tone: var(--app-text-faint);
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--coding-dot-tone) 48%, transparent);
  background: var(--coding-dot-tone);
}

.header-coding-dot.is-active {
  --coding-dot-tone: var(--app-accent);
}

.header-coding-dot.is-complete {
  --coding-dot-tone: var(--app-success);
}

.header-coding-dot.is-repair {
  --coding-dot-tone: var(--app-warning);
}

.header-coding-dot.is-blocked {
  --coding-dot-tone: var(--app-danger);
}

.header-coding-dot.is-pulsing {
  animation: header-coding-pulse 1.8s ease-in-out infinite;
}

@keyframes header-coding-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--coding-dot-tone) 30%, transparent);
  }
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--coding-dot-tone) 0%, transparent);
  }
}

.header-coding-phase {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: inherit;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-coding-meta {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.63rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-coding-caret {
  flex: none;
  opacity: 0.7;
  transition: transform var(--duration-fast) var(--ease-out);
}

.header-coding-caret.is-open {
  transform: rotate(180deg);
}

.header-coding-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 60;
  width: min(300px, calc(100vw - 32px));
  max-width: calc(100vw - 24px);
  max-height: min(70vh, calc(100vh - 70px));
  padding: 10px 12px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--app-border-strong);
  border-radius: 9px;
  background: var(--app-panel);
  box-shadow: var(--app-shadow);
  color: var(--app-text);
  font-size: 0.72rem;
  backdrop-filter: blur(14px);
}

.header-coding-popover-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  padding-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
}

.header-coding-popover-head strong {
  color: var(--app-text-strong);
  font-size: 0.76rem;
}

.header-coding-popover-danger {
  color: var(--app-danger);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.65rem;
}

.header-coding-popover-muted {
  color: var(--app-text-muted);
  font-size: 0.67rem;
}

.header-coding-popover-row {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
  padding-top: 8px;
}

.header-coding-popover-label {
  color: var(--app-text-muted);
  font-size: 0.65rem;
}

.header-coding-popover-command {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}

.header-coding-popover-command code {
  min-width: 0;
  overflow: hidden;
  color: var(--app-text-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.66rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-coding-popover-command span {
  flex: none;
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.63rem;
}

.header-coding-popover-value {
  min-width: 0;
  color: var(--app-text-soft);
  overflow-wrap: anywhere;
}

.header-coding-popover-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
}

.header-coding-action {
  appearance: none;
  padding: 0;
  border: 0;
  background: none;
  color: var(--app-accent);
  font: inherit;
  font-size: 0.7rem;
  cursor: pointer;
}

.header-coding-action.is-primary {
  font-weight: 650;
}

.header-coding-action:hover:not(:disabled) {
  color: var(--app-accent-strong);
  text-decoration: underline;
}

.header-coding-action:disabled {
  color: var(--app-text-muted);
  cursor: not-allowed;
  opacity: 0.5;
}

.header-coding-action:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
  border-radius: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .header-coding-dot.is-pulsing {
    animation: none;
  }

  .header-coding-caret {
    transition: none;
  }
}

@media (max-width: 760px) {
  .header-coding {
    max-width: min(168px, 38vw);
  }

  .header-coding-meta {
    display: none;
  }

  .header-coding-popover {
    right: 0;
    width: min(280px, calc(100vw - 20px));
    max-width: calc(100vw - 20px);
  }
}

@media (max-width: 480px) {
  .header-coding {
    max-width: min(124px, 42vw);
  }

  .header-coding-pill {
    padding: 0 7px;
  }
}

/* New-conversation agent switcher, sitting next to the agent name (design v1.7). */
.header-agent-picker {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  min-width: 0;
  max-width: min(240px, 28vw);
}

.header-agent-picker :deep(.provider-dropdown-trigger) {
  height: 24px;
  max-width: 100%;
  padding: 0 9px;
  gap: 5px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-panel-strong) 72%, transparent);
  color: var(--app-text-muted);
  font-size: 0.68rem;
  box-shadow: none;
}

.header-agent-picker :deep(.provider-dropdown-trigger:hover:not(:disabled)),
.header-agent-picker :deep(.provider-dropdown-trigger.open),
.header-agent-picker :deep(.provider-dropdown-trigger:focus) {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
  background: var(--app-panel-strong);
  color: var(--app-text-strong);
}

.header-agent-picker :deep(.provider-dropdown-title) {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- header「更多」settings menu (design v1.7 P2) ---- */
/* (moved into ProviderModelDropdown's tuning section) */

.channel-binding-selector,
.auth-mode-selector {
  display: flex;
  align-items: center;
  min-width: 0;
}

.select-input {
  max-width: min(220px, 24vw);
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 6px;
  color: var(--app-text);
  padding: 4px 8px;
  font-size: 0.8em;
  cursor: pointer;
}

.select-input option {
  background: var(--app-input-bg);
  color: var(--app-text);
}

.select-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.select-input:focus {
  outline: none;
  border-color: var(--app-accent);
}


.skill-selector {
  position: relative;
}

.skill-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  background: color-mix(in srgb, var(--app-panel-strong) 72%, transparent);
  border: 1px solid var(--app-border);
  border-radius: 999px;
  color: var(--app-text-muted);
  font-size: 0.68rem;
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
}

.skill-spark {
  color: var(--app-accent-strong);
  font-size: 0.7rem;
}

.skill-toggle-btn:hover {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
  color: var(--app-text);
}

.skill-toggle-btn.has-active {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
  color: var(--app-text-strong);
  background: var(--app-accent-soft);
}

.skill-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 6px;
  min-width: 200px;
  max-width: min(320px, calc(100vw - 32px));
  max-height: min(420px, calc(100vh - 140px));
  overflow-y: auto;
  background: var(--app-panel);
  border: 1px solid var(--app-border-strong);
  border-radius: 8px;
  padding: 6px;
  z-index: 50;
  box-shadow: var(--app-shadow);
  backdrop-filter: blur(14px);
  overscroll-behavior: contain;
}

.skill-dropdown-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 4px 4px 8px;
}

.skill-dropdown-action {
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 0.76em;
  cursor: pointer;
}

.skill-dropdown-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.skill-dropdown-action:not(:disabled):hover {
  border-color: var(--app-accent);
  color: var(--app-text-strong);
}

.skill-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.82em;
  color: var(--app-text-muted);
  transition: background 0.1s;
}

.skill-option:hover {
  background: var(--app-panel-muted);
  color: var(--app-text);
}

.skill-option.selected {
  color: var(--app-text-strong);
  background: var(--app-accent-soft);
}

.skill-check {
  width: 13px;
  height: 13px;
  border-radius: 4px;
  border: 1px solid var(--app-border-strong);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--app-on-accent);
}

.skill-check.on {
  border-color: transparent;
  background: var(--app-accent);
}

.skill-check svg {
  width: 10px;
  height: 10px;
}

.skill-option-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
