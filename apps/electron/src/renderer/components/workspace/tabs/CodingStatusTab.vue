<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CODING_CONFIDENCE_SUGGESTION_THRESHOLD,
  CODING_STOP_REASON_LABEL_KEYS,
  isCodingStatusRetryable,
  isLowConfidenceDiagnostic,
  type CodingCommandOutcome,
  type CodingDiagnostic,
  type CodingPhase,
  type CodingStatus
} from '../../../../shared/coding-status-types.js'
import { sharedChatPanelState } from '../../chat/panel/shared-state'
import { ensureWorkspaceTab, workspaceStore } from '../workspace-store'

const props = defineProps<{
  conversationId: string
}>()

const { t } = useI18n()

const status = computed<CodingStatus | null>(() => (
  sharedChatPanelState.codingStatusByConversation.get(props.conversationId) || null
))

const diffFiles = computed(() => (
  sharedChatPanelState.codingDiffByConversation.get(props.conversationId)?.files ?? []
))

const PHASES: ReadonlyArray<{ phase: CodingPhase; labelKey: string }> = [
  { phase: 'plan', labelKey: 'chatUi.codingPhasePlan' },
  { phase: 'inspect', labelKey: 'chatUi.codingPhaseInspect' },
  { phase: 'edit', labelKey: 'chatUi.codingPhaseEdit' },
  { phase: 'verify', labelKey: 'chatUi.codingPhaseVerify' },
  { phase: 'diagnose', labelKey: 'chatUi.codingPhaseDiagnose' },
  { phase: 'repair', labelKey: 'chatUi.codingPhaseRepair' },
  { phase: 'complete', labelKey: 'chatUi.codingPhaseComplete' }
]

const PHASE_LABEL_KEYS: Record<CodingPhase, string> = {
  idle: 'chatUi.codingPhaseIdle',
  plan: 'chatUi.codingPhasePlan',
  inspect: 'chatUi.codingPhaseInspect',
  edit: 'chatUi.codingPhaseEdit',
  verify: 'chatUi.codingPhaseVerify',
  diagnose: 'chatUi.codingPhaseDiagnose',
  repair: 'chatUi.codingPhaseRepair',
  complete: 'chatUi.codingPhaseComplete',
  blocked: 'chatUi.codingPhaseBlocked'
}

interface DiagnosticGroup {
  file: string
  diagnostics: CodingDiagnostic[]
}

const currentPhaseIndex = computed(() => (
  PHASES.findIndex(item => item.phase === status.value?.phase)
))

const phaseBadgeLabel = computed(() => {
  const phase = status.value?.phase
  return phase ? t(PHASE_LABEL_KEYS[phase]) : ''
})

const errorCount = computed(() => (
  status.value?.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length ?? 0
))

const warningCount = computed(() => (
  status.value?.diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length ?? 0
))

const diagnosticGroups = computed<DiagnosticGroup[]>(() => {
  const groups = new Map<string, CodingDiagnostic[]>()
  for (const diagnostic of status.value?.diagnostics ?? []) {
    const file = diagnostic.file?.trim() || '—'
    const existing = groups.get(file)
    if (existing) existing.push(diagnostic)
    else groups.set(file, [diagnostic])
  }
  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, diagnostics]) => ({ file, diagnostics }))
})

const repairMaxLabel = computed(() => (
  status.value?.maxRepairRounds != null ? String(status.value.maxRepairRounds) : '—'
))

const runActions = computed(() => (
  sharedChatPanelState.codingRunActionsByConversation.get(props.conversationId) || null
))
const conversationIsStreaming = computed(() => (
  sharedChatPanelState.streamingConversationIds.has(props.conversationId)
))
const conversationIsCurrent = computed(() => (
  sharedChatPanelState.currentConversationId.value === props.conversationId
))
const canCancelRun = computed(() => conversationIsStreaming.value && Boolean(runActions.value?.cancel))
const canRetryRun = computed(() => (
  conversationIsCurrent.value &&
  !conversationIsStreaming.value &&
  isCodingStatusRetryable(status.value) &&
  Boolean(runActions.value?.retry)
))
const showRunActions = computed(() => (
  Boolean(runActions.value) &&
  (conversationIsCurrent.value || conversationIsStreaming.value)
))

function cancelRun (): void {
  void runActions.value?.cancel()
}

function retryRun (): void {
  void runActions.value?.retry()
}

function isSuggestion (diagnostic: CodingDiagnostic): boolean {
  return isLowConfidenceDiagnostic(diagnostic)
}

function isConfident (diagnostic: CodingDiagnostic): boolean {
  return diagnostic.confidence != null && diagnostic.confidence >= CODING_CONFIDENCE_SUGGESTION_THRESHOLD
}

function diagnosticRowClass (diagnostic: CodingDiagnostic): Record<string, boolean> {
  return {
    'is-suggestion': isSuggestion(diagnostic),
    'is-confident': isConfident(diagnostic)
  }
}

function phaseState (index: number): 'completed' | 'current' | 'pending' {
  const current = currentPhaseIndex.value
  if (current < 0) return 'pending'
  if (index < current) return 'completed'
  if (index === current) return 'current'
  return 'pending'
}

function diagnosticLocation (diagnostic: CodingDiagnostic): string {
  const parts = [diagnostic.file?.trim() || '—']
  if (diagnostic.line != null) parts.push(String(diagnostic.line))
  if (diagnostic.column != null) parts.push(String(diagnostic.column))
  return parts.join(':')
}

function formatConfidence (value: number | undefined): string {
  if (value == null) return ''
  return `${Math.round(value * 100)}%`
}

function formatCommand (command: CodingCommandOutcome): string {
  return [command.program, ...command.args].filter(Boolean).join(' ')
}

function formatExitCode (command: CodingCommandOutcome): string {
  return command.exitCode == null ? '—' : String(command.exitCode)
}

function formatDuration (durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—'
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`
  return `${(durationMs / 1000).toFixed(1)} s`
}

function normalizePath (value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

function pathsMatch (left: string, right: string): boolean {
  const normalizedLeft = normalizePath(left)
  const normalizedRight = normalizePath(right)
  if (!normalizedLeft || !normalizedRight) return false
  return normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
}

function diffFileForDiagnostic (diagnostic: CodingDiagnostic): string | null {
  const file = diagnostic.file?.trim()
  if (!file) return null
  return diffFiles.value.find(item => pathsMatch(item.filePath, file))?.filePath ?? null
}

function openDiffForDiagnostic (diagnostic: CodingDiagnostic): void {
  const filePath = diffFileForDiagnostic(diagnostic)
  if (!filePath) return
  ensureWorkspaceTab('coding-diff', {
    conversationId: props.conversationId,
    focusFilePath: filePath,
    // Re-clicking the same diagnostic must re-focus the same file even when
    // the tab state already carries that path.
    focusRequestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`
  })
  workspaceStore.visible.value = true
}

function hasCommandOutput (command: CodingCommandOutcome): boolean {
  return Boolean(command.stdout?.trim() || command.stderr?.trim())
}

function commandOutput (command: CodingCommandOutcome): string {
  const chunks: string[] = []
  if (command.stdout?.trim()) chunks.push(`${t('chatUi.codingLogStdout')}\n${command.stdout}`)
  if (command.stderr?.trim()) chunks.push(`${t('chatUi.codingLogStderr')}\n${command.stderr}`)
  return chunks.join('\n\n')
}

const openLogs = ref<Set<string>>(new Set())
const copiedToken = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | null = null

function commandLogId (index: number): string {
  return `coding-command-log-${props.conversationId}-${index}`
}

function isLogOpen (id: string): boolean {
  return openLogs.value.has(id)
}

function toggleLog (id: string): void {
  const next = new Set(openLogs.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openLogs.value = next
}

function isCopied (token: string): boolean {
  return copiedToken.value === token
}

async function copyText (text: string, token: string): Promise<void> {
  if (!text.trim()) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      document.body.removeChild(area)
    }
    copiedToken.value = token
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedToken.value = '' }, 1600)
  } catch {
    copiedToken.value = ''
  }
}

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})

const stopReasonLabel = computed(() => {
  const reason = status.value?.stopReason
  if (!reason) return t('chatUi.codingAllClear')
  const key = CODING_STOP_REASON_LABEL_KEYS[reason]
  return key ? t(key) : reason
})
</script>

<template>
  <div class="coding-status">
    <header class="cs-header">
      <div class="cs-title">
        <h1>{{ t('chatUi.codingStatusTab') }}</h1>
      </div>
      <div v-if="status" class="cs-header-meta">
        <span class="phase-badge" :data-phase="status.phase">{{ phaseBadgeLabel }}</span>
        <span class="count-pill danger">{{ t('chatUi.codingErrorsCount', { count: errorCount }) }}</span>
        <span class="count-pill warning">{{ t('chatUi.codingWarningsCount', { count: warningCount }) }}</span>
      </div>
    </header>

    <div v-if="!status" class="cs-empty">
      <p>{{ t('chatUi.codingNoDiagnostics') }}</p>
    </div>

    <div v-else class="cs-workbench">
      <nav class="phase-rail" :aria-label="t('chatUi.codingStatusAria')">
        <ol class="phase-list">
          <li
            v-for="(item, index) in PHASES"
            :key="item.phase"
            class="phase-item"
            :data-state="phaseState(index)"
            :aria-current="phaseState(index) === 'current' ? 'step' : undefined"
          >
            <span class="phase-tick" aria-hidden="true"></span>
            <span class="phase-label">{{ t(item.labelKey) }}</span>
          </li>
        </ol>
        <div class="phase-meta">
          <span class="phase-meta-row">
            {{ t('chatUi.codingRepairRound', { current: status.repairRound, max: repairMaxLabel }) }}
          </span>
          <span class="phase-meta-row">
            <span>{{ t('chatUi.codingVerificationAttempts') }}</span>
            <strong>{{ status.verificationAttempts }}</strong>
          </span>
        </div>
      </nav>

      <section class="diagnostics-panel" aria-labelledby="coding-diagnostics-heading">
        <h2 id="coding-diagnostics-heading">{{ t('chatUi.codingDiagnostics') }}</h2>
        <p v-if="status.diagnostics.length === 0" class="panel-empty">
          {{ t('chatUi.codingNoDiagnostics') }}
        </p>
        <div v-else class="diagnostic-groups">
          <section
            v-for="group in diagnosticGroups"
            :key="group.file"
            class="diagnostic-group"
          >
            <h3 class="file-heading">{{ group.file }}</h3>
            <ul class="diagnostic-list">
              <li
                v-for="(diagnostic, index) in group.diagnostics"
                :key="`${group.file}-${index}-${diagnostic.code || diagnostic.message}`"
                class="diagnostic-item"
                :aria-label="`${diagnostic.severity}: ${diagnostic.message}${isSuggestion(diagnostic) ? ' · ' + t('chatUi.codingSuggestionBadge') : ''}`"
              >
                <div class="diagnostic-row" :class="diagnosticRowClass(diagnostic)">
                  <span
                    class="severity-dot"
                    :data-severity="diagnostic.severity"
                    aria-hidden="true"
                  ></span>
                  <code v-if="diagnostic.code" class="diag-code">{{ diagnostic.code }}</code>
                  <span class="diag-location">{{ diagnosticLocation(diagnostic) }}</span>
                  <span class="diag-message">{{ diagnostic.message }}</span>
                  <button
                    v-if="diffFileForDiagnostic(diagnostic)"
                    type="button"
                    class="diag-action"
                    :aria-label="`${t('chatUi.codingOpenDiff')} · ${diagnosticLocation(diagnostic)}`"
                    :title="diffFileForDiagnostic(diagnostic) || undefined"
                    @click="openDiffForDiagnostic(diagnostic)"
                  >
                    {{ t('chatUi.codingOpenDiff') }}
                  </button>
                  <span
                    v-if="diagnostic.confidence != null"
                    class="diag-confidence"
                    :class="{
                      'is-suggestion': isSuggestion(diagnostic),
                      'is-confident': isConfident(diagnostic)
                    }"
                  >
                    {{ t('chatUi.codingConfidence', { value: formatConfidence(diagnostic.confidence) }) }}
                  </span>
                  <span
                    v-if="isSuggestion(diagnostic)"
                    class="suggestion-badge"
                    :title="t('chatUi.codingSuggestionTooltip')"
                  >
                    {{ t('chatUi.codingSuggestionBadge') }}
                  </span>
                </div>
                <details v-if="diagnostic.raw" class="diag-raw">
                  <summary>{{ t('chatUi.codingRawOutput') }}</summary>
                  <pre>{{ diagnostic.raw }}</pre>
                </details>
              </li>
            </ul>
          </section>
        </div>
      </section>

      <aside class="summary-panel">
        <div v-if="showRunActions" class="run-actions">
          <button
            type="button"
            class="run-action"
            :disabled="!canCancelRun"
            @click="cancelRun"
          >
            {{ t('chatUi.codingCancelRun') }}
          </button>
          <button
            type="button"
            class="run-action"
            :disabled="!canRetryRun"
            @click="retryRun"
          >
            {{ t('chatUi.codingRetryRun') }}
          </button>
        </div>

        <dl class="summary-definitions">
          <div class="definition-row">
            <dt>{{ t('chatUi.codingStopReason') }}</dt>
            <dd class="mono">{{ stopReasonLabel }}</dd>
          </div>

          <div class="definition-row">
            <dt>
              {{ t('chatUi.codingChangedFiles') }}
              <span class="block-count">{{ status.changedFiles.length }}</span>
            </dt>
            <dd>
              <ul v-if="status.changedFiles.length" class="path-list">
                <li v-for="file in status.changedFiles" :key="file" class="mono" :title="file">{{ file }}</li>
              </ul>
              <p v-else class="summary-value">{{ t('chatUi.codingAllClear') }}</p>
            </dd>
          </div>

          <div class="definition-row">
            <dt>
              {{ t('chatUi.codingCommands') }}
              <span class="block-count">{{ status.commands.length }}</span>
            </dt>
            <dd>
              <p v-if="status.commands.length === 0" class="summary-value">
                {{ t('chatUi.codingNoCommands') }}
              </p>
              <ul v-else class="command-list">
                <li v-for="(command, index) in status.commands" :key="`${command.program}-${index}`">
                  <div class="command-head">
                    <code class="command-line">{{ formatCommand(command) }}</code>
                    <button
                      type="button"
                      class="inline-action"
                      :aria-label="t('chatUi.codingCopyCommand')"
                      @click="copyText(formatCommand(command), `command-${index}`)"
                    >
                      {{ isCopied(`command-${index}`) ? t('chatUi.codingCopied') : t('chatUi.codingCopyCommand') }}
                    </button>
                  </div>
                  <div class="command-meta">
                    <span>exit {{ formatExitCode(command) }}</span>
                    <span>{{ formatDuration(command.durationMs) }}</span>
                  </div>
                  <template v-if="hasCommandOutput(command)">
                    <button
                      type="button"
                      class="raw-toggle"
                      :aria-expanded="isLogOpen(commandLogId(index))"
                      :aria-controls="commandLogId(index)"
                      @click="toggleLog(commandLogId(index))"
                    >
                      {{ t('chatUi.codingRawOutput') }}
                    </button>
                    <pre
                      v-if="isLogOpen(commandLogId(index))"
                      :id="commandLogId(index)"
                      class="command-raw"
                    >{{ commandOutput(command) }}</pre>
                  </template>
                </li>
              </ul>
            </dd>
          </div>

          <div class="definition-row">
            <dt>
              {{ t('chatUi.codingDependency') }}
              <span class="block-count">{{ status.dependencyIssues.length }}</span>
            </dt>
            <dd>
              <p v-if="status.dependencyIssues.length === 0" class="summary-value">
                {{ t('chatUi.codingAllClear') }}
              </p>
              <ul v-else class="dependency-list">
                <li v-for="(issue, index) in status.dependencyIssues" :key="`${issue.kind}-${index}`">
                  <div class="dependency-head">
                    <span class="mono">{{ issue.package || issue.kind }}</span>
                    <span class="dependency-kind">{{ issue.kind }}</span>
                  </div>
                  <p class="dependency-message">{{ issue.message }}</p>
                  <code v-if="issue.command" class="command-line">{{ issue.command }}</code>
                </li>
              </ul>
            </dd>
          </div>

          <div class="definition-row">
            <dt>
              {{ t('chatUi.codingRepairPlan') }}
              <span class="block-count">{{ status.repairInstructions.length }}</span>
            </dt>
            <dd>
              <p v-if="status.repairInstructions.length === 0" class="summary-value">
                {{ t('chatUi.codingNoRepairPlan') }}
              </p>
              <ol v-else class="repair-list">
                <li v-for="(step, index) in status.repairInstructions" :key="`${index}-${step}`">
                  {{ step }}
                </li>
              </ol>
            </dd>
          </div>
        </dl>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.coding-status {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--app-panel);
  color: var(--app-text);
}

.cs-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 18px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel);
}

.cs-title {
  min-width: 0;
}

.cs-title h1 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--app-text-strong);
}

.cs-summary-line {
  margin: 4px 0 0;
  overflow: hidden;
  color: var(--app-text-muted);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cs-header-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.phase-badge,
.count-pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.67rem;
  font-weight: 600;
  white-space: nowrap;
}

.phase-badge[data-phase='complete'] {
  border-color: color-mix(in srgb, var(--app-success) 38%, var(--app-border));
  color: var(--app-success);
}

.phase-badge[data-phase='blocked'] {
  border-color: color-mix(in srgb, var(--app-danger) 38%, var(--app-border));
  color: var(--app-danger);
}

.count-pill.danger {
  color: var(--app-danger);
}

.count-pill.warning {
  color: var(--app-warning);
}

.cs-empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 28px;
  color: var(--app-text-muted);
  font-size: 0.82rem;
}

.cs-empty p {
  margin: 0;
}

.cs-workbench {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(160px, 190px) minmax(0, 1fr) minmax(240px, 280px);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.phase-rail {
  min-width: 0;
  padding: 16px 14px;
  overflow: auto;
  border-right: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.phase-list {
  position: relative;
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.phase-list::before {
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: 7px;
  width: 1px;
  background: var(--app-border);
  content: '';
}

.phase-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 30px;
  padding: 2px 4px;
  color: var(--app-text-muted);
  font-size: 0.75rem;
}

.phase-tick {
  position: relative;
  z-index: 1;
  flex: 0 0 15px;
  width: 15px;
  height: 15px;
  border: 1px solid var(--app-border);
  border-radius: 50%;
  background: var(--app-panel-muted);
}

.phase-item[data-state='completed'] .phase-tick {
  border-color: var(--app-success);
  background: var(--app-success);
}

.phase-item[data-state='completed'] .phase-label {
  color: var(--app-success);
}

.phase-item[data-state='current'] .phase-tick {
  border-color: var(--app-accent);
  background: var(--app-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 16%, transparent);
}

.phase-item[data-state='current'] .phase-label {
  color: var(--app-text-strong);
  font-weight: 650;
}

.phase-label {
  min-width: 0;
}

.phase-meta {
  display: grid;
  gap: 7px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--app-border);
  color: var(--app-text-muted);
  font-size: 0.71rem;
}

.phase-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.phase-meta-row strong {
  color: var(--app-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-weight: 600;
}

.diagnostics-panel {
  min-width: 0;
  min-height: 0;
  padding: 16px 18px 24px;
  overflow: auto;
}

.diagnostics-panel h2 {
  margin: 0 0 9px;
  color: var(--app-text-muted);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.panel-empty {
  margin: 0;
  padding: 14px 0;
  border-top: 1px solid var(--app-border);
  color: var(--app-text-muted);
  font-size: 0.78rem;
}

.diagnostic-group {
  border-top: 1px solid var(--app-border);
}

.file-heading {
  margin: 0;
  padding: 10px 0 4px;
  overflow: hidden;
  color: var(--app-text-strong);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.72rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diagnostic-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.diagnostic-item {
  padding: 2px 0 8px;
}

.diagnostic-row {
  display: grid;
  grid-template-columns: 8px auto auto minmax(0, 1fr) auto auto auto;
  gap: 8px;
  align-items: start;
  padding: 6px 0;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
  font-size: 0.76rem;
}

/* Low-confidence findings are advisory. Keep them visually separate from
   diagnostics the harness is confident about and never auto-apply them. */
.diagnostic-row.is-suggestion {
  padding-left: 8px;
  border-left: 2px dashed color-mix(in srgb, var(--app-warning) 58%, transparent);
}

.diagnostic-row.is-suggestion .diag-message {
  color: var(--app-text-muted);
}

.suggestion-badge {
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 6px;
  border: 1px dashed color-mix(in srgb, var(--app-warning) 58%, transparent);
  border-radius: 999px;
  color: var(--app-warning);
  font-size: 0.62rem;
  font-weight: 650;
  white-space: nowrap;
}

.severity-dot {
  width: 7px;
  height: 7px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--app-text-muted);
}

.severity-dot[data-severity='error'] {
  background: var(--app-danger);
}

.severity-dot[data-severity='warning'] {
  background: var(--app-warning);
}

.severity-dot[data-severity='info'] {
  background: var(--app-accent);
}

.diag-code,
.diag-location,
.diag-confidence,
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.diag-code {
  padding: 1px 5px;
  border: 1px solid var(--app-border);
  border-radius: 4px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  font-size: 0.66rem;
}

.diag-location {
  color: var(--app-text-muted);
  font-size: 0.68rem;
  white-space: nowrap;
}

.diag-message {
  min-width: 0;
  color: var(--app-text);
  overflow-wrap: anywhere;
}

.diag-confidence {
  color: var(--app-text-muted);
  font-size: 0.66rem;
  white-space: nowrap;
}

.diag-confidence.is-suggestion {
  color: var(--app-warning);
  font-weight: 600;
}

.diag-confidence.is-confident {
  color: var(--app-success);
}

.diag-raw {
  margin: 2px 0 0 16px;
  color: var(--app-text-muted);
  font-size: 0.72rem;
}

.diag-raw summary {
  width: fit-content;
  cursor: pointer;
  font-size: 0.69rem;
}

.diag-raw pre {
  max-height: 220px;
  margin: 6px 0 0;
  padding: 8px;
  overflow: auto;
  border: 1px solid var(--app-border);
  background: var(--app-panel-muted);
  color: var(--app-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.68rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.diag-raw summary:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
}

.summary-panel {
  min-width: 0;
  min-height: 0;
  padding: 16px 14px 24px;
  overflow: auto;
  border-left: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.run-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-bottom: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--app-border);
}

.run-action {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--app-border-strong);
  border-radius: 999px;
  background: var(--app-panel);
  color: var(--app-accent);
  font: inherit;
  font-size: 0.68rem;
  font-weight: 600;
  cursor: pointer;
}

.run-action:hover:not(:disabled) {
  border-color: var(--app-accent);
  color: var(--app-accent-strong);
}

.run-action:disabled {
  color: var(--app-text-muted);
  cursor: not-allowed;
  opacity: 0.5;
}

.run-action:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}

.summary-definitions {
  display: grid;
  gap: 0;
  margin: 0;
}

.definition-row {
  display: grid;
  grid-template-columns: minmax(72px, 92px) minmax(0, 1fr);
  gap: 8px;
  padding: 10px 0;
  border-top: 1px solid var(--app-border);
}

.definition-row:first-child {
  padding-top: 0;
  border-top: 0;
}

.definition-row dt {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  color: var(--app-text-muted);
  font-size: 0.64rem;
  font-weight: 650;
  line-height: 1.45;
}

.definition-row dd {
  min-width: 0;
  margin: 0;
}

.definition-row dd.mono {
  color: var(--app-text);
  font-size: 0.7rem;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.block-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: var(--app-panel);
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.63rem;
  letter-spacing: 0;
}

.summary-value {
  margin: 0;
  color: var(--app-text);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.path-list,
.command-list,
.dependency-list,
.repair-list {
  display: grid;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.path-list li {
  overflow: hidden;
  color: var(--app-text-muted);
  font-size: 0.69rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-list li,
.dependency-list li {
  display: grid;
  gap: 4px;
  padding: 7px 0;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
  font-size: 0.72rem;
}

.command-list li:first-child,
.dependency-list li:first-child {
  border-top: 0;
  padding-top: 0;
}

.command-head {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.command-line {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  color: var(--app-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.69rem;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.inline-action,
.diag-action,
.raw-toggle {
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  background: none;
  color: var(--app-accent);
  font: inherit;
  font-size: 0.66rem;
  cursor: pointer;
  white-space: nowrap;
}

.inline-action:hover,
.diag-action:hover,
.raw-toggle:hover {
  color: var(--app-accent-strong);
  text-decoration: underline;
}

.inline-action:focus-visible,
.diag-action:focus-visible,
.raw-toggle:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
  border-radius: 2px;
}

.raw-toggle {
  justify-self: start;
  width: fit-content;
}

.command-raw {
  max-height: 220px;
  margin: 5px 0 0;
  padding: 8px;
  overflow: auto;
  border: 1px solid var(--app-border);
  border-radius: 5px;
  background: var(--app-panel);
  color: var(--app-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.67rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.command-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.64rem;
}

.dependency-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--app-text-strong);
}

.dependency-kind {
  color: var(--app-text-muted);
  font-size: 0.62rem;
  text-transform: lowercase;
}

.dependency-message {
  margin: 0;
  color: var(--app-text-muted);
  font-size: 0.7rem;
  overflow-wrap: anywhere;
}

.repair-list {
  padding-left: 17px;
  color: var(--app-text);
  font-size: 0.72rem;
  list-style: decimal;
}

.repair-list li {
  padding-left: 2px;
  overflow-wrap: anywhere;
}

@media (max-width: 899px) {
  .cs-workbench {
    grid-template-columns: minmax(0, 1fr);
    overflow: auto;
  }

  .phase-rail {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 16px;
    border-right: 0;
    border-bottom: 1px solid var(--app-border);
    overflow: visible;
  }

  .phase-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: 12px;
  }

  .phase-list::before {
    display: none;
  }

  .phase-meta {
    align-self: start;
    min-width: 148px;
    margin-top: 0;
    padding-top: 0;
    border-top: 0;
  }

  .diagnostics-panel {
    overflow: visible;
  }

  .summary-panel {
    overflow: visible;
    border-top: 1px solid var(--app-border);
    border-left: 0;
  }
}

@media (max-width: 620px) {
  .cs-header {
    flex-direction: column;
    gap: 9px;
  }

  .cs-header-meta {
    justify-content: flex-start;
  }

  .phase-rail {
    grid-template-columns: minmax(0, 1fr);
  }

  .phase-list {
    grid-template-columns: minmax(0, 1fr);
  }

  .phase-meta {
    margin-top: 4px;
    padding-top: 10px;
    border-top: 1px solid var(--app-border);
  }

  .diagnostic-row {
    grid-template-columns: 8px auto minmax(0, 1fr);
  }

  .diag-location,
  .diag-confidence,
  .suggestion-badge,
  .diag-action {
    grid-column: 2 / -1;
  }

  .diag-action {
    justify-self: start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .coding-status *,
  .coding-status *::before,
  .coding-status *::after {
    transition: none !important;
    animation: none !important;
  }
}
</style>
