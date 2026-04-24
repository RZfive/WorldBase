<script setup lang="ts">
import { computed } from 'vue'
import { buildMessageBlocks, getContentText, hasRenderableContent } from '../message-utils'
import type { ChatMessage, ChatMessageBlock, FilePreviewState } from '../types'
import ThinkingBlock from '../blocks/ThinkingBlock.vue'
import ToolRunBlock from '../blocks/ToolRunBlock.vue'
import FilePreviewBlock from '../blocks/FilePreviewBlock.vue'
import GroupTranscriptBlock from '../blocks/GroupTranscriptBlock.vue'
import WebSearchBlock from '../blocks/WebSearchBlock.vue'
import WebFetchBlock from '../blocks/WebFetchBlock.vue'
import AttachmentBlock from '../blocks/AttachmentBlock.vue'
import AuthRequestBlock from '../blocks/AuthRequestBlock.vue'
import ContentBlock from '../blocks/ContentBlock.vue'
import ErrorBlock from '../blocks/ErrorBlock.vue'

const props = defineProps<{
  msg: ChatMessage
  index: number
  isLoading: boolean
  latestAssistantMessageIndex: number
  filePreview: FilePreviewState
  collapsedThinking: Record<string, boolean>
}>()

const emit = defineEmits<{
  (e: 'respondAuth', requestId: string, approved: boolean): void
  (e: 'toggleThinking', blockId: string): void
  (e: 'openLightbox', messageIndex: number, blockIndex: number, partIndex: number): void
  (e: 'openMermaidPreview', code: string): void
}>()

function getBlocks (): ChatMessageBlock[] {
  return buildMessageBlocks(props.msg, props.index, props.filePreview, props.latestAssistantMessageIndex, props.isLoading)
}

function isStreamingAssistant (): boolean {
  return props.isLoading && props.msg.role === 'assistant' && props.index === props.latestAssistantMessageIndex
}

function getLastContentBlockIndex (blocks: ChatMessageBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === 'content') return i
  }
  return -1
}

function isStreamingContentBlock (blockIndex: number, blocks: ChatMessageBlock[]): boolean {
  return isStreamingAssistant() && blockIndex === getLastContentBlockIndex(blocks)
}

function hasRenderableBlock (block: ChatMessageBlock): boolean {
  if (block.kind === 'content') return hasRenderableContent(block.content)
  if (block.kind === 'thinking') return block.text.trim().length > 0
  return true
}

function getMessageAuthor (): string {
  return props.msg.role === 'assistant' ? 'The World AI' : '你'
}

function getAvatarLabel (): string {
  return props.msg.role === 'assistant' ? 'AI' : '你'
}

function getModelLabel (): string {
  return props.msg.modelLabel || 'The World AI'
}

function getMessageText (): string {
  return getContentText(props.msg.content)
}

const blocks = computed(() => getBlocks())
const isStreamingAssistantMessage = computed(() => isStreamingAssistant())
const lastContentBlockIndex = computed(() => getLastContentBlockIndex(blocks.value))
const messageText = computed(() => getMessageText())
</script>

<template>
  <div class="message-row" :class="props.msg.role">
    <div v-if="props.msg.role === 'assistant'" class="message-avatar assistant-avatar">{{ getAvatarLabel() }}</div>

    <div class="message-column" :class="props.msg.role">
      <div class="message-meta" :class="props.msg.role">
        <span class="message-author">{{ getMessageAuthor() }}</span>
        <span v-if="props.msg.role === 'assistant'" class="message-model-chip">{{ getModelLabel() }}</span>
      </div>

      <div class="message-flow" :class="props.msg.role">
        <template v-for="(block, blockIndex) in blocks" :key="block.id">
            <ThinkingBlock
              v-if="block.kind === 'thinking' && hasRenderableBlock(block)"
              :block="block"
              :is-streaming="isStreamingAssistantMessage"
              :is-collapsed="props.collapsedThinking[block.id] !== false"
              @toggle="emit('toggleThinking', block.id)"
            />

          <ToolRunBlock
            v-else-if="block.kind === 'tool'"
            :block="block"
          />

          <FilePreviewBlock
            v-else-if="block.kind === 'file_preview'"
            :block="block"
          />

          <GroupTranscriptBlock
            v-else-if="block.kind === 'group_transcript'"
            :block="block"
          />

          <WebSearchBlock
            v-else-if="block.kind === 'web_search'"
            :block="block"
          />

          <WebFetchBlock
            v-else-if="block.kind === 'web_fetch'"
            :block="block"
          />

          <AttachmentBlock
            v-else-if="block.kind === 'attachment'"
            :block="block"
          />

          <AuthRequestBlock
            v-else-if="block.kind === 'auth_request'"
            :block="block"
            @respond-auth="(requestId, approved) => emit('respondAuth', requestId, approved)"
          />

          <ErrorBlock
            v-else-if="block.kind === 'error'"
            :block="block"
          />

          <ContentBlock
            v-else-if="block.kind === 'content' && (hasRenderableBlock(block) || (isStreamingAssistantMessage && blockIndex === lastContentBlockIndex))"
            :block="block"
            :role="props.msg.role"
            :message-index="props.index"
            :block-index="blockIndex"
            :is-streaming-block="isStreamingAssistantMessage && blockIndex === lastContentBlockIndex"
            :message-text="messageText"
            @open-lightbox="(mi, bi, pi) => emit('openLightbox', mi, bi, pi)"
            @open-mermaid-preview="(code) => emit('openMermaidPreview', code)"
          />
        </template>
      </div>
    </div>

    <div v-if="props.msg.role === 'user'" class="message-avatar user-avatar">{{ getAvatarLabel() }}</div>
  </div>
</template>

<style scoped>
.message-row {
  display: flex;
  align-items: flex-end;
  gap: var(--chat-avatar-gap, 14px);
  width: min(100%, var(--chat-message-track-max, 1480px));
  margin: 0 auto;
}

.message-row.user {
  justify-content: flex-end;
}

.message-row.assistant {
  justify-content: flex-start;
}

.message-avatar {
  width: var(--chat-avatar-size, 40px);
  height: var(--chat-avatar-size, 40px);
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.12);
}

.assistant-avatar {
  background: linear-gradient(135deg, var(--app-accent), #7aa7ff);
  color: #ffffff;
}

.user-avatar {
  background: linear-gradient(135deg, #22c55e, #16a34a);
  color: #ffffff;
}

.message-column {
  width: min(var(--chat-message-column-max, 1120px), calc(100% - var(--chat-dual-avatar-footprint, 108px)));
  max-width: calc(100% - var(--chat-dual-avatar-footprint, 108px));
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.message-column.user {
  align-items: flex-end;
}

.message-column.assistant {
  align-items: flex-start;
}

.message-flow {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.message-flow.user {
  align-items: flex-end;
}

.message-flow.assistant {
  align-items: flex-start;
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
}

.message-meta.user {
  justify-content: flex-end;
}

.message-author {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--app-text-strong);
}

.message-model-chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  font-size: 0.76rem;
}

@media (max-width: 860px) {
  .message-row {
    width: 100%;
    gap: 10px;
  }

  .message-avatar {
    width: 36px;
    height: 36px;
  }

  .message-column {
    width: min(100%, calc(100% - 46px));
    max-width: calc(100% - 46px);
  }
}
</style>
