<script setup lang="ts">
import { computed, ref } from 'vue'

interface SkillItem {
  id: string
  name: string
  description?: string
  content?: string
}

interface PendingAttachment {
  id: string
  name: string
  fileType: string
  fileSizeLabel: string
}

interface DocumentTagChip {
  regionId: string
  label: string
  raw: string
}

interface ProjectTagChip {
  projectId: string
  name: string
  raw: string
}

type ReasoningStrength = 'low' | 'medium' | 'high' | 'max'
type AIExecutionAuthMode = 'strict' | 'auto'

interface ProviderItem {
  id: string
  name: string
  models: string[]
}

interface AgentOption {
  id: string
  name: string
  icon?: string
}

interface GroupMentionHint {
  token: string
  label: string
}

const props = defineProps<{
  modelValue: string
  isLoading: boolean
  pendingAuthCount?: number
  pendingImages: Array<{ base64: string; mimeType: string }>
  pendingFiles: PendingAttachment[]
  isUploadingFiles: boolean
  uploadFeedback: string
  availableSkills: SkillItem[]
  activeSkillIds: Set<string>
  documentDockVisible: boolean
  reasoningStrength: ReasoningStrength
  authMode: AIExecutionAuthMode
  planModeActive: boolean
  providers?: ProviderItem[]
  activeProviderId?: string
  selectedModel?: string
  showProviderSelector?: boolean
  availableAgents?: AgentOption[]
  selectedAgentId?: string
  groupMentionHints?: GroupMentionHint[]
  isNewConversation?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'send'): void
  (e: 'stop'): void
  (e: 'addAttachments', files: File[]): void
  (e: 'removeImage', index: number): void
  (e: 'removeFile', id: string): void
  (e: 'update:reasoning-strength', value: ReasoningStrength): void
  (e: 'toggleSkill', id: string): void
  (e: 'toggleDocumentDock'): void
  (e: 'update:auth-mode', value: AIExecutionAuthMode): void
  (e: 'togglePlanMode'): void
  (e: 'update:active-provider-id', id: string): void
  (e: 'update:selected-model', model: string): void
  (e: 'update:selected-agent-id', id: string): void
}>()

const DOCUMENT_TAG_PATTERN = /\[\[doc:([A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g
const PROJECT_TAG_PATTERN = /\[\[project:([^\]|]+)(?:\|([^\]]*))?\]\]/g

const inputFocused = ref(false)
const dragDepth = ref(0)
const dragActive = ref(false)
const reasoningLevels: Array<{ value: ReasoningStrength; label: string }> = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最高' }
]
const currentReasoningIndex = computed(() => {
  const index = reasoningLevels.findIndex(level => level.value === props.reasoningStrength)
  return index >= 0 ? index : 1
})
const currentReasoningLabel = computed(() => {
  return reasoningLevels[currentReasoningIndex.value]?.label || '中'
})
const projectTags = computed<ProjectTagChip[]>(() => {
  const seenIds = new Set<string>()
  const tags: ProjectTagChip[] = []
  for (const match of props.modelValue.matchAll(PROJECT_TAG_PATTERN)) {
    const projectId = match[1]
    if (seenIds.has(projectId)) continue
    seenIds.add(projectId)
    tags.push({ projectId, name: match[2]?.trim() || projectId, raw: match[0] })
  }
  return tags
})
const documentTags = computed<DocumentTagChip[]>(() => {
  const seenRegionIds = new Set<string>()
  const tags: DocumentTagChip[] = []

  for (const match of props.modelValue.matchAll(DOCUMENT_TAG_PATTERN)) {
    const regionId = match[1]
    if (seenRegionIds.has(regionId)) continue
    seenRegionIds.add(regionId)
    tags.push({
      regionId,
      label: match[2]?.trim() || '文档标签',
      raw: match[0]
    })
  }

  return tags
})
const plainDraftText = computed(() => {
  return props.modelValue
    .replace(PROJECT_TAG_PATTERN, '')
    .replace(DOCUMENT_TAG_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\n+/, '')
})
const hasDraftContent = computed(() => {
  return props.modelValue.trim().length > 0 || props.pendingImages.length > 0 || props.pendingFiles.length > 0
})
const isSendDisabled = computed(() => props.isUploadingFiles || (!props.isLoading && !hasDraftContent.value))
const runtimeStatusLabel = computed(() => {
  if (!props.isLoading) {
    return ''
  }

  if ((props.pendingAuthCount || 0) > 0) {
    return props.pendingAuthCount === 1 ? '等待授权以继续执行' : `等待 ${props.pendingAuthCount} 项授权以继续执行`
  }

  return '执行中，请稍候'
})

function buildDraftValue (tags: DocumentTagChip[], text: string): string {
  const tagSegment = tags.map(tag => tag.raw).join(' ')
  if (tagSegment && text) return `${tagSegment}\n${text}`
  return tagSegment || text
}

function removeProjectTag (projectId: string) {
  const remaining = projectTags.value.filter(t => t.projectId !== projectId)
  const projectSegment = remaining.map(t => t.raw).join(' ')
  const docSegment = documentTags.value.map(t => t.raw).join(' ')
  const tagSegment = [projectSegment, docSegment].filter(Boolean).join(' ')
  const text = plainDraftText.value
  if (tagSegment && text) { emit('update:modelValue', `${tagSegment}\n${text}`); return }
  emit('update:modelValue', tagSegment || text)
}

function handleTextInput (e: Event) {
  const nextText = (e.target as HTMLTextAreaElement).value
  const projectSegment = projectTags.value.map(t => t.raw).join(' ')
  const docSegment = documentTags.value.map(t => t.raw).join(' ')
  const tagSegment = [projectSegment, docSegment].filter(Boolean).join(' ')
  if (tagSegment && nextText) { emit('update:modelValue', `${tagSegment}\n${nextText}`); return }
  emit('update:modelValue', tagSegment || nextText)
}

function removeDocumentTag (regionId: string) {
  const remainingTags = documentTags.value.filter(tag => tag.regionId !== regionId)
  emit('update:modelValue', buildDraftValue(remainingTags, plainDraftText.value))
}

function handleKeydown (e: KeyboardEvent) {
  if (props.isLoading) return
  if (e.key === 'Backspace' && plainDraftText.value.trim().length === 0) {
    if (documentTags.value.length > 0) {
      e.preventDefault()
      removeDocumentTag(documentTags.value[documentTags.value.length - 1].regionId)
      return
    }
    if (projectTags.value.length > 0) {
      e.preventDefault()
      removeProjectTag(projectTags.value[projectTags.value.length - 1].projectId)
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    emit('send')
  }
}

function collectTransferFiles (transfer: DataTransfer | null): File[] {
  if (!transfer) return []

  const directFiles = Array.from(transfer.files || [])
  if (directFiles.length > 0) return directFiles

  return Array.from(transfer.items || [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => Boolean(file))
}

function hasTransferFiles (transfer: DataTransfer | null): boolean {
  return collectTransferFiles(transfer).length > 0
}

function handleAttachmentSelection (e: Event) {
  if (props.isLoading || props.isUploadingFiles) return
  const input = e.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return

  emit('addAttachments', Array.from(input.files))
  input.value = ''
}

function handlePaste (e: ClipboardEvent) {
  if (props.isLoading || props.isUploadingFiles) return

  const files = collectTransferFiles(e.clipboardData)
  if (files.length === 0) return

  e.preventDefault()
  emit('addAttachments', files)
}

function handleDragEnter (e: DragEvent) {
  if (props.isLoading || props.isUploadingFiles || !hasTransferFiles(e.dataTransfer)) return

  e.preventDefault()
  dragDepth.value += 1
  dragActive.value = true
}

function handleDragOver (e: DragEvent) {
  if (!hasTransferFiles(e.dataTransfer)) return

  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = props.isLoading || props.isUploadingFiles ? 'none' : 'copy'
  }

  if (!props.isLoading && !props.isUploadingFiles) {
    dragActive.value = true
  }
}

function handleDragLeave (e: DragEvent) {
  if (!hasTransferFiles(e.dataTransfer)) return

  e.preventDefault()
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (dragDepth.value === 0) {
    dragActive.value = false
  }
}

function handleDrop (e: DragEvent) {
  const files = collectTransferFiles(e.dataTransfer)
  e.preventDefault()

  dragDepth.value = 0
  dragActive.value = false

  if (props.isLoading || props.isUploadingFiles || files.length === 0) return
  emit('addAttachments', files)
}

function handleReasoningStrengthInput (event: Event) {
  const nextIndex = Number.parseInt((event.target as HTMLInputElement).value, 10)
  const nextLevel = reasoningLevels[nextIndex]
  if (!nextLevel) return
  emit('update:reasoning-strength', nextLevel.value)
}

function appendMentionToken (token: string) {
  if (props.isLoading || props.isUploadingFiles) return
  const currentValue = props.modelValue || ''
  const spacer = currentValue.length > 0 && !/\s$/.test(currentValue) ? ' ' : ''
  emit('update:modelValue', `${currentValue}${spacer}${token} `.trimStart())
}
</script>

<template>
  <div class="chat-input">
    <!-- Active skill badges -->
    <div v-if="props.activeSkillIds.size > 0" class="active-skills-bar">
      <span
        v-for="skill in props.availableSkills.filter(s => props.activeSkillIds.has(s.id))"
        :key="skill.id"
        class="skill-badge"
      >
        🧠 {{ skill.name }}
        <button class="skill-badge-remove" @click="emit('toggleSkill', skill.id)">×</button>
      </span>
    </div>

    <!-- Unified input container -->
    <div
      class="input-container"
      :class="{ focused: inputFocused, dragging: dragActive, busy: props.isLoading, waitingAuth: (props.pendingAuthCount || 0) > 0 }"
      @dragenter="handleDragEnter"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <!-- Image preview inside input -->
      <div v-if="props.pendingFiles.length > 0" class="file-preview-bar">
        <div v-for="file in props.pendingFiles" :key="file.id" class="file-preview-item">
          <div class="file-preview-icon">📎</div>
          <div class="file-preview-meta">
            <div class="file-preview-name">{{ file.name }}</div>
            <div class="file-preview-detail">{{ file.fileType.toUpperCase() }} · {{ file.fileSizeLabel }}</div>
          </div>
          <button class="file-remove" @click="emit('removeFile', file.id)">×</button>
        </div>
      </div>
      <div v-if="props.pendingImages.length > 0" class="image-preview-bar">
        <div v-for="(img, idx) in props.pendingImages" :key="idx" class="image-preview-item">
          <img :src="img.base64" class="image-thumb" />
          <button class="image-remove" @click="emit('removeImage', idx)">×</button>
        </div>
      </div>
      <div v-if="projectTags.length > 0" class="project-tag-bar">
        <div v-for="tag in projectTags" :key="tag.projectId" class="project-tag-chip">
          <span class="project-tag-chip-prefix">📦</span>
          <span class="project-tag-chip-label">{{ tag.name }}</span>
          <button class="project-tag-chip-remove" @click="removeProjectTag(tag.projectId)" title="移除项目标签">×</button>
        </div>
      </div>
      <div v-if="documentTags.length > 0" class="document-tag-bar">
        <div v-for="tag in documentTags" :key="tag.regionId" class="document-tag-chip">
          <span class="document-tag-chip-prefix">#</span>
          <span class="document-tag-chip-label">{{ tag.label }}</span>
          <button class="document-tag-chip-remove" @click="removeDocumentTag(tag.regionId)" title="移除文档标签">×</button>
        </div>
      </div>
      <textarea
        :value="plainDraftText"
        :class="{ busy: props.isLoading }"
        placeholder="输入消息… (Enter 发送, Shift+Enter 换行)"
        :aria-busy="props.isLoading ? 'true' : 'false'"
        @input="handleTextInput"
        @keydown="handleKeydown"
        @paste="handlePaste"
        @focus="inputFocused = true"
        @blur="inputFocused = false"
        rows="3"
      />
      <div v-if="props.isLoading" class="runtime-status-bar" :class="{ waitingAuth: (props.pendingAuthCount || 0) > 0 }" role="status" aria-live="polite">
        <span class="runtime-status-indicator"></span>
        <span class="runtime-status-copy">{{ runtimeStatusLabel }}</span>
      </div>
      <div v-if="props.groupMentionHints && props.groupMentionHints.length > 0" class="group-mention-bar">
        <span class="group-mention-copy">群组快捷：</span>
        <button
          v-for="hint in props.groupMentionHints"
          :key="hint.token"
          class="group-mention-chip"
          type="button"
          @click="appendMentionToken(hint.token)"
        >
          {{ hint.label }}
        </button>
      </div>
      <div class="input-actions">
        <div class="input-actions-left">
          <template v-if="props.isNewConversation && props.availableAgents && props.availableAgents.length > 0">
            <select
              class="context-select agent-select"
              :value="props.selectedAgentId || ''"
              @change="emit('update:selected-agent-id', ($event.target as HTMLSelectElement).value)"
              title="选择 Agent"
            >
              <option value="">默认 Agent</option>
              <option v-for="agent in props.availableAgents" :key="agent.id" :value="agent.id">
                {{ agent.icon ? agent.icon + ' ' : '' }}{{ agent.name }}
              </option>
            </select>
          </template>
          <template v-if="props.showProviderSelector && props.providers && props.providers.length > 0">
            <select
              class="context-select provider-select"
              :value="props.activeProviderId"
              @change="emit('update:active-provider-id', ($event.target as HTMLSelectElement).value)"
              title="切换供应商"
            >
              <option v-for="p in props.providers" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <select
              class="context-select model-select"
              :value="props.selectedModel"
              @change="emit('update:selected-model', ($event.target as HTMLSelectElement).value)"
              title="切换模型"
            >
              <option
                v-for="model in (props.providers.find(p => p.id === props.activeProviderId)?.models ?? [])"
                :key="model"
                :value="model"
              >{{ model }}</option>
            </select>
          </template>
          <select
            class="context-select"
            :value="props.authMode"
            @change="emit('update:auth-mode', ($event.target as HTMLSelectElement).value as AIExecutionAuthMode)"
            title="授权模式"
          >
            <option value="strict">严格授权</option>
            <option value="auto">自动执行</option>
          </select>
          <button
            class="plan-mode-btn"
            :class="{ active: props.planModeActive }"
            @click="emit('togglePlanMode')"
            :title="props.planModeActive ? '退出规划模式' : '进入规划模式'"
          >
            📋 {{ props.planModeActive ? '规划中' : '规划' }}
          </button>
        </div>
        <div class="input-actions-right">
        <button class="action-btn doc-btn" :class="{ active: props.documentDockVisible }" @click="emit('toggleDocumentDock')" title="文档工作台">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        </button>
        <label class="reasoning-slider" :title="`推理强度：${currentReasoningLabel}`">
          <span class="reasoning-slider-label">思考 {{ currentReasoningLabel }}</span>
          <input
            class="reasoning-slider-input"
            type="range"
            min="0"
            :max="reasoningLevels.length - 1"
            step="1"
            :value="currentReasoningIndex"
            @input="handleReasoningStrengthInput"
          >
        </label>
        <label class="action-btn upload-btn" :class="{ disabled: props.isLoading || props.isUploadingFiles }" :aria-disabled="props.isLoading || props.isUploadingFiles" title="添加附件">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 115.66 5.66l-9.2 9.2a2 2 0 01-2.82-2.83l8.49-8.48"/></svg>
          <input type="file" multiple hidden :disabled="props.isLoading || props.isUploadingFiles" @change="handleAttachmentSelection" />
        </label>
        <button
          class="action-btn send-btn"
          :class="{ stopping: props.isLoading, waitingAuth: (props.pendingAuthCount || 0) > 0 }"
          @click="props.isLoading ? emit('stop') : emit('send')"
          :disabled="isSendDisabled"
          :title="props.isUploadingFiles ? '文件处理中...' : (props.isLoading ? '停止生成' : '发送')"
        >
          <svg v-if="!props.isLoading" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        </button>
        </div>
      </div>
    </div>
    <div v-if="props.uploadFeedback" class="upload-feedback" role="status">{{ props.uploadFeedback }}</div>
  </div>
</template>

<style scoped>
.chat-input {
  padding: 12px var(--chat-message-gutter, 24px) 16px;
  border-top: 1px solid var(--app-border);
  background: linear-gradient(180deg, transparent, var(--app-panel-subtle));
}

.chat-input > * {
  max-width: var(--chat-message-track-max, 1480px);
  margin-left: auto;
  margin-right: auto;
}

.input-container {
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 12px;
  transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
  overflow: hidden;
  box-shadow: var(--app-shadow);
}

.input-container.focused {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px var(--app-accent-soft);
}

.input-container.dragging {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px var(--app-accent-soft);
  background: color-mix(in srgb, var(--app-accent-soft) 26%, var(--app-input-bg));
}

.input-container.busy {
  border-color: color-mix(in srgb, var(--app-accent-glow) 72%, transparent);
  box-shadow: 0 0 0 1px rgba(91, 140, 255, 0.08), 0 18px 36px rgba(91, 140, 255, 0.08);
}

.input-container.waitingAuth {
  border-color: rgba(245, 158, 11, 0.42);
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.12), 0 18px 36px rgba(245, 158, 11, 0.12);
  background: color-mix(in srgb, rgba(245, 158, 11, 0.08) 32%, var(--app-input-bg));
}

.image-preview-bar {
  display: flex;
  gap: 8px;
  padding: 10px 12px 4px;
  flex-wrap: wrap;
}

.file-preview-bar {
  display: flex;
  gap: 8px;
  padding: 10px 12px 0;
  flex-wrap: wrap;
}

.file-preview-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 180px;
  max-width: 280px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-subtle);
}

.file-preview-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--app-accent-soft);
  flex-shrink: 0;
}

.file-preview-meta {
  min-width: 0;
  flex: 1;
}

.file-preview-name {
  font-size: 0.84em;
  color: var(--app-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-preview-detail {
  margin-top: 2px;
  font-size: 0.72em;
  color: var(--app-text-muted);
}

.image-preview-item {
  position: relative;
  display: inline-block;
}

.image-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--app-border-strong);
}

.image-remove {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--app-danger);
  color: #ffffff;
  border: none;
  font-size: 0.7em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.15s;
}

.image-preview-item:hover .image-remove { opacity: 1; }
.file-preview-item:hover .file-remove { opacity: 1; }

.file-remove {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--app-danger);
  color: #ffffff;
  border: none;
  font-size: 0.7em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.15s;
}

.project-tag-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px 0;
}

.group-mention-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 12px 0;
}

.group-mention-copy {
  font-size: 0.76em;
  color: var(--app-text-muted);
}

.group-mention-chip {
  border: 1px solid color-mix(in srgb, var(--app-accent) 24%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 38%, transparent);
  color: var(--app-text-soft);
  border-radius: 999px;
  padding: 5px 10px;
  font-size: 0.76em;
  cursor: pointer;
}

.group-mention-chip:hover {
  color: var(--app-text-strong);
  border-color: var(--app-accent);
}

.project-tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 40%, transparent);
  background: color-mix(in srgb, var(--app-accent) 12%, transparent);
  color: var(--app-text-soft);
}

.project-tag-chip-prefix {
  font-size: 0.82em;
}

.project-tag-chip-label {
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.8em;
  font-weight: 600;
  color: var(--app-accent);
}

.project-tag-chip-remove {
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  line-height: 1;
  padding: 0;
}

.project-tag-chip-remove:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--app-danger);
}

.document-tag-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px 0;
}

.document-tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--app-accent-glow);
  background: var(--app-accent-soft);
  color: var(--app-text-soft);
}

.document-tag-chip-prefix {
  color: var(--app-accent);
  font-weight: 700;
}

.document-tag-chip-label {
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.8em;
  font-weight: 600;
}

.document-tag-chip-remove {
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  line-height: 1;
  padding: 0;
}

.document-tag-chip-remove:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--app-danger);
}

.input-container textarea {
  display: block;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--app-text);
  padding: 12px 14px 4px;
  font-size: 0.92em;
  line-height: 1.5;
  resize: none;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.input-container textarea::-webkit-scrollbar { width: 5px; }
.input-container textarea::-webkit-scrollbar-track { background: transparent; }
.input-container textarea::-webkit-scrollbar-thumb { background: var(--app-scrollbar); border-radius: 3px; }
.input-container textarea::placeholder { color: var(--app-text-faint); }

.input-container textarea.busy {
  opacity: 0.8;
  cursor: progress;
}

.runtime-status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 12px 4px;
  padding: 8px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-accent-soft) 72%, transparent);
  color: var(--app-accent-strong);
}

.runtime-status-bar.waitingAuth {
  background: rgba(245, 158, 11, 0.14);
  color: #b45309;
}

.runtime-status-indicator {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: currentColor;
  animation: runtime-pulse 1.2s ease-in-out infinite;
}

.runtime-status-copy {
  font-size: 0.8rem;
  font-weight: 600;
}

.input-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 4px 8px 8px;
}

.input-actions-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.input-actions-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.context-select {
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 6px;
  color: var(--app-text);
  padding: 4px 8px;
  font-size: 0.76em;
  cursor: pointer;
  height: 28px;
  transition: border-color 0.15s;
  min-width: 0;
}

.context-select option {
  background: var(--app-input-bg);
  color: var(--app-text);
}

.context-select:focus {
  outline: none;
  border-color: var(--app-accent);
}

.agent-select {
  max-width: 130px;
}

.provider-select {
  max-width: 110px;
}

.model-select {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plan-mode-btn {
  padding: 4px 10px;
  height: 28px;
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 6px;
  color: var(--app-text-muted);
  font-size: 0.76em;
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
}

.plan-mode-btn:hover {
  border-color: var(--app-accent);
  color: var(--app-text);
}

.plan-mode-btn.active {
  border-color: #f59e0b;
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.1);
}

.reasoning-slider {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 154px;
  padding: 0 8px;
  height: 34px;
  border-radius: 8px;
  color: var(--app-text-muted);
  background: var(--app-panel-muted);
}

.reasoning-slider-label {
  flex-shrink: 0;
  font-size: 0.74em;
  color: var(--app-text-soft);
  white-space: nowrap;
}

.reasoning-slider-input {
  width: 76px;
  accent-color: var(--app-accent);
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.action-btn:hover { background: var(--app-panel-muted); color: var(--app-text); }
.action-btn.doc-btn.active { color: var(--app-accent); background: var(--app-accent-soft); }
.action-btn.upload-btn { cursor: pointer; }
.action-btn.disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.upload-feedback {
  margin-top: 8px;
  padding: 0 4px;
  color: var(--app-danger);
  font-size: 0.78em;
  line-height: 1.5;
}

.action-btn.send-btn {
  background: var(--app-accent);
  color: #ffffff;
}

.action-btn.send-btn:hover:not(:disabled) { background: var(--app-accent-strong); }

.action-btn.send-btn.stopping {
  background: var(--app-danger);
  box-shadow: 0 10px 24px rgba(220, 38, 38, 0.24);
}

.action-btn.send-btn.stopping:hover:not(:disabled) {
  background: #dc2626;
}

.action-btn.send-btn.stopping.waitingAuth {
  background: #f59e0b;
  box-shadow: 0 10px 24px rgba(245, 158, 11, 0.28);
}

.action-btn.send-btn.stopping.waitingAuth:hover:not(:disabled) {
  background: #d97706;
}

.action-btn.send-btn:disabled {
  background: var(--app-panel-muted);
  color: var(--app-text-faint);
  cursor: not-allowed;
}

/* Active skills bar */
.active-skills-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 8px;
}

.skill-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  background: var(--app-accent-soft);
  border: 1px solid var(--app-accent-glow);
  border-radius: 999px;
  font-size: 0.75em;
  color: var(--app-text-soft);
}

.skill-badge-remove {
  background: none;
  border: none;
  color: var(--app-accent);
  cursor: pointer;
  font-size: 1em;
  padding: 0 2px;
  line-height: 1;
}

.skill-badge-remove:hover { color: var(--app-danger); }

@keyframes runtime-pulse {
  0%, 100% { transform: scale(0.9); opacity: 0.72; }
  50% { transform: scale(1.2); opacity: 1; }
}
</style>
