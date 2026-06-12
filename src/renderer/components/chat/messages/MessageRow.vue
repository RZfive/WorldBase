<script setup lang="ts">
import { computed } from 'vue'
import { buildMessageBlocks, getContentText, hasRenderableContent } from '../message-utils'
import type { ChatMessage, ChatMessageBlock, FilePreviewState } from '../types'
import ThinkingBlock from '../blocks/ThinkingBlock.vue'
import ToolRunBlock from '../blocks/ToolRunBlock.vue'
import FilePreviewBlock from '../blocks/FilePreviewBlock.vue'
import GroupCollaborationPlanBlock from '../blocks/GroupCollaborationPlanBlock.vue'
import AgentSidechatBlock from '../blocks/AgentSidechatBlock.vue'
import GroupProgressBlock from '../blocks/GroupProgressBlock.vue'
import GroupTranscriptBlock from '../blocks/GroupTranscriptBlock.vue'
import WebSearchBlock from '../blocks/WebSearchBlock.vue'
import WebFetchBlock from '../blocks/WebFetchBlock.vue'
import AttachmentBlock from '../blocks/AttachmentBlock.vue'
import AuthRequestBlock from '../blocks/AuthRequestBlock.vue'
import SudoPasswordBlock from '../blocks/SudoPasswordBlock.vue'
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
  (e: 'respondSudoPassword', requestId: string, password: string | null): void
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
  return props.msg.role === 'assistant' ? (props.msg.speakerName || 'The World AI') : '你'
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
  <article class="message-row" :class="props.msg.role">
    <div class="message-column" :class="props.msg.role">
      <div class="message-meta" :class="props.msg.role">
        <span class="message-role-label" :class="props.msg.role">{{ props.msg.role === 'assistant' ? 'Agent' : '用户' }}</span>
        <span class="message-author">{{ getMessageAuthor() }}</span>
        <span v-if="props.msg.role === 'assistant'" class="message-model-chip">{{ getModelLabel() }}</span>
        <span v-else class="message-user-avatar" aria-hidden="true">你</span>
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

          <GroupCollaborationPlanBlock
            v-else-if="block.kind === 'group_collaboration_plan'"
            :block="block"
          />

          <AgentSidechatBlock
            v-else-if="block.kind === 'agent_sidechat'"
            :block="block"
          />

          <GroupProgressBlock
            v-else-if="block.kind === 'group_progress'"
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

          <SudoPasswordBlock
            v-else-if="block.kind === 'sudo_password_request'"
            :block="block"
            @respond-sudo-password="(requestId, password) => emit('respondSudoPassword', requestId, password)"
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
  </article>
</template>

<style scoped>
.message-row {
  box-sizing: border-box;
  width: min(100%, var(--chat-message-track-max, 1180px));
  margin: 0 auto;
  padding: 0 0 24px;
}

.message-row.user {
  display: flex;
  justify-content: flex-end;
}

.message-column {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.message-column.user {
  width: min(78%, var(--chat-user-message-max, 820px));
  margin-left: auto;
}

.message-flow {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}

.message-flow.user {
  align-items: flex-end;
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  color: var(--app-text-muted);
}

.message-meta.user {
  justify-content: flex-end;
}

.message-role-label {
  display: inline-flex;
  align-items: center;
  min-width: 44px;
  color: var(--app-accent-strong);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.message-role-label.user {
  color: var(--app-text-muted);
}

.message-author {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--app-text-strong);
}

.message-model-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--app-border);
  background: transparent;
  color: var(--app-text-muted);
  font-size: 0.72rem;
}

.message-user-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 10px;
  background: color-mix(in srgb, #10b981 86%, var(--app-accent));
  color: #ffffff;
  font-size: 0.76rem;
  font-weight: 800;
  line-height: 1;
}

@media (max-width: 860px) {
  .message-row {
    width: 100%;
    padding-bottom: 22px;
  }

  .message-column.user {
    width: min(100%, var(--chat-user-message-max, 820px));
  }
}
</style>
