<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(defineProps<{
  value: unknown
  maxHeight?: number
  minHeight?: number
  rowHeight?: number
}>(), {
  maxHeight: 320,
  minHeight: 96,
  rowHeight: 24
})

type JsonNodeKind = 'array' | 'object' | 'string' | 'number' | 'boolean' | 'null' | 'undefined'

interface JsonTreeRow {
  path: string
  depth: number
  label: string | null
  kind: JsonNodeKind
  expandable: boolean
  expanded: boolean
  text: string
  isRoot: boolean
}

interface ExpandQueueEntry {
  path: string
  value: Record<string, unknown> | unknown[]
}

const ROOT_PATH = '$'
const OVERSCAN = 8
const EXPAND_ALL_BATCH_SIZE = 300
const { t } = useI18n()

const viewportRef = ref<HTMLDivElement | null>(null)
const scrollTop = ref(0)
const expandingAll = ref(false)
const expandedPaths = reactive(new Set<string>())
let expandAllRunToken = 0

function getNodeKind (value: unknown): JsonNodeKind {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'undefined'
}

function isContainer (value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || (value !== null && typeof value === 'object')
}

function describeContainer (value: Record<string, unknown> | unknown[]): string {
  return Array.isArray(value)
    ? `[${t('settings.jsonTree.arrayItems', { count: value.length })}]`
    : `{${t('settings.jsonTree.objectFields', { count: Object.keys(value).length })}}`
}

function shouldExpandByDefault (value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.length <= 20
  }
  if (isContainer(value)) {
    const keyCount = Object.keys(value).length
    return keyCount > 0 && keyCount <= 12
  }
  return false
}

function formatPrimitive (value: unknown): string {
  if (typeof value === 'string') {
    const serialized = JSON.stringify(value)
    return serialized.length > 220 ? `${serialized.slice(0, 220)}…` : serialized
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (value === null) return 'null'
  if (typeof value === 'undefined') return 'undefined'
  return String(value)
}

function buildPath (parentPath: string, key: string): string {
  return `${parentPath}/${encodeURIComponent(key)}`
}

function appendRows (
  rows: JsonTreeRow[],
  value: unknown,
  path: string,
  depth: number,
  label: string | null,
  isRoot = false
): void {
  const kind = getNodeKind(value)
  const expandable = isContainer(value)
  const expanded = expandable ? expandedPaths.has(path) : false
  const text = expandable ? describeContainer(value) : formatPrimitive(value)

  rows.push({
    path,
    depth,
    label,
    kind,
    expandable,
    expanded,
    text,
    isRoot
  })

  if (!expandable || !expanded) {
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      appendRows(rows, item, buildPath(path, String(index)), depth + 1, `[${index}]`)
    })
    return
  }

  Object.entries(value).forEach(([key, childValue]) => {
    appendRows(rows, childValue, buildPath(path, key), depth + 1, key)
  })
}

function resetTree (): void {
  stopExpandAll()
  expandedPaths.clear()
  if (shouldExpandByDefault(props.value)) {
    expandedPaths.add(ROOT_PATH)
  }
  scrollTop.value = 0
  if (viewportRef.value) {
    viewportRef.value.scrollTop = 0
  }
}

function togglePath (path: string): void {
  stopExpandAll()
  if (expandedPaths.has(path)) {
    expandedPaths.delete(path)
    return
  }
  expandedPaths.add(path)
}

function expandOneLevel (): void {
  stopExpandAll()
  rows.value.forEach((row) => {
    if (row.expandable && !row.expanded) {
      expandedPaths.add(row.path)
    }
  })
}

function stopExpandAll (): void {
  expandAllRunToken += 1
  expandingAll.value = false
}

function expandAll (): void {
  if (!isContainer(props.value) || expandingAll.value) {
    return
  }

  stopExpandAll()

  const runToken = expandAllRunToken
  const stack: ExpandQueueEntry[] = [{
    path: ROOT_PATH,
    value: props.value
  }]

  expandingAll.value = true

  const processNextBatch = (): void => {
    if (runToken !== expandAllRunToken) {
      return
    }

    let processed = 0

    while (stack.length > 0 && processed < EXPAND_ALL_BATCH_SIZE) {
      const current = stack.pop()
      if (!current) {
        break
      }

      expandedPaths.add(current.path)

      if (Array.isArray(current.value)) {
        for (let index = current.value.length - 1; index >= 0; index -= 1) {
          const child = current.value[index]
          if (isContainer(child)) {
            stack.push({
              path: buildPath(current.path, String(index)),
              value: child
            })
          }
        }
      } else {
        const entries = Object.entries(current.value)
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const [key, child] = entries[index]
          if (isContainer(child)) {
            stack.push({
              path: buildPath(current.path, key),
              value: child
            })
          }
        }
      }

      processed += 1
    }

    if (runToken !== expandAllRunToken) {
      return
    }

    if (stack.length === 0) {
      expandingAll.value = false
      return
    }

    window.requestAnimationFrame(processNextBatch)
  }

  processNextBatch()
}

function collapseAll (): void {
  stopExpandAll()
  expandedPaths.clear()
  scrollTop.value = 0
  if (viewportRef.value) {
    viewportRef.value.scrollTop = 0
  }
}

function handleScroll (event: Event): void {
  scrollTop.value = (event.target as HTMLDivElement).scrollTop
}

watch(() => props.value, resetTree, { immediate: true })

const rows = computed(() => {
  const nextRows: JsonTreeRow[] = []
  appendRows(nextRows, props.value, ROOT_PATH, 0, null, true)
  return nextRows
})

const viewportHeight = computed(() => {
  const naturalHeight = rows.value.length * props.rowHeight + 2
  return Math.min(props.maxHeight, Math.max(props.minHeight, naturalHeight))
})

const totalHeight = computed(() => rows.value.length * props.rowHeight)
const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / props.rowHeight) - OVERSCAN))
const visibleCount = computed(() => Math.ceil(viewportHeight.value / props.rowHeight) + OVERSCAN * 2)
const endIndex = computed(() => Math.min(rows.value.length, startIndex.value + visibleCount.value))

const visibleRows = computed(() => {
  return rows.value.slice(startIndex.value, endIndex.value).map((row, offset) => ({
    ...row,
    top: (startIndex.value + offset) * props.rowHeight
  }))
})

const rootSummary = computed(() => {
  if (Array.isArray(props.value)) {
    return t('settings.jsonTree.rootArray', { count: props.value.length })
  }
  if (isContainer(props.value)) {
    return t('settings.jsonTree.rootObject', { count: Object.keys(props.value).length })
  }
  return t('settings.jsonTree.rootValue')
})

const hasCollapsedRows = computed(() => rows.value.some((row) => row.expandable && !row.expanded))
const hasExpandedRows = computed(() => rows.value.some((row) => row.expandable && row.expanded))

watch([totalHeight, viewportHeight], () => {
  const maxScrollTop = Math.max(0, totalHeight.value - viewportHeight.value)
  if (scrollTop.value > maxScrollTop) {
    scrollTop.value = maxScrollTop
    if (viewportRef.value) {
      viewportRef.value.scrollTop = maxScrollTop
    }
  }
})
</script>

<template>
  <div class="json-tree">
    <div class="json-tree-toolbar">
      <span class="json-tree-meta">{{ rootSummary }} · {{ $t('settings.jsonTree.visibleNodes', { count: rows.length }) }}</span>
      <div v-if="rows.length > 0" class="json-tree-actions">
        <button type="button" class="json-tree-action" :disabled="expandingAll || !hasCollapsedRows" @click="expandOneLevel">
          {{ $t('settings.jsonTree.expandOneLevel') }}
        </button>
        <button type="button" class="json-tree-action" :disabled="expandingAll || !hasCollapsedRows" @click="expandAll">
          {{ expandingAll ? $t('settings.jsonTree.expandingAll') : $t('settings.jsonTree.expandAll') }}
        </button>
        <button type="button" class="json-tree-action" :disabled="!hasExpandedRows && !expandingAll" @click="collapseAll">
          {{ $t('settings.jsonTree.collapseAll') }}
        </button>
      </div>
    </div>

    <div
      ref="viewportRef"
      class="json-tree-viewport"
      :style="{ height: `${viewportHeight}px` }"
      @scroll="handleScroll"
    >
      <div class="json-tree-spacer" :style="{ height: `${totalHeight}px` }">
        <div
          v-for="row in visibleRows"
          :key="row.path"
          :class="['json-tree-row', `kind-${row.kind}`, { root: row.isRoot, clickable: row.expandable }]"
          :style="{
            top: `${row.top}px`,
            height: `${rowHeight}px`,
            paddingLeft: `${12 + row.depth * 18}px`
          }"
          :title="row.label ? `${row.label}: ${row.text}` : row.text"
          @click="row.expandable && togglePath(row.path)"
        >
          <button
            v-if="row.expandable"
            type="button"
            class="json-tree-toggle"
            :aria-label="row.expanded ? $t('settings.jsonTree.collapseNode') : $t('settings.jsonTree.expandNode')"
            @click.stop="togglePath(row.path)"
          >
            {{ row.expanded ? '▾' : '▸' }}
          </button>
          <span v-else class="json-tree-toggle json-tree-toggle-placeholder"></span>

          <span v-if="row.label" class="json-tree-key">{{ row.label }}</span>
          <span v-if="row.label" class="json-tree-colon">:</span>
          <span class="json-tree-value">{{ row.text }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.json-tree {
  --json-tree-bg: var(--app-panel-strong);
  --json-tree-toolbar-bg: var(--app-panel-muted);
  --json-tree-hover-bg: var(--app-panel-subtle);
  --json-tree-root-bg: var(--app-accent-soft);
  --json-tree-key-color: #7dd3fc;
  --json-tree-string-color: #fbbf24;
  --json-tree-number-color: #86efac;
  --json-tree-null-color: #fca5a5;
  border: 1px solid var(--app-border-strong);
  border-radius: 10px;
  background: var(--json-tree-bg);
  overflow: hidden;
}

:global(:root[data-theme='light']) .json-tree {
  --json-tree-bg: rgba(255, 255, 255, 0.96);
  --json-tree-toolbar-bg: rgba(2, 132, 199, 0.08);
  --json-tree-hover-bg: rgba(2, 132, 199, 0.06);
  --json-tree-root-bg: rgba(2, 132, 199, 0.1);
  --json-tree-key-color: #075985;
  --json-tree-string-color: #9a3412;
  --json-tree-number-color: #166534;
  --json-tree-null-color: #b91c1c;
}

.json-tree-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--app-border);
  background: var(--json-tree-toolbar-bg);
}

.json-tree-meta {
  font-size: 0.74em;
  color: var(--app-text-muted);
}

.json-tree-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.json-tree-action {
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: var(--app-main-surface);
  color: var(--app-text-soft);
  font-size: 0.72em;
  padding: 4px 10px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.json-tree-action:hover:not(:disabled) {
  border-color: var(--app-border-strong);
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
}

.json-tree-action:disabled {
  opacity: 0.55;
  cursor: default;
}

.json-tree-viewport {
  overflow: auto;
  background: var(--json-tree-bg);
}

.json-tree-spacer {
  position: relative;
  min-width: 100%;
}

.json-tree-row {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 12px;
  font-family: 'SFMono-Regular', 'Consolas', monospace;
  font-size: 0.76em;
  line-height: 1;
  white-space: nowrap;
}

.json-tree-row.clickable {
  cursor: pointer;
}

.json-tree-row:hover {
  background: var(--json-tree-hover-bg);
}

.json-tree-row.root {
  font-weight: 600;
  background: var(--json-tree-root-bg);
}

.json-tree-toggle {
  width: 16px;
  border: none;
  padding: 0;
  background: transparent;
  color: var(--app-text-muted);
  font: inherit;
  cursor: pointer;
  flex-shrink: 0;
}

.json-tree-toggle-placeholder {
  cursor: default;
}

.json-tree-key {
  color: var(--json-tree-key-color);
  flex-shrink: 0;
}

.json-tree-colon {
  color: var(--app-text-muted);
  flex-shrink: 0;
}

.json-tree-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kind-string .json-tree-value {
  color: var(--json-tree-string-color);
}

.kind-number .json-tree-value,
.kind-boolean .json-tree-value {
  color: var(--json-tree-number-color);
}

.kind-null .json-tree-value,
.kind-undefined .json-tree-value {
  color: var(--json-tree-null-color);
}

.kind-array .json-tree-value,
.kind-object .json-tree-value {
  color: var(--app-text-soft);
}
</style>
