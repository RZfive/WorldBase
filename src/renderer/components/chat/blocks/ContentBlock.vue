<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import { renderMarkdown } from '../markdown'
import { getContentParts, hasRenderableContent, collapseWhitespace } from '../message-utils'
import { splitMarkdownWithMermaid, type MarkdownSegment } from '../mermaid'
import {
  buildAssistantExportBaseName,
  copyTextToClipboard,
  downloadDataUrlFile,
  downloadMarkdownFile,
  messageContentToMarkdown,
  renderElementToPngDataUrl
} from '../export-utils'
import type { ChatMessageBlock } from '../types'
import MermaidDiagram from '../media/MermaidDiagram.vue'

type ExportKind = 'md' | 'image' | 'copy'
type ExportState = 'idle' | 'pending' | 'done' | 'error'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'content' }>
  role: string
  messageIndex: number
  blockIndex: number
  isStreamingBlock: boolean
  messageText: string
}>()

const emit = defineEmits<{
  (e: 'openLightbox', messageIndex: number, blockIndex: number, partIndex: number): void
  (e: 'openMermaidPreview', code: string): void
}>()

const exportCaptureRef = ref<HTMLElement | null>(null)
const markdownExportState = ref<ExportState>('idle')
const imageExportState = ref<ExportState>('idle')
const copyExportState = ref<ExportState>('idle')

const exportStateRefs: Record<ExportKind, Ref<ExportState>> = {
  md: markdownExportState,
  image: imageExportState,
  copy: copyExportState
}

const exportResetTimers: Record<ExportKind, number | null> = {
  md: null,
  image: null,
  copy: null
}

const exportStateLabels: Record<ExportKind, Record<ExportState, string>> = {
  md: {
    idle: '导出 MD',
    pending: '导出中…',
    done: '已保存',
    error: '失败'
  },
  image: {
    idle: '导出长图',
    pending: '生成中…',
    done: '已保存',
    error: '失败'
  },
  copy: {
    idle: '复制',
    pending: '复制中…',
    done: '已复制',
    error: '失败'
  }
}

const canExport = computed(() => {
  return props.role === 'assistant' && !props.isStreamingBlock && hasRenderableContent(props.block.content)
})

function getTextSegments (text?: string) {
  return splitMarkdownWithMermaid(text || '')
}

function getStreamingPreviewText (segment: MarkdownSegment): string {
  return `\`\`\`mermaid\n${segment.text}\n\`\`\``
}

function getExportState (kind: ExportKind): ExportState {
  return exportStateRefs[kind].value
}

function clearResetTimer (kind: ExportKind) {
  const timer = exportResetTimers[kind]
  if (timer != null) {
    window.clearTimeout(timer)
  }
  exportResetTimers[kind] = null
}

function setExportState (kind: ExportKind, state: ExportState) {
  clearResetTimer(kind)
  exportStateRefs[kind].value = state

  if (state === 'done' || state === 'error') {
    const timeoutId = window.setTimeout(() => {
      exportStateRefs[kind].value = 'idle'
      exportResetTimers[kind] = null
    }, 2200)
    exportResetTimers[kind] = timeoutId
  }
}

function getExportLabel (kind: ExportKind): string {
  return exportStateLabels[kind][getExportState(kind)]
}

async function exportMarkdown (): Promise<void> {
  if (!canExport.value || markdownExportState.value === 'pending') return

  setExportState('md', 'pending')
  try {
    const markdown = messageContentToMarkdown(props.block.content)
    const fileName = `${buildAssistantExportBaseName()}.md`

    if (window.electronAPI?.saveMarkdownToFile) {
      const result = await window.electronAPI.saveMarkdownToFile(markdown, fileName)
      if (result?.canceled) {
        setExportState('md', 'idle')
        return
      }
    } else {
      downloadMarkdownFile(markdown, fileName)
    }

    setExportState('md', 'done')
  } catch (error) {
    console.error('Failed to export markdown:', error)
    setExportState('md', 'error')
  }
}

async function exportLongImage (): Promise<void> {
  if (!canExport.value || imageExportState.value === 'pending' || !exportCaptureRef.value) return

  setExportState('image', 'pending')
  try {
    const dataUrl = await renderElementToPngDataUrl(exportCaptureRef.value)
    const fileName = `${buildAssistantExportBaseName()}.png`

    if (window.electronAPI?.saveImageToFile) {
      const result = await window.electronAPI.saveImageToFile(dataUrl, fileName)
      if (result?.canceled) {
        setExportState('image', 'idle')
        return
      }
    } else {
      downloadDataUrlFile(dataUrl, fileName)
    }

    setExportState('image', 'done')
  } catch (error) {
    console.error('Failed to export long image:', error)
    setExportState('image', 'error')
  }
}

async function copyMessageContent (): Promise<void> {
  if (!canExport.value || copyExportState.value === 'pending') return

  setExportState('copy', 'pending')
  try {
    await copyTextToClipboard(messageContentToMarkdown(props.block.content))
    setExportState('copy', 'done')
  } catch (error) {
    console.error('Failed to copy message content:', error)
    setExportState('copy', 'error')
  }
}

onBeforeUnmount(() => {
  clearResetTimer('md')
  clearResetTimer('image')
  clearResetTimer('copy')
})
</script>

<template>
  <div
    ref="exportCaptureRef"
    class="message-bubble"
    :class="[props.role, { streaming: props.isStreamingBlock }]"
  >
    <template v-if="hasRenderableContent(props.block.content)">
      <div class="message-content-body">
        <template
          v-for="(part, partIndex) in getContentParts(props.block.content)"
          :key="`${props.block.id}-${partIndex}`"
        >
          <div
            v-if="part.type === 'text' && part.text"
            class="message-text-group"
          >
            <template
              v-for="(segment, segmentIndex) in getTextSegments(part.text)"
              :key="`${props.block.id}-${partIndex}-${segmentIndex}`"
            >
              <div
                v-if="segment.type === 'markdown'"
                class="message-text markdown-body"
                v-html="renderMarkdown(segment.text)"
              ></div>

              <MermaidDiagram
                v-else-if="!props.isStreamingBlock"
                class="message-mermaid-card"
                :code="segment.text"
                previewable
                @open-preview="emit('openMermaidPreview', segment.text)"
              />

              <pre
                v-else
                class="message-stream-preview"
              >{{ getStreamingPreviewText(segment) }}</pre>
            </template>
          </div>

          <button
            v-else-if="part.type === 'image_url' && part.image_url?.url"
            class="message-image-card"
            type="button"
            @click="emit('openLightbox', props.messageIndex, props.blockIndex, partIndex)"
          >
            <img :src="part.image_url.url" class="message-image" />
            <span class="message-image-action">点击查看大图</span>
          </button>
        </template>
      </div>

      <div v-if="canExport" class="message-export-bar" data-export-ignore="true">
        <button
          class="message-export-action"
          type="button"
          :disabled="copyExportState === 'pending'"
          @click="copyMessageContent"
        >
          {{ getExportLabel('copy') }}
        </button>
        <button
          class="message-export-action"
          type="button"
          :disabled="markdownExportState === 'pending'"
          @click="exportMarkdown"
        >
          {{ getExportLabel('md') }}
        </button>
        <button
          class="message-export-action"
          type="button"
          :disabled="imageExportState === 'pending'"
          @click="exportLongImage"
        >
          {{ getExportLabel('image') }}
        </button>
      </div>
    </template>
    <div v-else class="message-placeholder">
      {{ props.role === 'assistant' ? '正在流式输出…' : collapseWhitespace(props.messageText) }}
    </div>
  </div>
</template>

<style scoped>
.message-bubble {
  width: min(100%, var(--chat-bubble-max, 1120px));
  max-width: 100%;
  padding: 16px 18px;
  border-radius: 22px;
  border: 1px solid var(--app-border-strong);
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.08);
}

.message-bubble.assistant {
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  color: var(--app-text);
  border-top-left-radius: 10px;
}

.message-bubble.user {
  background: linear-gradient(180deg, var(--app-accent-soft), rgba(91, 140, 255, 0.12));
  color: var(--app-text-strong);
  border-color: var(--app-accent-glow);
  border-top-right-radius: 10px;
}

.message-bubble.streaming {
  border-color: var(--app-accent-glow);
  box-shadow: 0 18px 40px rgba(91, 140, 255, 0.12);
}

.message-placeholder {
  color: var(--app-text-muted);
  min-width: 160px;
}

.message-content-body {
  width: 100%;
}

.message-content-body > * + * {
  margin-top: 12px;
}

.message-text + .message-text {
  margin-top: 10px;
}

.message-text-group {
  width: 100%;
}

.message-text-group > * + * {
  margin-top: 12px;
}

.message-text-group + .message-image-card,
.message-image-card + .message-text,
.message-image-card + .message-image-card,
.message-image-card + .message-text-group,
.message-text-group + .message-text-group {
  margin-top: 12px;
}

.message-stream-preview {
  margin: 0;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid var(--app-border-strong);
  background: color-mix(in srgb, var(--app-panel-muted) 78%, transparent);
  color: var(--app-text);
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  font-size: 0.84rem;
  line-height: 1.58;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.message-mermaid-card {
  width: min(100%, calc(var(--chat-bubble-max, 1120px) - 24px));
}

.message-image-card {
  display: inline-flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  max-width: min(420px, 100%);
  padding: 8px;
  background: var(--app-panel);
  border: 1px solid var(--app-border-strong);
  border-radius: 16px;
  cursor: zoom-in;
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
}

.message-image-card:hover {
  transform: translateY(-1px);
  border-color: var(--app-accent-glow);
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.12);
}

.message-image {
  display: block;
  width: 100%;
  max-width: 404px;
  max-height: 404px;
  object-fit: cover;
  border-radius: 12px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
}

.message-image-action {
  font-size: 0.78rem;
  color: var(--app-text-muted);
}

.message-export-bar {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 12px;
  opacity: 0.62;
  transition: opacity 0.18s ease;
}

.message-bubble:hover .message-export-bar,
.message-export-bar:focus-within {
  opacity: 0.92;
}

.message-export-action {
  appearance: none;
  border: 1px solid color-mix(in srgb, var(--app-border-strong) 80%, transparent);
  background: color-mix(in srgb, var(--app-panel-subtle) 72%, transparent);
  color: var(--app-text-muted);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 0.72rem;
  line-height: 1.2;
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: color 0.18s ease, border-color 0.18s ease, background 0.18s ease;
}

.message-export-action:hover:not(:disabled),
.message-export-action:focus-visible {
  color: var(--app-text);
  border-color: var(--app-border-strong);
  background: color-mix(in srgb, var(--app-panel) 84%, transparent);
  outline: none;
}

.message-export-action:disabled {
  cursor: wait;
  opacity: 0.82;
}

/* Markdown deep styles */
.message-bubble :deep(p) { margin: 0.45em 0; }
.message-bubble :deep(p:first-child) { margin-top: 0; }
.message-bubble :deep(p:last-child) { margin-bottom: 0; }

.message-bubble :deep(pre) {
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border-strong);
  border-radius: 12px;
  padding: 12px 14px;
  overflow-x: auto;
  font-size: 0.85em;
  line-height: 1.55;
  margin: 10px 0;
}

.message-bubble :deep(code) {
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  font-size: 0.9em;
}

.message-bubble :deep(:not(pre) > code) {
  background: var(--app-panel-muted);
  padding: 2px 6px;
  border-radius: 6px;
  color: var(--app-accent-strong);
}

.message-bubble :deep(ul),
.message-bubble :deep(ol) {
  padding-left: 1.45em;
  margin: 0.45em 0;
}

.message-bubble :deep(li) { margin: 0.24em 0; }

.message-bubble :deep(h1),
.message-bubble :deep(h2),
.message-bubble :deep(h3),
.message-bubble :deep(h4) {
  margin: 0.65em 0 0.32em;
  line-height: 1.35;
}

.message-bubble :deep(h1) { font-size: 1.22em; }
.message-bubble :deep(h2) { font-size: 1.12em; }
.message-bubble :deep(h3) { font-size: 1.02em; }

.message-bubble :deep(blockquote) {
  border-left: 3px solid var(--app-accent);
  padding-left: 12px;
  color: var(--app-text-muted);
  margin: 0.55em 0;
}

.message-bubble :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.55em 0;
  font-size: 0.9em;
}

.message-bubble :deep(th),
.message-bubble :deep(td) {
  border: 1px solid var(--app-border-strong);
  padding: 6px 10px;
  text-align: left;
}

.message-bubble :deep(th) {
  background: var(--app-panel-muted);
  font-weight: 600;
}

.message-bubble :deep(a) {
  color: var(--app-accent-strong);
  text-decoration: none;
}

.message-bubble :deep(a:hover) {
  text-decoration: underline;
}

.message-bubble :deep(hr) {
  border: none;
  border-top: 1px solid var(--app-border-strong);
  margin: 0.9em 0;
}

@media (max-width: 860px) {
  .message-bubble {
    width: 100%;
  }

  .message-mermaid-card {
    width: 100%;
  }
}
</style>
