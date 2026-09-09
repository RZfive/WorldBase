<script setup lang="ts">
import { computed, ref } from 'vue'

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
  htmlContent: string
  selections: SelectionRegion[]
}>()

const emit = defineEmits<{
  (e: 'highlightSelection', payload: { text: string }): void
}>()

const previewRoot = ref<HTMLElement | null>(null)

function sanitizeHtml (rawHtml: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(rawHtml, 'text/html')

  doc.querySelectorAll('script, iframe, object, embed, meta, link, base, form').forEach(node => {
    node.remove()
  })

  for (const element of Array.from(doc.body.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name)
        continue
      }

      if ((name === 'href' || name === 'src') && /^javascript:/i.test(value)) {
        element.removeAttribute(attribute.name)
      }
    }
  }

  return doc.body.innerHTML
}

const safeHtml = computed(() => sanitizeHtml(props.htmlContent))

function isSelectionInsidePreview (selection: Selection): boolean {
  const root = previewRoot.value
  const { anchorNode, focusNode } = selection
  return !!root && !!anchorNode && !!focusNode && root.contains(anchorNode) && root.contains(focusNode)
}

function handleTextSelection () {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
  if (!isSelectionInsidePreview(selection)) return

  const text = selection.toString().replace(/\s+/g, ' ').trim()
  if (!text) return

  emit('highlightSelection', { text })
  selection.removeAllRanges()
}

function preventNavigation (event: MouseEvent) {
  const target = event.target as Element | null
  if (target?.closest('a')) {
    event.preventDefault()
  }
}
</script>

<template>
  <div
    ref="previewRoot"
    class="document-html-preview"
    @click.capture="preventNavigation"
    @mouseup="handleTextSelection"
    @keyup="handleTextSelection"
  >
    <div class="html-page-surface" v-html="safeHtml"></div>
  </div>
</template>

<style scoped>
.document-html-preview {
  min-height: 240px;
  padding: 18px;
  overflow: auto;
  background:
    linear-gradient(180deg, rgba(15, 23, 42, 0.02), rgba(15, 23, 42, 0.06)),
    #d8dee9;
  border-radius: 10px;
  user-select: text;
}

.html-page-surface {
  width: min(860px, 100%);
  margin: 0 auto;
  padding: 40px 48px;
  background: #fff;
  color: #111827;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  border-radius: 6px;
}

:deep(.html-page-surface *) {
  max-width: 100%;
}

:deep(.html-page-surface h1),
:deep(.html-page-surface h2),
:deep(.html-page-surface h3),
:deep(.html-page-surface h4),
:deep(.html-page-surface h5),
:deep(.html-page-surface h6) {
  margin: 1.1em 0 0.45em;
  line-height: 1.25;
  color: #0f172a;
}

:deep(.html-page-surface p),
:deep(.html-page-surface li) {
  margin: 0.55em 0;
  line-height: 1.7;
}

:deep(.html-page-surface table) {
  width: 100%;
  border-collapse: collapse;
  margin: 1em 0;
  font-size: 0.95em;
}

:deep(.html-page-surface th),
:deep(.html-page-surface td) {
  border: 1px solid #d1d5db;
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}

:deep(.html-page-surface th) {
  background: #f3f4f6;
}

:deep(.html-page-surface img) {
  display: block;
  margin: 0.8em auto;
}

:deep(.html-page-surface a) {
  color: #1d4ed8;
  text-decoration: underline;
}

:deep(.html-page-surface ::selection) {
  background: color-mix(in srgb, var(--app-accent) 34%, transparent);
}
</style>