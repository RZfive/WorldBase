<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  CodingDiffChange,
  CodingDiffFile,
  CodingDiffState
} from '../../../../shared/coding-status-types.js'
import { sharedChatPanelState } from '../../chat/panel/shared-state'
import { ensureWorkspaceTab, workspaceStore } from '../workspace-store'

const props = defineProps<{
  conversationId: string
}>()

const { t } = useI18n()

const diff = computed<CodingDiffState | null>(() => (
  sharedChatPanelState.codingDiffByConversation.get(props.conversationId) || null
))

const files = computed<CodingDiffFile[]>(() => diff.value?.files ?? [])
const activeIndex = ref(0)
const activeFile = computed<CodingDiffFile | null>(() => files.value[activeIndex.value] ?? null)

const focusFilePath = computed(() => {
  const activeTab = workspaceStore.tabs.value.find(tab => tab.id === workspaceStore.activeTabId.value)
  if (!activeTab || activeTab.kind !== 'coding-diff') return ''
  if (activeTab.state?.conversationId !== props.conversationId) return ''
  const value = activeTab.state?.focusFilePath
  return typeof value === 'string' ? value.trim() : ''
})

const focusRequestId = computed(() => {
  const activeTab = workspaceStore.tabs.value.find(tab => tab.id === workspaceStore.activeTabId.value)
  if (!activeTab || activeTab.kind !== 'coding-diff') return ''
  if (activeTab.state?.conversationId !== props.conversationId) return ''
  const value = activeTab.state?.focusRequestId
  return typeof value === 'string' ? value : ''
})

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

function applyFocusFilePath (): void {
  const target = focusFilePath.value
  if (!target) return
  const index = files.value.findIndex(file => pathsMatch(file.filePath, target))
  if (index >= 0) activeIndex.value = index
}

watch(
  () => files.value.length,
  (length) => {
    if (length === 0) activeIndex.value = 0
    else if (activeIndex.value >= length) activeIndex.value = length - 1
    applyFocusFilePath()
  }
)

watch([focusFilePath, focusRequestId], () => {
  applyFocusFilePath()
}, { immediate: true })

function isAbsolutePath (filePath: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/)/.test(filePath)
}

/** Relative harness paths resolve against the conversation's folder root. */
function resolveFilePath (filePath: string): string {
  const trimmed = filePath.trim()
  if (!trimmed) return ''
  if (isAbsolutePath(trimmed)) return trimmed
  const root = workspaceStore.folderRootPath.value?.trim()
  if (!root) return ''
  return `${root.replace(/[\\/]+$/, '')}/${trimmed.replace(/^[\\/]+/, '')}`
}

const canOpenActiveFile = computed(() => Boolean(activeFile.value && resolveFilePath(activeFile.value.filePath)))

function getFileName (filePath: string): string {
  const segments = filePath.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || filePath
}

function openActiveFile (): void {
  if (!activeFile.value) return
  const filePath = resolveFilePath(activeFile.value.filePath)
  if (!filePath) return
  ensureWorkspaceTab('document', { filePath, fileName: getFileName(filePath) })
  workspaceStore.visible.value = true
}

interface DiffRow {
  kind: 'added' | 'removed' | 'context'
  oldNumber: number | null
  newNumber: number | null
  text: string
}

interface ChangeView {
  key: string
  operation: string
  startByte?: number
  endByte?: number
  rows: DiffRow[]
  additions: number
  deletions: number
}

/** Guard the O(n*m) LCS table; larger hunks fall back to a coarse replacement. */
const MAX_DIFF_MATRIX_CELLS = 4_000_000

const COPY_PREFIX: Record<DiffRow['kind'], string> = {
  added: '+',
  removed: '-',
  context: ' '
}

function splitDiffLines (text: string): string[] {
  const normalized = (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized) return []
  const lines = normalized.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function coarseRows (
  before: string[],
  after: string[],
  oldOffset: number,
  newOffset: number
): DiffRow[] {
  const rows: DiffRow[] = []
  before.forEach((text, index) => {
    rows.push({ kind: 'removed', oldNumber: oldOffset + index + 1, newNumber: null, text })
  })
  after.forEach((text, index) => {
    rows.push({ kind: 'added', oldNumber: null, newNumber: newOffset + index + 1, text })
  })
  return rows
}

function diffRowsForMiddle (
  before: string[],
  after: string[],
  oldOffset: number,
  newOffset: number
): DiffRow[] {
  const beforeLength = before.length
  const afterLength = after.length
  if (beforeLength === 0) {
    return after.map((text, index) => ({
      kind: 'added' as const,
      oldNumber: null,
      newNumber: newOffset + index + 1,
      text
    }))
  }
  if (afterLength === 0) {
    return before.map((text, index) => ({
      kind: 'removed' as const,
      oldNumber: oldOffset + index + 1,
      newNumber: null,
      text
    }))
  }
  if ((beforeLength + 1) * (afterLength + 1) > MAX_DIFF_MATRIX_CELLS) {
    return coarseRows(before, after, oldOffset, newOffset)
  }

  const width = afterLength + 1
  const table = new Int32Array((beforeLength + 1) * width)
  for (let i = beforeLength - 1; i >= 0; i -= 1) {
    const row = i * width
    const nextRow = row + width
    for (let j = afterLength - 1; j >= 0; j -= 1) {
      table[row + j] = before[i] === after[j]
        ? table[nextRow + j + 1] + 1
        : Math.max(table[nextRow + j], table[row + j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < beforeLength && j < afterLength) {
    if (before[i] === after[j]) {
      rows.push({
        kind: 'context',
        oldNumber: oldOffset + i + 1,
        newNumber: newOffset + j + 1,
        text: before[i]
      })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      rows.push({ kind: 'removed', oldNumber: oldOffset + i + 1, newNumber: null, text: before[i] })
      i += 1
    } else {
      rows.push({ kind: 'added', oldNumber: null, newNumber: newOffset + j + 1, text: after[j] })
      j += 1
    }
  }
  while (i < beforeLength) {
    rows.push({ kind: 'removed', oldNumber: oldOffset + i + 1, newNumber: null, text: before[i] })
    i += 1
  }
  while (j < afterLength) {
    rows.push({ kind: 'added', oldNumber: null, newNumber: newOffset + j + 1, text: after[j] })
    j += 1
  }
  return rows
}

function buildUnifiedRows (beforeText: string, afterText: string): DiffRow[] {
  const before = splitDiffLines(beforeText)
  const after = splitDiffLines(afterText)

  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const rows: DiffRow[] = []
  for (let index = 0; index < prefix; index += 1) {
    rows.push({ kind: 'context', oldNumber: index + 1, newNumber: index + 1, text: before[index] })
  }
  rows.push(...diffRowsForMiddle(
    before.slice(prefix, before.length - suffix),
    after.slice(prefix, after.length - suffix),
    prefix,
    prefix
  ))
  for (let index = 0; index < suffix; index += 1) {
    const oldIndex = before.length - suffix + index
    const newIndex = after.length - suffix + index
    rows.push({
      kind: 'context',
      oldNumber: oldIndex + 1,
      newNumber: newIndex + 1,
      text: before[oldIndex]
    })
  }
  return rows
}

function changeKey (change: CodingDiffChange, index: number): string {
  return `${change.operation}-${index}-${change.startByte ?? ''}-${change.endByte ?? ''}`
}

function toChangeView (change: CodingDiffChange, index: number): ChangeView {
  const rows = buildUnifiedRows(change.before, change.after)
  let additions = 0
  let deletions = 0
  for (const row of rows) {
    if (row.kind === 'added') additions += 1
    else if (row.kind === 'removed') deletions += 1
  }
  return {
    key: changeKey(change, index),
    operation: change.operation,
    startByte: change.startByte,
    endByte: change.endByte,
    rows,
    additions,
    deletions
  }
}

const changeViews = computed<ChangeView[]>(() => {
  const file = activeFile.value
  if (!file) return []
  return file.changes.map(toChangeView)
})

function formatByteRange (change: CodingDiffChange): string {
  if (change.startByte == null) return ''
  return `${change.startByte}–${change.endByte ?? change.startByte}`
}

function buildDiffText (file: CodingDiffFile): string {
  const lines: string[] = [file.filePath]
  file.changes.forEach((change, index) => {
    const range = formatByteRange(change)
    const header = range ? `# ${change.operation} ${range}` : `# ${change.operation}`
    lines.push('')
    lines.push(file.changes.length > 1 ? `${header} (${index + 1}/${file.changes.length})` : header)
    for (const row of buildUnifiedRows(change.before, change.after)) {
      lines.push(`${COPY_PREFIX[row.kind]}${row.text}`)
    }
  })
  return lines.join('\n')
}

function markerFor (kind: DiffRow['kind']): string {
  if (kind === 'added') return '+'
  if (kind === 'removed') return '−'
  return ' '
}

const copiedToken = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | null = null

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

function copyActivePath (): void {
  if (!activeFile.value) return
  void copyText(activeFile.value.filePath, 'path')
}

function copyActiveDiff (): void {
  if (!activeFile.value) return
  void copyText(buildDiffText(activeFile.value), 'diff')
}

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})

function selectFile (index: number): void {
  activeIndex.value = index
}
</script>

<template>
  <div class="coding-diff">
    <div v-if="files.length === 0" class="diff-empty">
      <p>{{ t('chatUi.codingDiffEmpty') }}</p>
    </div>

    <div v-else class="diff-body">
      <div class="file-tabs-row">
        <nav class="file-tabs" :aria-label="t('chatUi.codingDiffTab')">
          <button
            v-for="(file, index) in files"
            :key="file.filePath"
            type="button"
            class="file-tab"
            :class="{ active: index === activeIndex }"
            :title="file.filePath"
            :aria-current="index === activeIndex ? 'page' : undefined"
            @click="selectFile(index)"
          >
            <span class="file-path">{{ file.filePath }}</span>
            <span class="file-operation-count">{{ file.operationCount }}</span>
          </button>
        </nav>
        <span class="file-tabs-count">{{ t('chatUi.codingDiffFileCount', { count: files.length }) }}</span>
      </div>

      <main v-if="activeFile" class="diff-main">
        <header class="active-file-header">
          <h2>{{ activeFile.filePath }}</h2>
          <div class="active-file-actions">
            <span class="change-count">{{ activeFile.changes.length }}</span>
            <button
              type="button"
              class="file-action"
              :disabled="!canOpenActiveFile"
              :title="canOpenActiveFile ? t('chatUi.codingOpenFile') : t('chatUi.codingOpenFileUnavailable')"
              :aria-label="t('chatUi.codingOpenFile')"
              @click="openActiveFile"
            >
              {{ t('chatUi.codingOpenFile') }}
            </button>
            <button
              type="button"
              class="file-action"
              :aria-label="t('chatUi.codingCopyPath')"
              @click="copyActivePath"
            >
              {{ isCopied('path') ? t('chatUi.codingCopied') : t('chatUi.codingCopyPath') }}
            </button>
            <button
              type="button"
              class="file-action"
              :aria-label="t('chatUi.codingCopyDiff')"
              @click="copyActiveDiff"
            >
              {{ isCopied('diff') ? t('chatUi.codingCopied') : t('chatUi.codingCopyDiff') }}
            </button>
          </div>
        </header>

        <p v-if="activeFile.changes.length === 0" class="diff-empty inline">
          {{ t('chatUi.codingDiffEmpty') }}
        </p>

        <article
          v-for="change in changeViews"
          :key="change.key"
          class="change-block"
        >
          <div class="change-meta">
            <span class="operation-chip">{{ change.operation }}</span>
            <span v-if="change.startByte != null" class="byte-range">
              {{ change.startByte }}–{{ change.endByte ?? change.startByte }}
            </span>
            <span class="change-stats" aria-hidden="true">
              <span class="stat-add">+{{ change.additions }}</span>
              <span class="stat-del">−{{ change.deletions }}</span>
            </span>
          </div>

          <div
            class="change-diff"
            role="group"
            tabindex="0"
            :aria-label="`${change.operation}${change.startByte != null ? ` · ${change.startByte}–${change.endByte ?? change.startByte}` : ''}`"
          >
            <div
              v-for="(row, rowIndex) in change.rows"
              :key="rowIndex"
              class="diff-line"
              :class="row.kind"
            >
              <span class="diff-gutter diff-marker" aria-hidden="true">{{ markerFor(row.kind) }}</span>
              <span class="diff-gutter diff-line-number old" aria-hidden="true">{{ row.oldNumber ?? '' }}</span>
              <span class="diff-gutter diff-line-number new" aria-hidden="true">{{ row.newNumber ?? '' }}</span>
              <span class="diff-text">{{ row.text }}</span>
            </div>
          </div>
        </article>
      </main>
    </div>
  </div>
</template>

<style scoped>
.coding-diff {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--app-panel);
  color: var(--app-text);
}

.diff-empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 28px;
  color: var(--app-text-muted);
  font-size: 0.82rem;
}

.diff-empty p {
  margin: 0;
}

.diff-empty.inline {
  flex: 0 0 auto;
  justify-content: flex-start;
  padding: 18px 0;
}

.diff-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* File tabs stay on one line above the diff so the code column gets the full
   panel width instead of losing ~200px to a vertical file rail. */
.file-tabs-row {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.file-tabs {
  display: flex;
  flex: 1 1 auto;
  gap: 4px;
  min-width: 0;
  padding: 6px 10px;
  overflow-x: auto;
  scrollbar-width: thin;
}

.file-tabs-count {
  flex: 0 0 auto;
  padding-right: 12px;
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.69rem;
  white-space: nowrap;
}

.file-tab {
  display: inline-flex;
  flex: 0 1 auto;
  max-width: min(300px, 46vw);
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}

.file-tab:hover {
  background: color-mix(in srgb, var(--app-panel) 70%, transparent);
}

.file-tab.active {
  border-color: var(--app-border);
  background: var(--app-panel);
  color: var(--app-text-strong);
}

.file-tab:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -1px;
}

.file-path {
  min-width: 0;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.69rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-operation-count {
  flex: 0 0 auto;
  min-width: 18px;
  padding: 1px 5px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.62rem;
  text-align: center;
}

.diff-main {
  min-width: 0;
  min-height: 0;
  padding: 12px 16px 24px;
  overflow-x: hidden;
  overflow-y: auto;
}

.active-file-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  min-width: 0;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--app-border);
}

.active-file-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.file-action {
  appearance: none;
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

.file-action:hover:not(:disabled) {
  color: var(--app-accent-strong);
  text-decoration: underline;
}

.file-action:disabled {
  color: var(--app-text-muted);
  cursor: not-allowed;
  opacity: 0.55;
}

.file-action:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
  border-radius: 2px;
}

.active-file-header h2 {
  flex: 1 1 220px;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--app-text-strong);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.74rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-count {
  flex: 0 0 auto;
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.66rem;
}

.change-block {
  min-width: 0;
  padding: 12px 0;
  border-bottom: 1px solid var(--app-border);
}

.change-block:last-child {
  border-bottom: 0;
}

.change-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  min-width: 0;
  margin-bottom: 6px;
}

.operation-chip {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border: 1px solid var(--app-border);
  border-radius: 4px;
  background: var(--app-panel-muted);
  color: var(--app-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.6rem;
  font-weight: 600;
}

.byte-range {
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.6rem;
}

.change-stats {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.62rem;
  font-variant-numeric: tabular-nums;
}

.stat-add {
  color: var(--app-success);
}

.stat-del {
  color: var(--app-danger);
}

.change-diff {
  max-width: 100%;
  max-height: 460px;
  overflow: auto;
  border: 1px solid var(--app-border);
  border-radius: 5px;
  background: var(--app-panel);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.72rem;
  line-height: 1.5;
  tab-size: 2;
}

.change-diff:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
}

.diff-line {
  display: flex;
  width: max-content;
  min-width: 100%;
  min-height: 1.5em;
  border-left: 2px solid transparent;
  white-space: pre;
}

.diff-line.added {
  border-left-color: var(--app-success);
  background: var(--app-success-soft);
  color: var(--app-success);
}

.diff-line.removed {
  border-left-color: var(--app-danger);
  background: var(--app-danger-soft);
  color: var(--app-danger);
}

.diff-line.context {
  color: var(--app-text);
}

.diff-gutter {
  flex: 0 0 auto;
  color: var(--app-text-muted);
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.diff-marker {
  width: 17px;
  padding-right: 4px;
  text-align: center;
}

.diff-line-number {
  width: 38px;
  padding-right: 7px;
  text-align: right;
}

.diff-line-number.new {
  border-right: 1px solid var(--app-border);
}

.diff-line.added .diff-gutter,
.diff-line.removed .diff-gutter {
  color: inherit;
  opacity: 0.72;
}

.diff-text {
  padding: 0 12px 0 8px;
  white-space: pre;
}

@media (max-width: 899px) {
  .active-file-actions {
    justify-content: flex-start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .coding-diff *,
  .coding-diff *::before,
  .coding-diff *::after {
    transition: none !important;
    animation: none !important;
  }
}
</style>
