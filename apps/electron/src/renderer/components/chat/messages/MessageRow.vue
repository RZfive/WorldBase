<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { buildMessageBlocks, getContentText, hasRenderableContent } from '../message-utils'
import type { ChatMessage, ChatMessageBlock, FilePreviewState } from '../types'
import ThinkingBlock from '../blocks/ThinkingBlock.vue'
import ToolRunBlock from '../blocks/ToolRunBlock.vue'
import FilePreviewBlock from '../blocks/FilePreviewBlock.vue'
import GroupCollaborationPlanBlock from '../blocks/GroupCollaborationPlanBlock.vue'
import AgentSidechatBlock from '../blocks/AgentSidechatBlock.vue'
import GroupProgressBlock from '../blocks/GroupProgressBlock.vue'
import GroupTranscriptBlock from '../blocks/GroupTranscriptBlock.vue'
import SharedBoardBlock from '../blocks/SharedBoardBlock.vue'
import GroupDirectReplyBlock from '../blocks/GroupDirectReplyBlock.vue'
import GroupUserInjectionBlock from '../blocks/GroupUserInjectionBlock.vue'
import GroupPeerMessageBlock from '../blocks/GroupPeerMessageBlock.vue'
import WebSearchBlock from '../blocks/WebSearchBlock.vue'
import WebFetchBlock from '../blocks/WebFetchBlock.vue'
import AttachmentBlock from '../blocks/AttachmentBlock.vue'
import AuthRequestBlock from '../blocks/AuthRequestBlock.vue'
import SudoPasswordBlock from '../blocks/SudoPasswordBlock.vue'
import ContentBlock from '../blocks/ContentBlock.vue'
import ErrorBlock from '../blocks/ErrorBlock.vue'
import MessageEditBox from './MessageEditBox.vue'

const props = defineProps<{
  msg: ChatMessage
  index: number
  isLoading: boolean
  latestAssistantMessageIndex: number
  filePreview: FilePreviewState
  collapsedThinking: Record<string, boolean>
  assistantIcon?: string
  assistantName?: string
  editingMessageId?: string | null
}>()

const { t } = useI18n()

const emit = defineEmits<{
  (e: 'respondAuth', requestId: string, approved: boolean): void
  (e: 'respondSudoPassword', requestId: string, password: string | null): void
  (e: 'toggleThinking', blockId: string): void
  (e: 'openLightbox', messageIndex: number, blockIndex: number, partIndex: number): void
  (e: 'openMermaidPreview', code: string): void
  (e: 'requestEditMessage', messageId: string): void
  (e: 'forkMessage', messageId: string): void
  (e: 'submitEdit', payload: { messageId: string; text: string; mode: 'fork' | 'inplace' }): void
  (e: 'cancelEdit'): void
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
  return props.msg.role === 'assistant' ? (props.msg.speakerName || props.assistantName || 'WorldBase AI') : t('chatUi.you')
}

function getAssistantIcon (): string {
  return props.assistantIcon?.trim() || '🤖'
}

function getModelLabel (): string {
  return props.msg.modelLabel || 'WorldBase AI'
}

function getMessageText (): string {
  return getContentText(props.msg.content)
}

const blocks = computed(() => getBlocks())
const isStreamingAssistantMessage = computed(() => isStreamingAssistant())
const lastContentBlockIndex = computed(() => getLastContentBlockIndex(blocks.value))
const messageText = computed(() => getMessageText())

const isUserMessage = computed(() => props.msg.role === 'user')
const isMessageEditable = computed(() => isUserMessage.value && Boolean(props.msg.id) && !props.isLoading)
const isEditing = computed(() => Boolean(props.msg.id) && props.editingMessageId === props.msg.id)
const editableText = computed(() => (typeof props.msg.content === 'string' ? props.msg.content : props.msg.content.map(part => part.type === 'text' ? (part.text || '') : '').join('\n\n')))
const hasImages = computed(() => Array.isArray(props.msg.content) && props.msg.content.some(part => part.type === 'image_url'))
</script>

<template>
  <article class="message-row" :class="props.msg.role">
    <div class="message-column" :class="props.msg.role">
      <div class="message-meta" :class="props.msg.role">
        <template v-if="props.msg.role === 'assistant'">
          <span class="message-agent-avatar" aria-hidden="true">{{ getAssistantIcon() }}</span>
          <span class="message-author">{{ getMessageAuthor() }}</span>
          <span class="message-model-chip">{{ getModelLabel() }}</span>
        </template>
        <template v-else>
          <span class="message-role-label user">{{ $t('chatUi.user') }}</span>
          <span class="message-author">{{ $t('chatUi.you') }}</span>
          <span class="message-user-avatar" aria-hidden="true">{{ $t('chatUi.you') }}</span>
        </template>
      </div>

      <template v-if="isEditing">
        <MessageEditBox
          :initial-text="editableText"
          :has-images="hasImages"
          :busy="props.isLoading"
          @submit="(text, mode) => emit('submitEdit', { messageId: props.msg.id || '', text, mode })"
          @cancel="emit('cancelEdit')"
        />
      </template>

      <template v-else>
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

          <SharedBoardBlock
            v-else-if="block.kind === 'group_board'"
            :block="block"
          />

          <GroupDirectReplyBlock
            v-else-if="block.kind === 'group_direct_reply'"
            :block="block"
          />

          <GroupUserInjectionBlock
            v-else-if="block.kind === 'group_user_injection'"
            :block="block"
          />

          <GroupPeerMessageBlock
            v-else-if="block.kind === 'group_peer_message'"
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

          <div v-if="isUserMessage && props.msg.id" class="message-user-actions">
            <button
              v-if="isMessageEditable"
              class="message-user-action-btn"
              type="button"
              :title="$t('chatUi.editMessageAction')"
              @click="emit('requestEditMessage', props.msg.id)"
            >
              {{ $t('chatUi.editMessageAction') }}
            </button>
            <button
              class="message-user-action-btn"
              type="button"
              :disabled="props.isLoading"
              :title="$t('chatUi.forkFromHereAction')"
              @click="emit('forkMessage', props.msg.id)"
            >
              {{ $t('chatUi.forkFromHereAction') }}
            </button>
          </div>
        </div>
      </template>
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
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  overflow-wrap: anywhere;
  /* Base typography for chat content blocks. Block components use em so their
     text and row heights scale with the user preference. The message meta
     (author/model label) above is intentionally stable chrome. */
  font-family: var(--chat-font-family);
  font-size: var(--chat-font-size);
}

.message-flow.user {
  align-items: flex-end;
}

.message-user-actions {
  display: flex;
  gap: 6px;
  opacity: 0;
  transition: opacity var(--duration-fast) ease;
}

.message-row:hover .message-user-actions,
.message-user-actions:focus-within {
  opacity: 1;
}

/* No hover available (touch) - keep the actions visible. */
@media (hover: none) {
  .message-user-actions {
    opacity: 0.75;
  }
}

.message-user-action-btn {
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--app-border);
  background: transparent;
  color: var(--app-text-muted);
  font-size: 0.72rem;
  cursor: pointer;
  transition: border-color var(--duration-fast) ease, color var(--duration-fast) ease;
}

.message-user-action-btn:hover:not(:disabled) {
  border-color: var(--app-accent);
  color: var(--app-text-strong);
}

.message-user-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
  min-width: 0;
  color: var(--app-accent-strong);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.message-role-label.user {
  color: var(--app-text-faint);
}

.message-author {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--app-text-strong);
}

.message-model-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  border: none;
  background: var(--app-panel-muted);
  color: var(--app-text-faint);
  font-size: 0.7rem;
}

.message-agent-avatar,
.message-user-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 10px;
  font-weight: 800;
  line-height: 1;
}

.message-agent-avatar {
  border: 1px solid color-mix(in srgb, var(--app-accent) 22%, transparent);
  background: color-mix(in srgb, var(--app-accent-soft) 72%, var(--app-panel));
  color: var(--app-text-strong);
  font-size: 0.9rem;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--app-accent) 10%, transparent);
}

.message-user-avatar {
  background: var(--chat-avatar-user-bg);
  color: var(--app-on-accent);
  font-size: 0.76rem;
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
