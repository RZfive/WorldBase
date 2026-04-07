<script setup lang="ts">
import { renderMarkdown } from './markdown'
import { getContentParts, hasRenderableContent, collapseWhitespace } from './message-utils'
import type { ChatMessageBlock } from './types'

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
}>()
</script>

<template>
  <div
    class="message-bubble"
    :class="[props.role, { streaming: props.isStreamingBlock }]"
  >
    <template v-if="hasRenderableContent(props.block.content)">
      <template
        v-for="(part, partIndex) in getContentParts(props.block.content)"
        :key="`${props.block.id}-${partIndex}`"
      >
        <div
          v-if="part.type === 'text' && part.text"
          class="message-text markdown-body"
          v-html="renderMarkdown(part.text)"
        ></div>

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
    </template>
    <div v-else class="message-placeholder">
      {{ props.role === 'assistant' ? '正在流式输出…' : collapseWhitespace(props.messageText) }}
    </div>
  </div>
</template>

<style scoped>
.message-bubble {
  width: fit-content;
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

.message-text + .message-text {
  margin-top: 10px;
}

.message-text + .message-image-card,
.message-image-card + .message-text,
.message-image-card + .message-image-card {
  margin-top: 12px;
}

.message-image-card {
  display: inline-flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  max-width: min(340px, 100%);
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
  max-width: 324px;
  max-height: 324px;
  object-fit: cover;
  border-radius: 12px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
}

.message-image-action {
  font-size: 0.78rem;
  color: var(--app-text-muted);
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
}
</style>
