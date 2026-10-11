<script setup lang="ts">
import { computed, ref } from 'vue'
import { renderMarkdown } from '../markdown'
import { splitMarkdownWithMermaid, type MarkdownSegment } from '../mermaid'
import MermaidDiagram from '../media/MermaidDiagram.vue'

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
  markdownSource: string
  selections: SelectionRegion[]
}>()

const emit = defineEmits<{
  (e: 'highlightSelection', payload: { text: string }): void
}>()

const previewRoot = ref<HTMLElement | null>(null)

/**
 * Renders the file through the exact chat Markdown pipeline: the mermaid
 * splitter pulls ```mermaid blocks out for MermaidDiagram, everything else
 * goes through renderMarkdown (GFM tables, code highlight, KaTeX, footnotes)
 * and inherits the global .markdown-body styles the chat bubbles use.
 */
const segments = computed<Array<MarkdownSegment & { html?: string }>>(() => {
  return splitMarkdownWithMermaid(props.markdownSource).map(segment => (
    segment.type === 'markdown'
      ? { ...segment, html: renderMarkdown(segment.text) }
      : segment
  ))
})

function isSelectionInsidePreview (selection: Selection): boolean {
  const root = previewRoot.value
  const { anchorNode, focusNode } = selection
  return !!root && !!anchorNode && !!focusNode && root.contains(anchorNode) && root.contains(focusNode)
}

function handleTextSelection (): void {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
  if (!isSelectionInsidePreview(selection)) return

  const text = selection.toString().replace(/\s+/g, ' ').trim()
  if (!text) return

  emit('highlightSelection', { text })
  selection.removeAllRanges()
}

function preventNavigation (event: MouseEvent): void {
  const target = event.target as Element | null
  if (target?.closest('a')) {
    event.preventDefault()
  }
}
</script>

<template>
  <div
    ref="previewRoot"
    class="document-markdown-preview"
    @click.capture="preventNavigation"
    @mouseup="handleTextSelection"
    @keyup="handleTextSelection"
  >
    <div class="markdown-page-surface">
      <template v-for="(segment, index) in segments" :key="index">
        <div v-if="segment.type === 'markdown'" class="markdown-body" v-html="segment.html"></div>
        <MermaidDiagram v-else class="document-mermaid-card" :code="segment.text" previewable />
      </template>
    </div>
  </div>
</template>

<style scoped>
.document-markdown-preview {
  min-height: 240px;
  padding: 18px;
  overflow: auto;
  background:
    linear-gradient(180deg, rgba(15, 23, 42, 0.02), rgba(15, 23, 42, 0.06)),
    #d8dee9;
  border-radius: 10px;
  user-select: text;
}

/*
 * The document preview shows Markdown on a white page, but the global
 * .markdown-body rules resolve against the app theme (dark-mode values would
 * be light-on-white). Re-scope every theme variable those rules use to light
 * values inside the page surface so the chat styling carries over legibly.
 */
.markdown-page-surface {
  --app-accent: #2563eb;
  --app-accent-strong: #1d4ed8;
  --app-border-strong: #cbd5e1;
  --app-panel: #ffffff;
  --app-panel-muted: #f1f5f9;
  --app-panel-strong: #f8fafc;
  --app-text: #111827;
  --app-text-faint: #94a3b8;
  --app-text-muted: #475569;
  --app-text-soft: #334155;
  --app-text-strong: #0f172a;
  --chat-font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --chat-font-size: 0.95rem;
  width: min(860px, 100%);
  margin: 0 auto;
  padding: 40px 48px;
  background: #fff;
  color: #111827;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  border-radius: 6px;
}

.markdown-page-surface :deep(img) {
  max-width: 100%;
}

.document-mermaid-card {
  margin: 12px 0;
}
</style>
