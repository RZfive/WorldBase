<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import DocumentHtmlPreview from './DocumentHtmlPreview.vue'
import DocumentMarkdownPreview from './DocumentMarkdownPreview.vue'
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
  kind: 'pdf' | 'html' | 'markdown' | 'image' | 'structured'
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
const markdownSource = ref('')
const imageObjectUrl = ref('')
const renderLoading = ref(false)
const renderError = ref('')
let renderLoadToken = 0
const { t } = useI18n()

function clearImageObjectUrl (): void {
  if (!imageObjectUrl.value) return
  URL.revokeObjectURL(imageObjectUrl.value)
  imageObjectUrl.value = ''
}

onBeforeUnmount(() => {
  renderLoadToken += 1
  clearImageObjectUrl()
})

async function loadRenderAsset () {
  const token = ++renderLoadToken
  const render = props.artifact.render
  renderAsset.value = null
  htmlContent.value = ''
  markdownSource.value = ''
  renderLoading.value = false
  clearImageObjectUrl()

  if (!render || render.kind === 'structured' || render.status !== 'ready' || !window.electronAPI?.getDocumentRenderData) {
    renderError.value = render?.status === 'unavailable' ? (render.error || '') : ''
    return
  }

  renderLoading.value = true
  renderError.value = ''

  try {
    const asset = await window.electronAPI.getDocumentRenderData(props.artifact.id) as RenderAssetPayload | null
    if (token !== renderLoadToken) return
    renderAsset.value = asset
    if (!asset) {
      renderError.value = render.error || t('chatUi.documentRenderUnavailableFallback')
      return
    }

    if (render.kind === 'image') {
      const imageBytes = new Uint8Array(asset.bytes)
      imageObjectUrl.value = URL.createObjectURL(new Blob([imageBytes], {
        type: asset.mimeType || render.mimeType || 'application/octet-stream'
      }))
    } else if (render.kind === 'html' || render.kind === 'markdown') {
      const decoded = new TextDecoder().decode(asset.bytes)
      if (render.kind === 'html') {
        htmlContent.value = decoded
      } else {
        markdownSource.value = decoded
      }
    }
  } catch (error) {
    if (token !== renderLoadToken) return
    renderAsset.value = null
    htmlContent.value = ''
    markdownSource.value = ''
    clearImageObjectUrl()
    renderError.value = (error as Error).message
  } finally {
    if (token === renderLoadToken) renderLoading.value = false
  }
}

watch(() => `${props.artifact.id}:${props.artifact.render?.generatedAt || ''}`, () => {
  void loadRenderAsset()
}, { immediate: true })
</script>

<template>
  <div class="document-render-host">
    <div v-if="renderLoading" class="render-state">{{ $t('chatUi.preparingRealFilePreview') }}</div>
    <div v-else-if="imageObjectUrl && props.artifact.render?.kind === 'image'" class="render-surface image-render-surface">
      <img :src="imageObjectUrl" :alt="props.artifact.fileName" draggable="false">
    </div>
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
    <div v-else-if="markdownSource && props.artifact.render?.kind === 'markdown'" class="render-surface">
      <DocumentMarkdownPreview
        :key="`${props.artifact.id}:${props.artifact.render?.generatedAt || ''}:markdown`"
        :markdown-source="markdownSource"
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
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.render-surface {
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
  min-height: 0;
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

.image-render-surface {
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 18px;
  background-color: var(--app-panel-subtle);
  background-image:
    linear-gradient(45deg, color-mix(in srgb, var(--app-text-muted) 8%, transparent) 25%, transparent 25%),
    linear-gradient(-45deg, color-mix(in srgb, var(--app-text-muted) 8%, transparent) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--app-text-muted) 8%, transparent) 75%),
    linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--app-text-muted) 8%, transparent) 75%);
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-size: 16px 16px;
}

.image-render-surface img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
  user-select: none;
}
</style>
