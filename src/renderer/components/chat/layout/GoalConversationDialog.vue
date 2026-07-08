<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MessageList from '../messages/MessageList.vue'
import ChatInput from './ChatInput.vue'
import ProviderModelDropdown from './ProviderModelDropdown.vue'
import type { ChatMessage, FilePreviewState } from '../types'

interface ProviderItem {
  id: string
  name: string
  models: string[]
}

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  subtitle?: string
  messages: ChatMessage[]
  allowInput?: boolean
  inputPlaceholder?: string
  providers?: ProviderItem[]
  activeProviderId?: string
  selectedModel?: string
  availableAgents?: Array<{ id: string; name: string; icon?: string }>
  selectedAgentId?: string
  isLoading?: boolean
}>(), {
  subtitle: '',
  allowInput: false,
  inputPlaceholder: '',
  providers: () => [],
  activeProviderId: '',
  selectedModel: '',
  availableAgents: () => [],
  selectedAgentId: '',
  isLoading: false
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'send', text: string): void
  (e: 'addAttachments', files: File[]): void
  (e: 'update:active-provider-id', id: string): void
  (e: 'update:selected-model', model: string): void
  (e: 'select', payload: { providerId: string; model: string }): void
  (e: 'update:selected-agent-id', id: string): void
}>()

const inputText = ref('')
const pendingFiles = ref<Array<{ id: string; name: string; fileType: string; fileSizeLabel: string }>>([])
const pendingImages = ref<Array<{ base64: string; mimeType: string }>>([])
const pendingAttachmentContents = ref<Array<{ id: string; name: string; fileType: string; content: string }>>([])
const filePreview = computed<FilePreviewState>(() => ({
  active: false,
  filePath: '',
  lineCount: 0,
  added: 0,
  removed: 0
}))

watch(
  () => props.open,
  (open) => {
    if (open) inputText.value = ''
  }
)

function send (): void {
  const text = inputText.value.trim()
  if (!text && pendingAttachmentContents.value.length === 0) return
  const attachmentText = buildAttachmentPrompt()
  emit('send', [text, attachmentText].filter(Boolean).join('\n\n'))
  inputText.value = ''
  pendingFiles.value = []
  pendingAttachmentContents.value = []
}

function noop (): void {}

function removeImage (index: number): void {
  pendingImages.value.splice(index, 1)
}

function removeFile (id: string): void {
  pendingFiles.value = pendingFiles.value.filter(file => file.id !== id)
  pendingAttachmentContents.value = pendingAttachmentContents.value.filter(file => file.id !== id)
}

function formatFileSize (size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function isTextFile (file: File): boolean {
  if (file.type.startsWith('text/')) return true
  return /\.(md|txt|json|csv|xml|html|css|js|ts|tsx|vue|py|rb|go|rs|java|c|cpp|h|hpp|sql|log)$/i.test(file.name)
}

async function handleAddAttachments (files: File[]): Promise<void> {
  const additions = await Promise.all(files.map(async (file) => {
    const id = `goal_attachment_${Math.random().toString(36).slice(2)}`
    let content = ''
    if (isTextFile(file) && file.size <= 1024 * 1024) {
      try {
        content = await file.text()
      } catch {
        content = ''
      }
    }
    return {
      preview: {
        id,
        name: file.name,
        fileType: file.type || 'file',
        fileSizeLabel: formatFileSize(file.size)
      },
      content: {
        id,
        name: file.name,
        fileType: file.type || 'file',
        content
      }
    }
  }))
  pendingFiles.value = [...pendingFiles.value, ...additions.map(item => item.preview)]
  pendingAttachmentContents.value = [...pendingAttachmentContents.value, ...additions.map(item => item.content)]
  emit('addAttachments', files)
}

function buildAttachmentPrompt (): string {
  if (pendingAttachmentContents.value.length === 0) return ''
  const sections = pendingAttachmentContents.value.map((file) => {
    if (!file.content.trim()) {
      return `- ${file.name} (${file.fileType})`
    }
    const content = file.content.length > 20000 ? `${file.content.slice(0, 20000)}\n\n[truncated]` : file.content
    return `### ${file.name}\n\n\`\`\`\n${content}\n\`\`\``
  })
  return `## Attachments\n\n${sections.join('\n\n')}`
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="goal-dialog-backdrop" @click.self="emit('close')">
      <section class="goal-dialog" role="dialog" aria-modal="true">
        <header class="goal-dialog-head">
          <div class="goal-dialog-titleline">
            <h2>{{ title }}</h2>
            <p v-if="subtitle">{{ subtitle }}</p>
          </div>
          <div class="goal-dialog-head-controls">
            <ProviderModelDropdown
              v-if="allowInput && providers.length > 0"
              class="goal-dialog-provider"
              :providers="providers"
              :active-provider-id="activeProviderId"
              :selected-model="selectedModel"
              :title="$t('chatUi.executionProvider')"
              @update:active-provider-id="(id) => emit('update:active-provider-id', id)"
              @update:selected-model="(model) => emit('update:selected-model', model)"
              @select="(payload) => emit('select', payload)"
            />
            <slot name="header-actions" />
            <button type="button" class="goal-dialog-close" @click="emit('close')">×</button>
          </div>
        </header>

        <div class="goal-dialog-messages">
          <MessageList
            :messages="messages"
            :is-loading="isLoading"
            :file-preview="filePreview"
            assistant-icon="◎"
            assistant-name="Long-Term Goal"
          />
        </div>

        <slot />

        <ChatInput
          v-if="allowInput"
          v-model="inputText"
          :is-loading="isLoading"
          :pending-auth-count="0"
          :pending-images="pendingImages"
          :pending-files="pendingFiles"
          :is-uploading-files="false"
          upload-feedback=""
          :document-dock-visible="false"
          :folder-workspace-visible="false"
          reasoning-strength="max"
          :temperature="null"
          :provider-default-temperature="0.3"
          auth-mode="strict"
          :plan-mode-active="false"
          :available-agents="availableAgents"
          :selected-agent-id="selectedAgentId"
          :is-new-conversation="false"
          @send="send"
          @stop="noop"
          @add-attachments="handleAddAttachments"
          @remove-image="removeImage"
          @remove-file="removeFile"
          @update:selected-agent-id="(id) => emit('update:selected-agent-id', id)"
          @update:reasoning-strength="noop"
          @update:temperature="noop"
          @toggle-document-dock="noop"
          @toggle-folder-workspace="noop"
          @update:auth-mode="noop"
          @toggle-plan-mode="noop"
        />
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.goal-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
}

.goal-dialog {
  width: min(1040px, 100%);
  height: min(860px, 92vh);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--app-chat-canvas);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.36);
}

.goal-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 50px;
  padding: 9px 12px 9px 16px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 96%, transparent);
}

.goal-dialog-titleline {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex: 1 1 auto;
}

.goal-dialog-head h2 {
  margin: 0;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 1rem;
  letter-spacing: 0;
}

.goal-dialog-head p {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-text-muted);
  font-size: 0.8rem;
}

.goal-dialog-head-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: 0 0 auto;
  min-width: 0;
}

.goal-dialog-provider {
  width: min(300px, 32vw);
  min-width: 180px;
}

.goal-dialog-close {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text);
  cursor: pointer;
}

.goal-dialog-messages {
  display: flex;
  min-height: 0;
  overflow: hidden;
  --chat-header-height: 0px;
  --chat-message-gutter: 18px;
}

.goal-dialog-messages :deep(.chat-messages) {
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
}

@media (max-width: 760px) {
  .goal-dialog-head {
    align-items: flex-start;
  }

  .goal-dialog-titleline {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  .goal-dialog-provider {
    width: min(220px, 42vw);
    min-width: 140px;
  }
}
</style>
