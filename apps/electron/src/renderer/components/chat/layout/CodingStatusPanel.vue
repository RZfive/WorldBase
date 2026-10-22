<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CODING_STOP_REASON_LABEL_KEYS,
  isCodingStatusActive,
  isCodingStatusRetryable,
  type CodingCommandOutcome,
  type CodingDiagnostic,
  type CodingStatus,
} from '../../../../shared/coding-status-types.js'

const props = defineProps<{
  status: CodingStatus
  diffFileCount?: number
  isLoading?: boolean
  /** Controlled by the attention-zone accordion; undefined keeps the panel
      self-managed (standalone usage). */
  expanded?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'openDiagnostics'): void
  (e: 'openDiff'): void
  (e: 'cancel'): void
  (e: 'retry'): void
}>()

const { t } = useI18n()

type RailPhase = 'plan' | 'inspect' | 'edit' | 'verify' | 'diagnose' | 'repair'

const PHASE_STEPS: ReadonlyArray<{ phase: RailPhase; labelKey: string }> = [
  { phase: 'plan', labelKey: 'chatUi.codingPhasePlan' },
  { phase: 'inspect', labelKey: 'chatUi.codingPhaseInspect' },
  { phase: 'edit', labelKey: 'chatUi.codingPhaseEdit' },
  { phase: 'verify', labelKey: 'chatUi.codingPhaseVerify' },
  { phase: 'diagnose', labelKey: 'chatUi.codingPhaseDiagnose' },
  { phase: 'repair', labelKey: 'chatUi.codingPhaseRepair' },
]

const PHASE_LABEL_KEYS: Record<CodingStatus['phase'], string> = {
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

const selfExpanded = ref(false)
const isExpanded = computed(() =>
  typeof props.expanded === 'boolean' ? props.expanded : selfExpanded.value,
)

watch(
  () => props.expanded,
  (value) => {
    if (typeof value === 'boolean') selfExpanded.value = value
  },
  { immediate: true },
)

const phaseLabel = computed(() => t(PHASE_LABEL_KEYS[props.status.phase]))
const phaseIndex = computed(() =>
  PHASE_STEPS.findIndex((step) => step.phase === props.status.phase),
)
const latestCommand = computed<CodingCommandOutcome | null>(
  () => props.status.commands[props.status.commands.length - 1] ?? null,
)
const errorCount = computed(
  () => props.status.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
)
const topDiagnostics = computed(() => props.status.diagnostics.slice(0, 3))
const diffCount = computed(() => Math.max(0, props.diffFileCount ?? 0))
const showDiff = computed(() => diffCount.value > 0)
const maxRepairRounds = computed(() => props.status.maxRepairRounds ?? 0)
const summaryText = computed(() => {
  if (errorCount.value > 0) {
    return t('chatUi.codingErrorsCount', { count: errorCount.value })
  }
  if (latestCommand.value) return formatCommand(latestCommand.value)
  return t('chatUi.codingAwaitingVerification')
})
const summaryIsCommand = computed(
  () => errorCount.value === 0 && latestCommand.value !== null,
)
const isPulsing = computed(
  () =>
    props.isLoading === true &&
    (props.status.phase === 'verify' ||
      props.status.phase === 'diagnose' ||
      props.status.phase === 'repair'),
)
const canCancel = computed(
  () => props.isLoading === true && isCodingStatusActive(props.status),
)
const canRetry = computed(
  () => props.isLoading !== true && isCodingStatusRetryable(props.status),
)
const stopReasonLabel = computed(() => {
  const reason = props.status.stopReason
  if (!reason) return t('chatUi.codingAllClear')
  const key = CODING_STOP_REASON_LABEL_KEYS[reason]
  return key ? t(key) : reason
})
const dotClass = computed(() => {
  if (props.status.phase === 'complete') return 'is-complete'
  if (props.status.phase === 'blocked') return 'is-blocked'
  if (props.status.phase === 'repair') return 'is-repair'
  if (props.status.phase === 'verify' || props.status.phase === 'diagnose') {
    return 'is-active'
  }
  return ''
})

function tickClass(index: number): string {
  if (props.status.phase === 'complete') return 'is-passed'
  if (props.status.phase === 'blocked') return 'is-danger'
  if (phaseIndex.value === -1) return ''
  if (index < phaseIndex.value) return 'is-passed'
  if (index > phaseIndex.value) return ''
  return props.status.phase === 'repair' ? 'is-warning' : 'is-active'
}

function formatCommand(command: CodingCommandOutcome): string {
  const parts = [command.program, ...command.args].filter((part) => part.length > 0)
  return parts.length > 0 ? parts.join(' ') : '—'
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—'
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`
}

function formatDiagnosticLocation(diagnostic: CodingDiagnostic): string {
  const parts: string[] = []
  if (diagnostic.code?.trim()) parts.push(diagnostic.code.trim())

  const file = diagnostic.file?.trim()
  const hasLine = typeof diagnostic.line === 'number'
  const hasColumn = typeof diagnostic.column === 'number'
  if (file) {
    let location = file
    if (hasLine) {
      location += `:${diagnostic.line}`
      if (hasColumn) location += `:${diagnostic.column}`
    }
    parts.push(location)
  } else if (hasLine) {
    parts.push(hasColumn ? `${diagnostic.line}:${diagnostic.column}` : `${diagnostic.line}`)
  }

  return parts.join(' · ')
}

function togglePanel(): void {
  selfExpanded.value = !isExpanded.value
  emit('toggle')
}
</script>

<template>
  <section class="coding-status-shell" :aria-label="$t('chatUi.codingStatusAria')">
    <div class="coding-status-panel">
      <button
        class="coding-status-strip"
        type="button"
        :aria-expanded="isExpanded"
        :aria-controls="isExpanded ? 'coding-status-body' : undefined"
        @click="togglePanel"
      >
        <span
          class="coding-status-dot"
          :class="[dotClass, { 'is-pulsing': isPulsing }]"
          aria-hidden="true"
        />

        <span class="coding-status-phase">
          <span class="coding-status-phase-label">{{ phaseLabel }}</span>
          <span class="coding-status-rail" aria-hidden="true">
            <span
              v-for="(step, index) in PHASE_STEPS"
              :key="step.phase"
              class="coding-status-tick"
              :class="tickClass(index)"
              :title="$t(step.labelKey)"
            />
          </span>
        </span>

        <span
          class="coding-status-summary"
          :class="{ 'is-command': summaryIsCommand }"
        >
          {{ summaryText }}
        </span>

        <span v-if="showDiff" class="coding-status-diff">
          {{ $t('chatUi.codingOpenDiff') }}
          <span class="coding-status-diff-count">{{ diffCount }}</span>
        </span>

        <span
          class="coding-status-chevron"
          :class="{ 'is-expanded': isExpanded }"
          aria-hidden="true"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      <div v-if="isExpanded" id="coding-status-body" class="coding-status-body">
        <div class="coding-status-command-row">
          <span class="coding-status-label">{{ $t('chatUi.codingCommands') }}</span>
          <span v-if="latestCommand" class="coding-status-command-line">
            <code class="coding-status-command">{{ formatCommand(latestCommand) }}</code>
            <span class="coding-status-duration">{{
              formatDuration(latestCommand.durationMs)
            }}</span>
          </span>
          <span v-else class="coding-status-muted">{{ $t('chatUi.codingNoCommands') }}</span>
        </div>

        <div v-if="maxRepairRounds > 0" class="coding-status-repair">
          {{
            $t('chatUi.codingRepairRound', {
              current: props.status.repairRound,
              max: maxRepairRounds,
            })
          }}
        </div>

        <div v-if="props.status.stopReason" class="coding-status-stop">
          <span class="coding-status-label">{{ $t('chatUi.codingStopReason') }}</span>
          <span class="coding-status-stop-value">{{ stopReasonLabel }}</span>
        </div>

        <div class="coding-status-diagnostics">
          <div
            v-for="(diagnostic, index) in topDiagnostics"
            :key="`${diagnostic.code ?? 'diagnostic'}-${index}`"
            class="coding-status-diagnostic"
            :class="`severity-${diagnostic.severity}`"
          >
            <span class="coding-status-diagnostic-location">
              {{ formatDiagnosticLocation(diagnostic) }}
            </span>
            <p class="coding-status-diagnostic-message">{{ diagnostic.message }}</p>
          </div>
          <span v-if="topDiagnostics.length === 0" class="coding-status-muted">
            {{ $t('chatUi.codingNoDiagnostics') }}
          </span>
        </div>

        <div class="coding-status-actions">
          <button
            class="coding-status-action"
            type="button"
            @click.stop="emit('openDiagnostics')"
          >
            {{ $t('chatUi.codingOpenDiagnostics') }}
          </button>
          <button
            class="coding-status-action"
            type="button"
            @click.stop="emit('openDiff')"
          >
            {{ $t('chatUi.codingOpenDiff') }}
          </button>
          <button
            v-if="props.isLoading"
            class="coding-status-action"
            type="button"
            :disabled="!canCancel"
            :title="$t('chatUi.codingCancelRun')"
            @click.stop="emit('cancel')"
          >
            {{ $t('chatUi.codingCancelRun') }}
          </button>
          <button
            v-else-if="canRetry"
            class="coding-status-action"
            type="button"
            :disabled="!canRetry"
            :title="$t('chatUi.codingRetryRun')"
            @click.stop="emit('retry')"
          >
            {{ $t('chatUi.codingRetryRun') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.coding-status-shell {
  /* The phase strip is the primary status surface; keep it above the
     passive todo capsule if an older layout ever overlaps them. */
  position: relative;
  z-index: 2;
  width: 100%;
  max-width: 100%;
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.coding-status-panel {
  width: min(
    var(--chat-message-track-max, 980px),
    calc(
      100% - var(--chat-message-gutter, 28px) - var(--chat-message-gutter, 28px) -
        24px
    )
  );
  max-width: 100%;
  margin: 0 auto;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
  border-radius: 11px;
  background: var(--app-panel-muted);
  box-sizing: border-box;
}

.coding-status-strip {
  width: 100%;
  height: 40px;
  min-height: 40px;
  display: grid;
  grid-template-columns: 7px auto minmax(0, 1fr) auto 16px;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: var(--app-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}

.coding-status-strip:hover {
  background: color-mix(in srgb, var(--app-accent) 5%, transparent);
}

.coding-status-strip:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
}

.coding-status-dot {
  --coding-dot-tone: var(--app-text-faint);
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--coding-dot-tone) 48%, transparent);
  background: var(--coding-dot-tone);
}

.coding-status-dot.is-active {
  --coding-dot-tone: var(--app-accent);
}

.coding-status-dot.is-complete {
  --coding-dot-tone: var(--app-success);
}

.coding-status-dot.is-repair {
  --coding-dot-tone: var(--app-warning);
}

.coding-status-dot.is-blocked {
  --coding-dot-tone: var(--app-danger);
}

.coding-status-dot.is-pulsing {
  animation: coding-status-pulse 1.8s ease-in-out infinite;
}

@keyframes coding-status-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--coding-dot-tone) 30%, transparent);
  }
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--coding-dot-tone) 0%, transparent);
  }
}

.coding-status-phase {
  min-width: 64px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.coding-status-phase-label {
  color: var(--app-text-strong);
  font-size: 0.74rem;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.coding-status-rail {
  display: flex;
  align-items: center;
  height: 5px;
}

.coding-status-tick {
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 1px;
  background: var(--app-border-strong);
}

.coding-status-tick + .coding-status-tick {
  position: relative;
  margin-left: 8px;
}

.coding-status-tick + .coding-status-tick::before {
  content: '';
  position: absolute;
  right: 100%;
  top: 2px;
  width: 8px;
  height: 1px;
  background: var(--app-border);
}

.coding-status-tick.is-active {
  background: var(--app-accent);
}

.coding-status-tick.is-passed {
  background: var(--app-success);
}

.coding-status-tick.is-warning {
  background: var(--app-warning);
}

.coding-status-tick.is-danger {
  background: var(--app-danger);
}

.coding-status-summary {
  min-width: 0;
  overflow: hidden;
  color: var(--app-text-muted);
  font-size: 0.76rem;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.coding-status-summary.is-command {
  color: var(--app-text-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.72rem;
}

.coding-status-diff {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--app-accent);
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}

.coding-status-diff-count {
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.7rem;
}

.coding-status-chevron {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--app-text-muted);
  transition: transform var(--duration-fast) var(--ease-out);
}

.coding-status-chevron.is-expanded {
  transform: rotate(180deg);
}

.coding-status-body {
  max-height: 220px;
  overflow-y: auto;
  padding: 9px 12px 11px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.coding-status-command-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
  padding-bottom: 7px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
}

.coding-status-label {
  color: var(--app-text-muted);
  font-size: 0.72rem;
  white-space: nowrap;
}

.coding-status-command-line {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.coding-status-command {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--app-text-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.coding-status-duration {
  flex: none;
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.7rem;
}

.coding-status-repair {
  margin-top: 7px;
  color: var(--app-warning);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.72rem;
}

.coding-status-stop {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 7px;
  font-size: 0.72rem;
}

.coding-status-stop-value {
  color: var(--app-text-soft);
}

.coding-status-diagnostics {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 8px;
}

.coding-status-diagnostic {
  padding-left: 8px;
  border-left: 2px solid var(--app-border-strong);
}

.coding-status-diagnostic.severity-error {
  border-left-color: var(--app-danger);
}

.coding-status-diagnostic.severity-warning {
  border-left-color: var(--app-warning);
}

.coding-status-diagnostic.severity-info {
  border-left-color: var(--app-text-faint);
}

.coding-status-diagnostic-location {
  display: block;
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.7rem;
  line-height: 1.25;
}

.coding-status-diagnostic.severity-error .coding-status-diagnostic-location {
  color: var(--app-danger);
}

.coding-status-diagnostic.severity-warning .coding-status-diagnostic-location {
  color: var(--app-warning);
}

.coding-status-diagnostic-message {
  margin: 2px 0 0;
  color: var(--app-text);
  font-size: 0.74rem;
  line-height: 1.35;
}

.coding-status-muted {
  color: var(--app-text-muted);
  font-size: 0.73rem;
}

.coding-status-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
}

.coding-status-action {
  appearance: none;
  padding: 0;
  border: 0;
  background: none;
  color: var(--app-accent);
  font: inherit;
  font-size: 0.74rem;
  cursor: pointer;
}

.coding-status-action:hover:not(:disabled) {
  color: var(--app-accent-strong);
  text-decoration: underline;
}

.coding-status-action:disabled {
  color: var(--app-text-muted);
  cursor: not-allowed;
  opacity: 0.55;
}

.coding-status-action:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
  border-radius: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .coding-status-dot.is-pulsing {
    animation: none;
  }

  .coding-status-strip,
  .coding-status-chevron {
    transition: none;
  }
}
</style>
