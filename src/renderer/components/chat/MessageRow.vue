<script setup lang="ts">
import { buildMessageBlocks, getContentText, hasRenderableContent } from './message-utils'
import type { ChatMessage, ChatMessageBlock, FilePreviewState } from './types'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolRunBlock from './ToolRunBlock.vue'
import FilePreviewBlock from './FilePreviewBlock.vue'
import AttachmentBlock from './AttachmentBlock.vue'
import AuthRequestBlock from './AuthRequestBlock.vue'
import ContentBlock from './ContentBlock.vue'

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
        <template v-for="(block, blockIndex) in getBlocks()" :key="block.id">
          <ThinkingBlock
            v-if="block.kind === 'thinking' && hasRenderableBlock(block)"
            :block="block"
            :is-streaming="isStreamingAssistant()"
            :is-collapsed="!!props.collapsedThinking[block.id]"
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

          <AttachmentBlock
            v-else-if="block.kind === 'attachment'"
            :block="block"
          />

          <AuthRequestBlock
            v-else-if="block.kind === 'auth_request'"
            :block="block"
            @respond-auth="(requestId, approved) => emit('respondAuth', requestId, approved)"
          />

          <ContentBlock
            v-else-if="block.kind === 'content' && (hasRenderableBlock(block) || isStreamingContentBlock(blockIndex, getBlocks()))"
            :block="block"
            :role="props.msg.role"
            :message-index="props.index"
            :block-index="blockIndex"
            :is-streaming-block="isStreamingContentBlock(blockIndex, getBlocks())"
            :message-text="getMessageText()"
            @open-lightbox="(mi, bi, pi) => emit('openLightbox', mi, bi, pi)"
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
  gap: 14px;
}

.message-row.user {
  justify-content: flex-end;
}

.message-row.assistant {
  justify-content: flex-start;
}

.message-avatar {
  width: 40px;
  height: 40px;
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
  width: min(820px, calc(100% - 54px));
  max-width: calc(100% - 54px);
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
  .message-column {
    width: min(100%, calc(100% - 50px));
    max-width: calc(100% - 50px);
  }
}
</style>
