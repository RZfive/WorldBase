<script setup lang="ts">
import { computed } from 'vue'
import SidebarIcon from '../layout/SidebarIcon.vue'
import { useI18n } from 'vue-i18n'
import { buildMessageBlocks, getContentText, hasRenderableContent } from '../message-utils'
import type { ChatMessage, ChatMessageBlock, FilePreviewState } from '../types'
import ThinkingBlock from '../blocks/ThinkingBlock.vue'
import ToolRunBlock from '../blocks/ToolRunBlock.vue'
import ToolGroupBlock from '../blocks/ToolGroupBlock.vue'
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

// Chrome avatars are SVG (design v1.7); a customized assistant emoji keeps its identity.
const customAssistantEmoji = computed(() => {
  const raw = props.assistantIcon?.trim() || ''
  return raw && raw !== '🤖' ? raw : ''
})

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

/**
 * Codex-style work summary: consecutive thinking + tool + web result + file
 * write runs collapse into ONE row (live seconds while working, frozen total
 * once settled), expanding to the full trace — thinking pills, per-tool rows,
 * web result cards and file-write rows. Any run holding at least one
 * non-thinking item collapses into a summary row — including a lone tool
 * call — so every tool execution stays inside the expandable summary; lone
 * thinking stays a standalone pill. Purely a render-level transform, so
 * stored/legacy conversations group the same way as live ones.
 */
type WorkBurstBlock = Extract<ChatMessageBlock, { kind: 'thinking' | 'tool' | 'web_search' | 'web_fetch' | 'file_preview' }>

const GROUPABLE_KINDS = new Set<ChatMessageBlock['kind']>(['thinking', 'tool', 'web_search', 'web_fetch', 'file_preview'])

interface MessageRenderSegment {
  type: 'single' | 'group'
  key: string
  block: ChatMessageBlock
  blockIndex: number
  groupBlocks: WorkBurstBlock[]
}

const renderSegments = computed<MessageRenderSegment[]>(() => {
  const all = blocks.value
  const segments: MessageRenderSegment[] = []
  let run: Array<{ block: ChatMessageBlock; blockIndex: number }> = []

  const flushRun = () => {
    if (run.length === 0) return
    const renderable = run.filter(entry => entry.block.kind !== 'thinking' || hasRenderableBlock(entry.block))
    const hasWork = renderable.some(entry => entry.block.kind !== 'thinking')
    if (hasWork) {
      segments.push({
        type: 'group',
        key: `group-${renderable[0].block.id}`,
        block: renderable[0].block,
        blockIndex: renderable[0].blockIndex,
        groupBlocks: renderable.map(entry => entry.block) as WorkBurstBlock[]
      })
    } else {
      for (const entry of renderable) {
        segments.push({ type: 'single', key: entry.block.id, block: entry.block, blockIndex: entry.blockIndex, groupBlocks: [] })
      }
    }
    run = []
  }

  all.forEach((block, blockIndex) => {
    if (GROUPABLE_KINDS.has(block.kind)) {
      run.push({ block, blockIndex })
      return
    }
    flushRun()
    segments.push({ type: 'single', key: block.id, block, blockIndex, groupBlocks: [] })
  })
  flushRun()
  return segments
})

// A thinking block is only "live" while it is the newest block and still open —
// message-level streaming alone made every historical thinking block tick.
function isStreamingThinkingBlock (block: ChatMessageBlock, blockIndex: number): boolean {
  return isStreamingAssistant() &&
    block.kind === 'thinking' &&
    block.endedAt == null &&
    blockIndex === blocks.value.length - 1
}

const isUserMessage = computed(() => props.msg.role === 'user')
const isMessageEditable = computed(() => isUserMessage.value && Boolean(props.msg.id) && !props.isLoading)
const isEditing = computed(() => Boolean(props.msg.id) && props.editingMessageId === props.msg.id)
const editableText = computed(() => (typeof props.msg.content === 'string' ? props.msg.content : props.msg.content.map(part => part.type === 'text' ? (part.text || '') : '').join('\n\n')))
const hasImages = computed(() => Array.isArray(props.msg.content) && props.msg.content.some(part => part.type === 'image_url'))
</script>

<template>
  <article class="message-row" :class="props.msg.role">
    <div class="message-column" :class="props.msg.role">
      <div v-if="props.msg.role === 'assistant'" class="message-meta">
        <span class="message-agent-avatar" aria-hidden="true">
          <span v-if="customAssistantEmoji" class="message-agent-emoji">{{ customAssistantEmoji }}</span>
          <SidebarIcon v-else name="robot" :size="13" />
        </span>
        <span class="message-author">{{ getMessageAuthor() }}</span>
        <span class="message-model-chip">{{ getModelLabel() }}</span>
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
          <template v-for="segment in renderSegments" :key="segment.key">
            <!-- design v1.7: consecutive thinking + tool runs as one work summary row -->
            <ToolGroupBlock
              v-if="segment.type === 'group'"
              :blocks="segment.groupBlocks"
              :message-streaming="isStreamingAssistantMessage"
            />
            <template v-else>
              <ThinkingBlock
                v-if="segment.block.kind === 'thinking' && hasRenderableBlock(segment.block)"
                :block="segment.block"
                :is-streaming="isStreamingThinkingBlock(segment.block, segment.blockIndex)"
                :is-collapsed="props.collapsedThinking[segment.block.id] !== false"
                @toggle="emit('toggleThinking', segment.block.id)"
              />

              <ToolRunBlock
                v-else-if="segment.block.kind === 'tool'"
                :block="segment.block"
              />
            </template>

            <FilePreviewBlock
              v-if="segment.block.kind === 'file_preview'"
              :block="segment.block"
            />

            <GroupCollaborationPlanBlock
              v-else-if="segment.block.kind === 'group_collaboration_plan'"
              :block="segment.block"
            />

            <AgentSidechatBlock
              v-else-if="segment.block.kind === 'agent_sidechat'"
              :block="segment.block"
            />

            <GroupProgressBlock
              v-else-if="segment.block.kind === 'group_progress'"
              :block="segment.block"
            />

            <GroupTranscriptBlock
              v-else-if="segment.block.kind === 'group_transcript'"
              :block="segment.block"
            />

            <SharedBoardBlock
              v-else-if="segment.block.kind === 'group_board'"
              :block="segment.block"
            />

            <GroupDirectReplyBlock
              v-else-if="segment.block.kind === 'group_direct_reply'"
              :block="segment.block"
            />

            <GroupUserInjectionBlock
              v-else-if="segment.block.kind === 'group_user_injection'"
              :block="segment.block"
            />

            <GroupPeerMessageBlock
              v-else-if="segment.block.kind === 'group_peer_message'"
              :block="segment.block"
            />

            <WebSearchBlock
              v-else-if="segment.block.kind === 'web_search'"
              :block="segment.block"
            />

            <WebFetchBlock
              v-else-if="segment.block.kind === 'web_fetch'"
              :block="segment.block"
            />

            <AttachmentBlock
              v-else-if="segment.block.kind === 'attachment'"
              :block="segment.block"
            />

            <AuthRequestBlock
              v-else-if="segment.block.kind === 'auth_request'"
              :block="segment.block"
              @respond-auth="(requestId, approved) => emit('respondAuth', requestId, approved)"
            />

            <SudoPasswordBlock
              v-else-if="segment.block.kind === 'sudo_password_request'"
              :block="segment.block"
              @respond-sudo-password="(requestId, password) => emit('respondSudoPassword', requestId, password)"
            />

            <ErrorBlock
              v-else-if="segment.block.kind === 'error'"
              :block="segment.block"
            />

            <ContentBlock
              v-else-if="segment.block.kind === 'content' && (hasRenderableBlock(segment.block) || (isStreamingAssistantMessage && segment.blockIndex === lastContentBlockIndex))"
              :block="segment.block"
              :role="props.msg.role"
              :message-index="props.index"
              :block-index="segment.blockIndex"
              :is-streaming-block="isStreamingAssistantMessage && segment.blockIndex === lastContentBlockIndex"
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
  padding: 0 0 20px;
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
  gap: 15px;
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

.message-author {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--app-text-strong);
}

/* Plain faint text, not a pill chip — the model label shouldn't compete
   with the author name next to it. */
.message-model-chip {
  display: inline-flex;
  align-items: center;
  color: var(--app-text-faint);
  font-size: 0.7rem;
}

.message-agent-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  border: none;
  background: var(--app-accent-soft);
  color: var(--app-accent-strong);
  line-height: 1;
}

.message-agent-emoji {
  font-size: 0.78rem;
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
