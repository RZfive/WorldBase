<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/legacy/web/pdf_viewer.css'

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
  pdfBytes: Uint8Array
  selections: SelectionRegion[]
}>()

const emit = defineEmits<{
  (e: 'highlightSelection', payload: { text: string; pageIndex?: number }): void
}>()

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const containerRef = ref<HTMLDivElement | null>(null)
const viewerRef = ref<HTMLDivElement | null>(null)
const isLoading = ref(false)
const loadError = ref('')

let eventBus: EventBus | null = null
let linkService: PDFLinkService | null = null
let pdfViewer: PDFViewer | null = null
let loadingTask: PDFDocumentLoadingTask | null = null
let pdfDocument: PDFDocumentProxy | null = null
let activeLoadId = 0

async function ensureViewerReady () {
  await nextTick()
  if (pdfViewer || !containerRef.value || !viewerRef.value) return

  eventBus = new EventBus()
  linkService = new PDFLinkService({ eventBus })
  pdfViewer = new PDFViewer({
    container: containerRef.value,
    viewer: viewerRef.value,
    eventBus,
    linkService,
    textLayerMode: 1,
    annotationMode: 0,
    removePageBorders: false
  })
  linkService.setViewer(pdfViewer)

  eventBus.on('pagesinit', () => {
    if (pdfViewer) {
      pdfViewer.currentScaleValue = 'page-width'
    }
  })
}

async function destroyPdfDocument () {
  if (loadingTask) {
    try {
      await loadingTask.destroy()
    } catch {
      // ignore destroy races while replacing documents
    }
    loadingTask = null
  }

  if (viewerRef.value) {
    viewerRef.value.replaceChildren()
  }

  if (pdfDocument) {
    try {
      await pdfDocument.destroy()
    } catch {
      // ignore document destroy failures during unmount
    }
    pdfDocument = null
  }

  linkService?.setDocument(null)
}

async function loadPdfDocument (bytes: Uint8Array) {
  const loadId = ++activeLoadId

  if (!bytes || bytes.length === 0) {
    loadError.value = 'PDF 预览资源为空。'
    return
  }

  await ensureViewerReady()
  if (loadId !== activeLoadId || !pdfViewer) return

  await destroyPdfDocument()
  if (loadId !== activeLoadId || !pdfViewer) return

  isLoading.value = true
  loadError.value = ''

  try {
    loadingTask = getDocument({ data: bytes })
    const nextDocument = await loadingTask.promise
    if (loadId !== activeLoadId) {
      await nextDocument.destroy().catch(() => {})
      return
    }

    pdfDocument = nextDocument
    pdfViewer?.setDocument(pdfDocument)
    linkService?.setDocument(pdfDocument)
  } catch (error) {
    if (loadId !== activeLoadId) return
    loadError.value = `PDF 预览加载失败: ${(error as Error).message}`
  } finally {
    if (loadId === activeLoadId) {
      isLoading.value = false
    }
  }
}

function isSelectionInsidePdf (selection: Selection): boolean {
  const root = containerRef.value
  const { anchorNode, focusNode } = selection
  return !!root && !!anchorNode && !!focusNode && root.contains(anchorNode) && root.contains(focusNode)
}

function resolveSelectionPageIndex (selection: Selection): number | undefined {
  const anchorElement = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement
  const focusElement = selection.focusNode instanceof Element ? selection.focusNode : selection.focusNode?.parentElement
  const pageElement = anchorElement?.closest('.page[data-page-number]') || focusElement?.closest('.page[data-page-number]')
  const value = pageElement?.getAttribute('data-page-number')
  return value ? Number(value) : undefined
}

function handleTextSelection () {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
  if (!isSelectionInsidePdf(selection)) return

  const text = selection.toString().replace(/\s+/g, ' ').trim()
  if (!text) return

  emit('highlightSelection', {
    text,
    pageIndex: resolveSelectionPageIndex(selection)
  })
  selection.removeAllRanges()
}

watch(() => props.pdfBytes, (bytes) => {
  void loadPdfDocument(bytes)
})

onMounted(() => {
  void loadPdfDocument(props.pdfBytes)
})

onBeforeUnmount(() => {
  activeLoadId++
  void destroyPdfDocument()
})
</script>

<template>
  <div class="pdf-preview-root">
    <div v-if="loadError" class="pdf-state pdf-error">{{ loadError }}</div>
    <div v-else class="pdf-shell">
      <div ref="containerRef" class="pdf-container" @mouseup="handleTextSelection" @keyup="handleTextSelection">
        <div v-if="isLoading" class="pdf-state pdf-loading">正在生成真实文档预览…</div>
        <div ref="viewerRef" class="pdfViewer"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pdf-preview-root {
  position: relative;
  height: 100%;
  min-height: 100%;
}

.pdf-shell {
  position: relative;
  min-height: 360px;
  height: 100%;
}

.pdf-container {
  position: absolute;
  inset: 0;
  overflow: auto;
  background: #cfd6e4;
  border-radius: 10px;
  padding: 18px 0;
}

.pdf-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  padding: 18px;
  border-radius: 10px;
  text-align: center;
}

.pdf-loading {
  color: var(--app-text-muted);
  background: var(--app-panel-subtle);
}

.pdf-error {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 8%, var(--app-panel-subtle));
}

:deep(.pdfViewer) {
  --scale-factor: 1;
}

:deep(.pdfViewer .page) {
  margin: 0 auto 18px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
  border-radius: 4px;
  overflow: hidden;
}

:deep(.pdfViewer .textLayer) {
  opacity: 1;
}

:deep(.pdfViewer .textLayer ::selection) {
  background: color-mix(in srgb, var(--app-accent) 34%, transparent);
}
</style>
