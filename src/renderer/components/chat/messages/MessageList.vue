<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick } from 'vue'
import { buildMessageBlocks, getContentParts } from '../message-utils'
import type { ChatMessage, GalleryImage, FilePreviewState } from '../types'
import MessageRow from './MessageRow.vue'
import ImageLightbox from '../media/ImageLightbox.vue'
import MermaidPreviewDialog from '../media/MermaidPreviewDialog.vue'

const props = defineProps<{
  messages: ChatMessage[]
  isLoading: boolean
  filePreview: FilePreviewState
}>()

const emit = defineEmits<{
  (e: 'respondAuth', requestId: string, approved: boolean): void
  (e: 'openLink', url: string): void
}>()

const messagesContainer = ref<HTMLElement | null>(null)
const lightboxRef = ref<InstanceType<typeof ImageLightbox> | null>(null)
const collapsedThinking = reactive<Record<string, boolean>>({})
const activeMermaidPreview = ref<{ code: string } | null>(null)

const latestAssistantMessageIndex = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if (props.messages[i].role === 'assistant') return i
  }
  return -1
})

const galleryImages = computed<GalleryImage[]>(() => {
  const images: GalleryImage[] = []
  props.messages.forEach((message, messageIndex) => {
    buildMessageBlocks(message, messageIndex, props.filePreview, latestAssistantMessageIndex.value, props.isLoading)
      .forEach((block, blockIndex) => {
        if (block.kind !== 'content') return
        getContentParts(block.content).forEach((part, partIndex) => {
          if (part.type === 'image_url' && part.image_url?.url) {
            images.push({ url: part.image_url.url, messageIndex, blockIndex, partIndex })
          }
        })
      })
  })
  return images
})

function toggleThinking (id: string): void {
  collapsedThinking[id] = !collapsedThinking[id]
}

function openLightbox (messageIndex: number, blockIndex: number, partIndex: number) {
  lightboxRef.value?.open(messageIndex, blockIndex, partIndex)
}

function openMermaidPreview (code: string) {
  activeMermaidPreview.value = { code }
}

function closeMermaidPreview () {
  activeMermaidPreview.value = null
}

function handleMessageLinkClick (event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  const link = target?.closest('a[href]') as HTMLAnchorElement | null
  if (!link || (!link.closest('.markdown-body') && !link.hasAttribute('data-chat-external'))) return

  const href = link.getAttribute('href')?.trim()
  if (!href || !/^https?:\/\//i.test(href)) return

  let url: URL
  try {
    url = new URL(href)
  } catch {
    return
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  event.preventDefault()
  emit('openLink', url.toString())
}

function scrollToBottom () {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

function getMessageSignature (msg?: ChatMessage): string {
  if (!msg) return ''
  const blocks = Array.isArray(msg.blocks) && msg.blocks.length > 0
    ? msg.blocks
    : buildMessageBlocks(msg, -1, props.filePreview, latestAssistantMessageIndex.value, false)
  const blockSignature = blocks.map(block => {
    if (block.kind === 'content') {
      return `content:${getContentParts(block.content)
        .map(part => part.type === 'image_url' ? part.image_url?.url || '' : part.text || '')
        .join('|')}`
    }
    if (block.kind === 'thinking') return `thinking:${block.text}`
    if (block.kind === 'file_preview') return `preview:${block.filePath}:${block.previewContent}:${block.truncated}:${block.active}`
    if (block.kind === 'web_search') return `websearch:${block.query}:${block.engine}:${block.results.map(item => `${item.rank}:${item.url}:${item.title}:${item.snippet}`).join('|')}`
    if (block.kind === 'web_fetch') return `webfetch:${block.query || ''}:${block.result.url}:${block.result.final_url || ''}:${block.result.ok}:${block.result.title || ''}:${block.result.error || ''}:${block.result.query_snippets?.join('|') || ''}`
    if (block.kind === 'attachment') return `attachment:${block.fileName}:${block.fileType}:${block.fileSizeLabel}:${block.previewText}`
    if (block.kind === 'auth_request') return `auth:${block.requestId}:${block.status}:${block.title}:${block.detail}`
    return `tool:${block.toolRun.id}:${block.toolRun.status}:${block.toolRun.progress.map(step => `${step.stage}:${step.detail || ''}`).join('>')}`
  }).join('|')
  return [blockSignature, msg.thinking || '', msg.modelLabel || ''].join('::')
}

// Auto-collapse thinking blocks when streaming finishes
watch(
  () => props.isLoading,
  (loading, wasLoading) => {
    if (!loading && wasLoading) {
      const lastIdx = props.messages.length - 1
      if (lastIdx < 0) return
      const last = props.messages[lastIdx]
      if (last?.role !== 'assistant') return
      buildMessageBlocks(last, lastIdx, props.filePreview, latestAssistantMessageIndex.value, false)
        .forEach(block => {
          if (block.kind === 'thinking') collapsedThinking[block.id] = true
        })
    }
  }
)

watch(() => props.messages.length, scrollToBottom)

watch(
  () => getMessageSignature(props.messages[props.messages.length - 1]),
  scrollToBottom
)

watch(
  () => [props.filePreview.active, props.filePreview.content],
  scrollToBottom
)
</script>

<template>
  <div class="chat-messages" ref="messagesContainer" @click.capture="handleMessageLinkClick">
    <div v-if="props.messages.length === 0" class="empty-state">
      <div class="empty-state-card">
        <div class="empty-state-icon">AI</div>
        <h3>开始一段新对话</h3>
        <p>我可以为你创建应用、修改项目、分析数据，或者直接协助调试现有代码。</p>
        <ul>
          <li>创建一个新的 Web 应用项目</li>
          <li>修改现有项目的前后端逻辑</li>
          <li>分析项目中的数据库与业务数据</li>
          <li>调用运行中项目的 API 进行排查</li>
        </ul>
      </div>
    </div>

    <MessageRow
      v-for="(msg, i) in props.messages"
      :key="i"
      :msg="msg"
      :index="i"
      :is-loading="props.isLoading"
      :latest-assistant-message-index="latestAssistantMessageIndex"
      :file-preview="props.filePreview"
      :collapsed-thinking="collapsedThinking"
      @respond-auth="(requestId, approved) => emit('respondAuth', requestId, approved)"
      @toggle-thinking="toggleThinking"
      @open-lightbox="(mi, bi, pi) => openLightbox(mi, bi, pi)"
      @open-mermaid-preview="openMermaidPreview"
    />

    <ImageLightbox ref="lightboxRef" :images="galleryImages" />
    <MermaidPreviewDialog :diagram="activeMermaidPreview" @close="closeMermaidPreview" />
  </div>
</template>

<style scoped>
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px var(--chat-message-gutter, 28px) 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  scrollbar-gutter: stable;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
}

.empty-state-card {
  width: min(720px, 100%);
  padding: 28px 30px;
  border-radius: 24px;
  border: 1px solid var(--app-border-strong);
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: var(--app-shadow);
  color: var(--app-text);
}

.empty-state-icon {
  width: 48px;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  background: linear-gradient(135deg, var(--app-accent), var(--app-accent-strong));
  color: #ffffff;
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.empty-state-card h3 {
  margin: 18px 0 8px;
  color: var(--app-text-strong);
}

.empty-state-card p {
  margin: 0;
  color: var(--app-text-muted);
  line-height: 1.7;
}

.empty-state-card ul {
  margin: 18px 0 0;
  padding-left: 1.25rem;
  color: var(--app-text-soft);
  line-height: 1.8;
}

@media (max-width: 860px) {
  .chat-messages {
    padding: 20px 16px 16px;
  }

  .empty-state-card {
    width: min(100%, 640px);
  }
}
</style>
