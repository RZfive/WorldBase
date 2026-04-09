<script setup lang="ts">
import { ref } from 'vue'

interface SkillItem {
  id: string
  name: string
  description?: string
  content?: string
}

interface PendingOfficeFile {
  id: string
  name: string
  fileType: string
  fileSizeLabel: string
}

const props = defineProps<{
  modelValue: string
  isLoading: boolean
  pendingImages: Array<{ base64: string; mimeType: string }>
  pendingFiles: PendingOfficeFile[]
  isUploadingFiles: boolean
  uploadFeedback: string
  availableSkills: SkillItem[]
  activeSkillIds: Set<string>
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'send'): void
  (e: 'stop'): void
  (e: 'addImage', base64: string, mimeType: string): void
  (e: 'addFiles', files: File[]): void
  (e: 'removeImage', index: number): void
  (e: 'removeFile', id: string): void
  (e: 'toggleSkill', id: string): void
}>()

const inputFocused = ref(false)

function handleKeydown (e: KeyboardEvent) {
  if (props.isLoading) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    emit('send')
  }
}

function handleImageUpload (e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return

  for (const file of Array.from(input.files)) {
    if (!file.type.startsWith('image/')) continue
    if (file.size > 20 * 1024 * 1024) {
      alert('图片大小不能超过 20MB')
      continue
    }

    const reader = new FileReader()
    reader.onload = () => {
      const base64 = reader.result as string
      emit('addImage', base64, file.type)
    }
    reader.readAsDataURL(file)
  }

  input.value = ''
}

function handleOfficeUpload (e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return
  emit('addFiles', Array.from(input.files))
  input.value = ''
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
    <div class="input-container" :class="{ focused: inputFocused }">
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
      <textarea
        :value="props.modelValue"
        placeholder="输入消息… (Enter 发送, Shift+Enter 换行)"
        :aria-busy="props.isLoading"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @keydown="handleKeydown"
        @focus="inputFocused = true"
        @blur="inputFocused = false"
        rows="3"
      />
      <div class="input-actions">
        <label class="action-btn upload-btn" :class="{ disabled: props.isLoading || props.isUploadingFiles }" :aria-disabled="props.isLoading || props.isUploadingFiles" title="上传 Office 文件">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 115.66 5.66l-9.2 9.2a2 2 0 01-2.82-2.83l8.49-8.48"/></svg>
          <input
            type="file"
            accept=".xlsx,.xls,.docx,.doc,.pptx,.ppt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint"
            multiple
            hidden
            :disabled="props.isLoading || props.isUploadingFiles"
            @change="handleOfficeUpload"
          />
        </label>
        <label class="action-btn upload-btn" :class="{ disabled: props.isLoading || props.isUploadingFiles }" :aria-disabled="props.isLoading || props.isUploadingFiles" title="上传图片">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          <input type="file" accept="image/*" multiple hidden :disabled="props.isLoading || props.isUploadingFiles" @change="handleImageUpload" />
        </label>
        <button
          class="action-btn send-btn"
          :class="{ stopping: props.isLoading }"
          @click="props.isLoading ? emit('stop') : emit('send')"
          :disabled="props.isUploadingFiles || (!props.isLoading && !props.modelValue.trim() && props.pendingImages.length === 0 && props.pendingFiles.length === 0)"
          :title="props.isUploadingFiles ? '文件处理中...' : (props.isLoading ? '停止生成' : '发送')"
        >
          <svg v-if="!props.isLoading" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        </button>
      </div>
    </div>
    <div v-if="props.uploadFeedback" class="upload-feedback" role="status">{{ props.uploadFeedback }}</div>
  </div>
</template>

<style scoped>
.chat-input {
  padding: 12px 24px 16px;
  border-top: 1px solid var(--app-border);
  background: linear-gradient(180deg, transparent, var(--app-panel-subtle));
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

.input-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  padding: 4px 8px 8px;
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
}

.action-btn.send-btn.stopping:hover:not(:disabled) {
  background: #dc2626;
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
</style>
