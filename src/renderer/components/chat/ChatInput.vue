<script setup lang="ts">
import { ref } from 'vue'

interface SkillItem {
  id: string
  name: string
  description?: string
  content?: string
}

const props = defineProps<{
  modelValue: string
  isLoading: boolean
  pendingImages: Array<{ base64: string; mimeType: string }>
  availableSkills: SkillItem[]
  activeSkillIds: Set<string>
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'send'): void
  (e: 'addImage', base64: string, mimeType: string): void
  (e: 'removeImage', index: number): void
  (e: 'toggleSkill', id: string): void
}>()

const inputFocused = ref(false)

function handleKeydown (e: KeyboardEvent) {
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
      <div v-if="props.pendingImages.length > 0" class="image-preview-bar">
        <div v-for="(img, idx) in props.pendingImages" :key="idx" class="image-preview-item">
          <img :src="img.base64" class="image-thumb" />
          <button class="image-remove" @click="emit('removeImage', idx)">×</button>
        </div>
      </div>
      <textarea
        :value="props.modelValue"
        placeholder="输入消息… (Enter 发送, Shift+Enter 换行)"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @keydown="handleKeydown"
        @focus="inputFocused = true"
        @blur="inputFocused = false"
        :disabled="props.isLoading"
        rows="3"
      />
      <div class="input-actions">
        <label class="action-btn upload-btn" title="上传图片">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          <input type="file" accept="image/*" multiple hidden @change="handleImageUpload" />
        </label>
        <button
          class="action-btn send-btn"
          @click="emit('send')"
          :disabled="props.isLoading || (!props.modelValue.trim() && props.pendingImages.length === 0)"
          :title="props.isLoading ? '生成中...' : '发送'"
        >
          <svg v-if="!props.isLoading" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          <span v-else class="send-spinner"></span>
        </button>
      </div>
    </div>
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

.action-btn.send-btn {
  background: var(--app-accent);
  color: #ffffff;
}

.action-btn.send-btn:hover:not(:disabled) { background: var(--app-accent-strong); }

.action-btn.send-btn:disabled {
  background: var(--app-panel-muted);
  color: var(--app-text-faint);
  cursor: not-allowed;
}

.send-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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
