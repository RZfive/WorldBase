<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
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
import { vStableImages, vStableImage } from '../media/image-stability'

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

const { t } = useI18n()
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

const exportStateLabelKeys: Record<ExportKind, Record<ExportState, string>> = {
  md: {
    idle: 'chatUi.exportMarkdown',
    pending: 'chatUi.exporting',
    done: 'chatUi.exportSaved',
    error: 'chatUi.exportFailed'
  },
  image: {
    idle: 'chatUi.exportLongImage',
    pending: 'chatUi.generatingEllipsis',
    done: 'chatUi.exportSaved',
    error: 'chatUi.exportFailed'
  },
  copy: {
    idle: 'chatUi.copy',
    pending: 'chatUi.copying',
    done: 'chatUi.copied',
    error: 'chatUi.exportFailed'
  }
}

const canExport = computed(() => {
  return props.role === 'assistant' && !props.isStreamingBlock && hasRenderableContent(props.block.content)
})

function getTextSegments (text?: string) {
  return splitMarkdownWithMermaid(text || '')
}

// design v1.7 motion: the streaming caret lives at the TEXT tail — a 2.5px
// signature-gradient lightbar with soft glow, injected inline into the last
// rendered block so it hugs the newest character.
const STREAM_CARET_HTML = '<span class="stream-caret" aria-hidden="true"></span>'

function withStreamCaret (html: string): string {
  const trimmed = html.trimEnd()
  if (!trimmed) return STREAM_CARET_HTML
  // Raw code/preview surfaces would read the caret as markup — skip them.
  if (/<\/(pre|code|table)>$/i.test(trimmed)) return trimmed
  const injected = trimmed.replace(/(<\/(p|li|h[1-6]|blockquote)>\s*)$/, `${STREAM_CARET_HTML}$1`)
  return injected === trimmed ? `${trimmed}${STREAM_CARET_HTML}` : injected
}

function renderSegmentHtml (text: string): string {
  const html = renderMarkdown(text)
  return props.isStreamingBlock ? withStreamCaret(html) : html
}

function getMermaidPreviewText (code: string): string {
  return `\`\`\`mermaid\n${code}\n\`\`\``
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
  return t(exportStateLabelKeys[kind][getExportState(kind)])
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
    class="message-output"
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
                v-html="renderSegmentHtml(segment.text)"
                v-stable-images
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
              >{{ getMermaidPreviewText(segment.text) }}</pre>
            </template>
          </div>

          <button
            v-else-if="part.type === 'image_url' && part.image_url?.url"
            class="message-image-card"
            type="button"
            @click="emit('openLightbox', props.messageIndex, props.blockIndex, partIndex)"
          >
            <img :src="part.image_url.url" class="message-image" v-stable-image />
            <span class="message-image-action">{{ $t('chatUi.viewLargeImage') }}</span>
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
      {{ props.role === 'assistant' ? $t('chatUi.streamingOutput') : collapseWhitespace(props.messageText) }}
    </div>
  </div>
</template>

<style scoped>
.message-output {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  padding: 0;
  color: var(--app-text-soft);
  font-size: 1em;
  line-height: 1.68;
  overflow-wrap: anywhere;
}

.message-output.user {
  width: fit-content;
  max-width: min(100%, var(--chat-user-bubble-max, 640px));
  margin-left: auto;
  padding: 7px 11px;
  border: 1px solid var(--chat-bubble-user-border);
  border-radius: 13px 13px 4px 13px;
  background: var(--chat-bubble-user-bg);
  color: var(--app-text-strong);
  box-shadow: none;
}

.message-output.streaming {
  position: relative;
}

.message-placeholder {
  color: var(--app-text-muted);
  min-width: 160px;
}

.message-content-body {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

.message-content-body > * + * {
  margin-top: 12px;
}

.message-text + .message-text {
  margin-top: 10px;
}

/* design v1.7 motion: streaming caret — a 2.5px signature-gradient lightbar
   at the text tail with a soft glow, so words feel "written" out. */
.message-text :deep(.stream-caret) {
  position: relative;
  display: inline-block;
  width: 2.5px;
  height: 1em;
  margin-left: 3px;
  vertical-align: -0.15em;
  border-radius: 2px;
  background: var(--app-sig);
  box-shadow: 0 0 10px var(--app-accent-glow), 0 0 4px var(--app-accent-glow);
  animation: stream-caret-breathe 1.1s ease-in-out infinite;
}

/* Tiny rising sparks — the "particles composing the text" shimmer. */
.message-text :deep(.stream-caret)::before,
.message-text :deep(.stream-caret)::after {
  content: '';
  position: absolute;
  top: -2px;
  left: 50%;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--app-accent);
  /* No `filter: blur()` here: a filter on a transform-animated element adds a
     GPU filter pass per frame for a 3px dot nobody can see sharpened. */
  pointer-events: none;
}

.message-text :deep(.stream-caret)::before {
  animation: stream-spark-a 1.1s ease-out infinite;
}

.message-text :deep(.stream-caret)::after {
  width: 2px;
  height: 2px;
  background: var(--app-accent-strong);
  animation: stream-spark-b 1.4s ease-out infinite;
  animation-delay: 0.3s;
}

@keyframes stream-caret-breathe {
  0%, 100% { opacity: 0.6; transform: scaleY(0.72); }
  50% { opacity: 1; transform: scaleY(1); }
}

@keyframes stream-spark-a {
  0% { opacity: 0.9; transform: translate(-50%, 0) scale(1); }
  100% { opacity: 0; transform: translate(-30%, -9px) scale(0.4); }
}

@keyframes stream-spark-b {
  0% { opacity: 0.7; transform: translate(-70%, 0) scale(1); }
  100% { opacity: 0; transform: translate(-20%, -12px) scale(0.3); }
}

@media (prefers-reduced-motion: reduce) {
  .message-text :deep(.stream-caret),
  .message-text :deep(.stream-caret)::before,
  .message-text :deep(.stream-caret)::after {
    animation: none;
  }
}

.message-text-group {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

.message-text {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
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
  font-family: inherit;
  font-size: 0.84em;
  line-height: 1.58;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.message-mermaid-card {
  width: 100%;
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
  font-size: 0.78em;
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

.message-output:hover .message-export-bar,
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
  font-size: 0.72em;
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
.message-output :deep(p) { margin: 0.45em 0; }
.message-output :deep(p:first-child) { margin-top: 0; }
.message-output :deep(p:last-child) { margin-bottom: 0; }

.message-output :deep(pre) {
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border-strong);
  border-radius: 9px;
  padding: 9px 10px;
  overflow-x: auto;
  font-size: 0.85em;
  line-height: 1.55;
  margin: 8px 0;
}

.message-output :deep(code) {
  font-family: inherit;
  font-size: 0.9em;
}

.message-output :deep(:not(pre) > code) {
  background: var(--app-panel-muted);
  padding: 2px 6px;
  border-radius: 6px;
  color: var(--app-accent-strong);
}

.message-output :deep(ul),
.message-output :deep(ol) {
  padding-left: 1.45em;
  margin: 0.45em 0;
}

.message-output :deep(li) { margin: 0.24em 0; }

.message-output :deep(h1),
.message-output :deep(h2),
.message-output :deep(h3),
.message-output :deep(h4) {
  margin: 0.65em 0 0.32em;
  line-height: 1.35;
}

.message-output :deep(h1) { font-size: 1.34em; }
.message-output :deep(h2) { font-size: 1.18em; }
.message-output :deep(h3) { font-size: 1em; }

.message-output :deep(blockquote) {
  border-left: 2px solid var(--app-accent);
  padding-left: 11px;
  color: var(--app-text-muted);
  font-family: inherit;
  margin: 0.55em 0;
}

.message-output :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.55em 0;
  font-size: 0.9em;
}

.message-output :deep(th),
.message-output :deep(td) {
  border: 1px solid var(--app-border-strong);
  padding: 6px 10px;
  text-align: left;
}

.message-output :deep(th) {
  background: var(--app-panel-muted);
  font-weight: 600;
}

.message-output :deep(a) {
  color: var(--app-accent-strong);
  text-decoration: none;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.message-output :deep(a:hover) {
  text-decoration: underline;
}

.message-output :deep(hr) {
  border: none;
  border-top: 1px solid var(--app-border-strong);
  margin: 0.9em 0;
}

.message-output :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 12px;
}

@media (max-width: 860px) {
  .message-mermaid-card {
    width: 100%;
  }
}
</style>
