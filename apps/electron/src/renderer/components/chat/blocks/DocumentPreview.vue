<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

interface DocumentNode {
  id: string
  type: 'heading' | 'paragraph' | 'table' | 'table_row' | 'slide' | 'page' | 'sheet' | 'image_placeholder' | 'list_item'
  text: string
  level: number
  pageIndex: number
  children?: DocumentNode[]
  meta?: Record<string, unknown>
}

interface SelectionRegion {
  id: string
  artifactId: string
  nodeIds: string[]
  label: string
  color: string
  excerpt?: string
  createdAt: string
}

const props = defineProps<{
  nodes: DocumentNode[]
  selections: SelectionRegion[]
}>()

const emit = defineEmits<{
  (e: 'highlightSelection', payload: { nodeIds: string[]; text: string }): void
}>()

const { t } = useI18n()
const previewRoot = ref<HTMLElement | null>(null)

const nodeSelectionMap = computed(() => {
  const map = new Map<string, { color: string; label: string; regionId: string }>()
  for (const selection of props.selections) {
    for (const nodeId of selection.nodeIds) {
      map.set(nodeId, { color: selection.color, label: selection.label, regionId: selection.id })
    }
  }
  return map
})

function getNodeClasses (node: DocumentNode) {
  const classes: string[] = [`node-${node.type}`]
  if (node.type === 'heading') classes.push(`heading-level-${node.level}`)
  if (nodeSelectionMap.value.has(node.id)) classes.push('node-highlighted')
  return classes
}

function getNodeStyle (node: DocumentNode) {
  const selection = nodeSelectionMap.value.get(node.id)
  if (selection) {
    return { '--highlight-color': selection.color, borderLeftColor: selection.color }
  }
  return {}
}

function getTypeIcon (type: DocumentNode['type']): string {
  switch (type) {
    case 'heading': return '📌'
    case 'paragraph': return ''
    case 'table': return '📊'
    case 'table_row': return ''
    case 'slide': return '🎞️'
    case 'page': return '📄'
    case 'sheet': return '📋'
    default: return ''
  }
}

function isExcelSheet (node: DocumentNode): boolean {
  return node.type === 'sheet' && !!node.children?.some(child => child.type === 'table_row')
}

function getSheetHeaders (node: DocumentNode): string[] {
  const headers = (node.meta?.headers as string[] | undefined) ?? []
  if (headers.length > 0) return headers

  const firstRow = node.children?.find(child => child.type === 'table_row')
  return (firstRow?.meta?.cells as string[] | undefined) ?? []
}

function getRowCells (node: DocumentNode): string[] {
  return (node.meta?.cells as string[] | undefined) ?? []
}

function getSheetHeaderLabel (header: string, index: number): string {
  return header || t('chatUi.excelColumnFallback', { index: index + 1 })
}

function isSelectionInsidePreview (selection: Selection): boolean {
  const root = previewRoot.value
  const { anchorNode, focusNode } = selection
  return !!root && !!anchorNode && !!focusNode && root.contains(anchorNode) && root.contains(focusNode)
}

function collectSelectedNodeIds (range: Range): string[] {
  const root = previewRoot.value
  if (!root) return []

  const nodeIds = new Set<string>()
  for (const element of root.querySelectorAll<HTMLElement>('[data-node-id]')) {
    try {
      if (!range.intersectsNode(element)) continue
      const nodeId = element.dataset.nodeId
      if (nodeId) nodeIds.add(nodeId)
    } catch {
      // Detached nodes can throw during range intersection checks.
    }
  }

  return Array.from(nodeIds)
}

function handleTextSelection () {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
  if (!isSelectionInsidePreview(selection)) return

  const text = selection.toString().replace(/\s+/g, ' ').trim()
  if (!text) return

  const nodeIds = collectSelectedNodeIds(selection.getRangeAt(0))
  if (nodeIds.length === 0) return

  emit('highlightSelection', { nodeIds, text })
  selection.removeAllRanges()
}
</script>

<template>
  <div ref="previewRoot" class="document-preview" @mouseup="handleTextSelection" @keyup="handleTextSelection">
    <div class="document-nodes">
      <template v-for="node in nodes" :key="node.id">
        <template v-if="isExcelSheet(node)">
          <div
            :data-node-id="node.id"
            class="document-node"
            :class="getNodeClasses(node)"
            :style="getNodeStyle(node)"
          >
            <span v-if="getTypeIcon(node.type)" class="node-icon">{{ getTypeIcon(node.type) }}</span>
            <span class="node-text">{{ node.text }}</span>
          </div>
          <div class="excel-table-wrap">
            <table class="excel-table">
              <thead>
                <tr>
                  <th class="row-num-col">#</th>
                  <th v-for="(header, headerIndex) in getSheetHeaders(node)" :key="headerIndex">{{ getSheetHeaderLabel(header, headerIndex) }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="child in node.children"
                  :key="child.id"
                  :data-node-id="child.id"
                  class="excel-row"
                  :class="getNodeClasses(child)"
                  :style="getNodeStyle(child)"
                >
                  <td class="row-num-col">{{ (child.meta?.rowNumber as number) ?? '' }}</td>
                  <td v-for="(cell, cellIndex) in getRowCells(child)" :key="cellIndex">{{ cell }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template v-else>
          <div
            :data-node-id="node.id"
            class="document-node"
            :class="getNodeClasses(node)"
            :style="getNodeStyle(node)"
          >
            <span v-if="getTypeIcon(node.type)" class="node-icon">{{ getTypeIcon(node.type) }}</span>
            <span class="node-text">{{ node.text }}</span>
          </div>

          <template v-if="node.children && node.children.length > 0">
            <div
              v-for="child in node.children"
              :key="child.id"
              :data-node-id="child.id"
              class="document-node child-node"
              :class="getNodeClasses(child)"
              :style="getNodeStyle(child)"
            >
              <span class="node-text">{{ child.text }}</span>
            </div>
          </template>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.document-preview {
  font-size: 0.88em;
  line-height: 1.6;
  user-select: text;
}

.document-nodes {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.document-node {
  padding: 6px 10px;
  border-radius: 6px;
  border-left: 3px solid transparent;
  transition: background 0.15s, border-left-color 0.15s;
  cursor: text;
  word-break: break-word;
}

.document-node:hover {
  background: var(--app-panel-muted);
}

.document-node.node-highlighted {
  background: color-mix(in srgb, var(--highlight-color, #3b82f6) 8%, transparent);
  border-left-color: var(--highlight-color, #3b82f6);
}

.child-node {
  padding-left: 24px;
}

.node-icon {
  margin-right: 6px;
}

.node-text {
  color: var(--app-text);
}

.node-heading { font-weight: 600; }
.heading-level-1 { font-size: 1.2em; }
.heading-level-2 { font-size: 1.1em; }
.heading-level-3 { font-size: 1.0em; }

.node-sheet,
.node-slide,
.node-page {
  font-weight: 600;
  color: var(--app-text-strong);
  padding-top: 10px;
  margin-top: 6px;
  border-top: 1px solid var(--app-border);
}

.node-table_row {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.88em;
  color: var(--app-text-soft);
}

.excel-table-wrap {
  overflow-x: auto;
  margin: 4px 0 8px 0;
  padding-left: 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.excel-table {
  border-collapse: collapse;
  font-size: 0.82em;
  width: max-content;
  min-width: 100%;
}

.excel-table th,
.excel-table td {
  border: 1px solid var(--app-border);
  padding: 4px 10px;
  text-align: left;
  white-space: nowrap;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.excel-table th {
  background: var(--app-panel-subtle);
  font-weight: 600;
  color: var(--app-text-strong);
  position: sticky;
  top: 0;
  z-index: 1;
}

.excel-table .row-num-col {
  width: 40px;
  min-width: 40px;
  text-align: center;
  color: var(--app-text-faint);
  font-size: 0.85em;
  background: var(--app-panel-subtle);
}

.excel-row {
  transition: background 0.12s;
  cursor: text;
}

.excel-row:hover {
  background: var(--app-panel-muted);
}

.excel-row.node-highlighted {
  background: color-mix(in srgb, var(--highlight-color, #3b82f6) 8%, transparent);
}

.excel-row.node-highlighted td:first-child {
  border-left: 3px solid var(--highlight-color, #3b82f6);
}
</style>
