<script setup lang="ts">
import { ref, watch } from 'vue'
import DocumentHtmlPreview from './DocumentHtmlPreview.vue'
import DocumentPdfPreview from './DocumentPdfPreview.vue'
import DocumentPreview from './DocumentPreview.vue'

interface DocumentNode {
  id: string
  type: 'heading' | 'paragraph' | 'table' | 'table_row' | 'slide' | 'page' | 'sheet' | 'image_placeholder' | 'list_item'
  text: string
  level: number
  pageIndex: number
  children?: DocumentNode[]
  meta?: Record<string, unknown>
}

interface DocumentRenderPreview {
  kind: 'pdf' | 'html' | 'structured'
  source: 'original' | 'generated' | 'fallback'
  status: 'ready' | 'unavailable'
  mimeType?: string
  assetPath?: string
  error?: string
  generatedAt: string
}

interface DocumentArtifact {
  id: string
  filePath: string
  fileName: string
  fileSize: number
  fileType: string
  plainText: string
  nodes: DocumentNode[]
  render?: DocumentRenderPreview
  importedAt: string
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

interface RenderAssetPayload {
  mimeType: string
  bytes: Uint8Array
}

const props = defineProps<{
  artifact: DocumentArtifact
  selections: SelectionRegion[]
}>()

const emit = defineEmits<{
  (e: 'highlightSelection', payload: { nodeIds?: string[]; text: string; pageIndex?: number }): void
}>()

const renderAsset = ref<RenderAssetPayload | null>(null)
const htmlContent = ref('')
const renderLoading = ref(false)
const renderError = ref('')

async function loadRenderAsset () {
  const render = props.artifact.render
  renderAsset.value = null
  htmlContent.value = ''

  if (!render || render.kind === 'structured' || render.status !== 'ready' || !window.electronAPI?.getDocumentRenderData) {
    renderError.value = render?.status === 'unavailable' ? (render.error || '') : ''
    return
  }

  renderLoading.value = true
  renderError.value = ''

  try {
    renderAsset.value = await window.electronAPI.getDocumentRenderData(props.artifact.id) as RenderAssetPayload | null
    if (!renderAsset.value) {
      renderError.value = render.error || '真实预览资源不可用，已回退到结构化视图。'
      return
    }

    if (render.kind === 'html') {
      htmlContent.value = new TextDecoder().decode(renderAsset.value.bytes)
    }
  } catch (error) {
    renderAsset.value = null
    htmlContent.value = ''
    renderError.value = (error as Error).message
  } finally {
    renderLoading.value = false
  }
}

watch(() => `${props.artifact.id}:${props.artifact.render?.generatedAt || ''}`, () => {
  void loadRenderAsset()
}, { immediate: true })
</script>

<template>
  <div class="document-render-host">
    <div v-if="renderLoading" class="render-state">正在准备真实文件预览…</div>
    <div v-else-if="renderAsset && props.artifact.render?.kind === 'pdf'" class="render-surface">
      <DocumentPdfPreview
        :key="`${props.artifact.id}:${props.artifact.render?.generatedAt || ''}:pdf`"
        :pdf-bytes="renderAsset.bytes"
        :selections="props.selections"
        @highlight-selection="emit('highlightSelection', $event)"
      />
    </div>
    <div v-else-if="htmlContent && props.artifact.render?.kind === 'html'" class="render-surface">
      <DocumentHtmlPreview
        :key="`${props.artifact.id}:${props.artifact.render?.generatedAt || ''}:html`"
        :html-content="htmlContent"
        :selections="props.selections"
        @highlight-selection="emit('highlightSelection', $event)"
      />
    </div>
    <div v-else class="render-surface">
      <div v-if="renderError" class="render-warning">{{ renderError }}</div>
      <DocumentPreview
        :nodes="props.artifact.nodes"
        :selections="props.selections"
        @highlight-selection="emit('highlightSelection', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.document-render-host {
  height: 100%;

}

.render-surface {
  min-height: 100%;
}

.render-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  padding: 18px;
  color: var(--app-text-muted);
  background: var(--app-panel-subtle);
  border-radius: 10px;
}

.render-warning {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  color: #92400e;
  background: color-mix(in srgb, #f59e0b 14%, var(--app-panel-subtle));
  border: 1px solid color-mix(in srgb, #f59e0b 28%, transparent);
  font-size: 0.82em;
}
</style>
