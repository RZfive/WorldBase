<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  CodingDiffChange,
  CodingDiffFile,
  CodingDiffState
} from '../../../../shared/coding-status-types.js'
import { sharedChatPanelState } from '../../chat/panel/shared-state'

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

watch(
  () => files.value.length,
  (length) => {
    if (length === 0) activeIndex.value = 0
    else if (activeIndex.value >= length) activeIndex.value = length - 1
  }
)

interface DisplayLine {
  number: number
  text: string
}

function selectFile (index: number): void {
  activeIndex.value = index
}

function linesFor (text: string): DisplayLine[] {
  const normalized = (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((line, index) => ({ number: index + 1, text: line }))
}

function changeKey (change: CodingDiffChange, index: number): string {
  return `${change.operation}-${index}-${change.startByte ?? ''}-${change.endByte ?? ''}`
}
</script>

<template>
  <div class="coding-diff">
    <header class="diff-header">
      <h1>{{ t('chatUi.codingDiffTab') }}</h1>
      <span class="file-count">{{ t('chatUi.codingDiffFileCount', { count: files.length }) }}</span>
    </header>

    <div v-if="files.length === 0" class="diff-empty">
      <p>{{ t('chatUi.codingDiffEmpty') }}</p>
    </div>

    <div v-else class="diff-body">
      <nav class="file-rail" :aria-label="t('chatUi.codingDiffTab')">
        <button
          v-for="(file, index) in files"
          :key="file.filePath"
          type="button"
          class="file-entry"
          :class="{ active: index === activeIndex }"
          :title="file.filePath"
          :aria-current="index === activeIndex ? 'page' : undefined"
          @click="selectFile(index)"
        >
          <span class="file-path">{{ file.filePath }}</span>
          <span class="file-operation-count">{{ file.operationCount }}</span>
        </button>
      </nav>

      <main v-if="activeFile" class="diff-main">
        <header class="active-file-header">
          <h2>{{ activeFile.filePath }}</h2>
          <span class="change-count">{{ activeFile.changes.length }}</span>
        </header>

        <p v-if="activeFile.changes.length === 0" class="diff-empty inline">
          {{ t('chatUi.codingDiffEmpty') }}
        </p>

        <article
          v-for="(change, index) in activeFile.changes"
          :key="changeKey(change, index)"
          class="change-block"
        >
          <div class="change-meta">
            <span class="operation-chip">{{ change.operation }}</span>
            <span v-if="change.startByte != null" class="byte-range">
              {{ change.startByte }}–{{ change.endByte ?? change.startByte }}
            </span>
          </div>

          <div class="change-panes">
            <section class="change-pane removed" :aria-label="t('chatUi.codingDiffBefore')">
              <h3>{{ t('chatUi.codingDiffBefore') }}</h3>
              <pre><code><span
                v-for="line in linesFor(change.before)"
                :key="`before-${line.number}`"
                class="code-line"
                data-kind="removed"
              ><span class="gutter" aria-hidden="true">−</span><span class="line-number" aria-hidden="true">{{ line.number }}</span><span class="line-text">{{ line.text }}</span></span></code></pre>
            </section>

            <section class="change-pane added" :aria-label="t('chatUi.codingDiffAfter')">
              <h3>{{ t('chatUi.codingDiffAfter') }}</h3>
              <pre><code><span
                v-for="line in linesFor(change.after)"
                :key="`after-${line.number}`"
                class="code-line"
                data-kind="added"
              ><span class="gutter" aria-hidden="true">+</span><span class="line-number" aria-hidden="true">{{ line.number }}</span><span class="line-text">{{ line.text }}</span></span></code></pre>
            </section>
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

.diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel);
}

.diff-header h1 {
  margin: 0;
  color: var(--app-text-strong);
  font-size: 0.95rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.file-count {
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.69rem;
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
  display: grid;
  flex: 1;
  grid-template-columns: minmax(180px, 220px) minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.file-rail {
  min-width: 0;
  min-height: 0;
  padding: 8px;
  overflow: auto;
  border-right: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.file-entry {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  text-align: left;
}

.file-entry:hover {
  background: color-mix(in srgb, var(--app-panel) 70%, transparent);
}

.file-entry.active {
  border-color: var(--app-border);
  background: var(--app-panel);
  color: var(--app-text-strong);
}

.file-entry:focus-visible {
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
  padding: 14px 16px 24px;
  overflow: auto;
}

.active-file-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--app-border);
}

.active-file-header h2 {
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
  padding: 14px 0;
  border-bottom: 1px solid var(--app-border);
}

.change-block:last-child {
  border-bottom: 0;
}

.change-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.operation-chip {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border: 1px solid var(--app-border);
  border-radius: 4px;
  background: var(--app-panel-muted);
  color: var(--app-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.64rem;
  font-weight: 600;
}

.byte-range {
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.64rem;
}

.change-panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}

.change-pane {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: 5px;
  background: var(--app-chat-canvas);
}

.change-pane h3 {
  margin: 0;
  padding: 6px 9px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.change-pane pre {
  max-height: 380px;
  margin: 0;
  padding: 7px 0;
  overflow: auto;
  background: var(--app-chat-canvas);
  color: var(--app-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.7rem;
  line-height: 1.5;
  tab-size: 2;
}

.change-pane code {
  display: block;
  min-width: max-content;
  font: inherit;
}

.code-line {
  display: flex;
  min-height: 1.5em;
  white-space: pre;
}

.code-line[data-kind='removed'] {
  background: color-mix(in srgb, var(--app-danger) 9%, transparent);
}

.code-line[data-kind='added'] {
  background: color-mix(in srgb, var(--app-success) 9%, transparent);
}

.gutter {
  flex: 0 0 17px;
  width: 17px;
  padding-right: 5px;
  text-align: center;
  user-select: none;
}

.code-line[data-kind='removed'] .gutter {
  color: var(--app-danger);
}

.code-line[data-kind='added'] .gutter {
  color: var(--app-success);
}

.line-number {
  flex: 0 0 38px;
  width: 38px;
  padding-right: 9px;
  color: var(--app-text-muted);
  text-align: right;
  user-select: none;
}

.line-text {
  padding-right: 12px;
  white-space: pre;
}

@media (min-width: 1000px) {
  .change-panes {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}

@media (max-width: 779px) {
  .diff-body {
    grid-template-columns: minmax(0, 1fr);
    overflow: auto;
  }

  .file-rail {
    max-height: 170px;
    border-right: 0;
    border-bottom: 1px solid var(--app-border);
  }

  .diff-main {
    overflow: visible;
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
