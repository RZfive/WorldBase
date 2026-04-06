<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getProjectIcon } from '../../utils/project-icon'
import type { Project } from './types'

const EMOJI_OPTIONS = [
  '🚀', '🎨', '⚙️', '📦', '🌍', '🧠', '📊', '🎧',
  '📚', '📝', '🎬', '🛒', '🍅', '🛰️', '🧩', '💎',
  '🧪', '🔮', '🎯', '🌤️', '🗺️', '📷', '🎮', '🧱'
]

const props = defineProps<{
  visible: boolean
  project: Project | null
}>()

const emit = defineEmits<{
  (e: 'save', payload: { projectId: string; name: string; icon: string }): void
  (e: 'cancel'): void
}>()

const draftName = ref('')
const draftIcon = ref('')

watch(
  () => [props.visible, props.project?.id],
  () => {
    if (!props.visible || !props.project) return
    draftName.value = props.project.name || props.project.id
    draftIcon.value = typeof props.project.icon === 'string' ? props.project.icon : ''
  },
  { immediate: true }
)

const previewIcon = computed(() => {
  return getProjectIcon(props.project?.type, draftIcon.value)
})

function save () {
  if (!props.project) return
  emit('save', {
    projectId: props.project.id,
    name: draftName.value.trim() || props.project.id,
    icon: draftIcon.value.trim()
  })
}
</script>

<template>
  <Teleport to="body">
    <Transition name="appearance-pop">
      <div v-if="visible && project" class="appearance-overlay" @click.self="emit('cancel')">
        <div class="appearance-dialog">
          <div class="appearance-header">
            <div class="appearance-copy">
              <div class="appearance-kicker">应用外观</div>
              <h3>修改名称与图标</h3>
            </div>
            <button class="appearance-close" @click="emit('cancel')">✕</button>
          </div>

          <div class="appearance-preview">
            <div class="appearance-preview-icon">{{ previewIcon }}</div>
            <div class="appearance-preview-meta">
              <div class="appearance-preview-name">{{ draftName || project.id }}</div>
              <div class="appearance-preview-type">{{ project.type || '应用' }}</div>
            </div>
          </div>

          <label class="appearance-field">
            <span>应用名称</span>
            <input
              v-model="draftName"
              type="text"
              class="appearance-input"
              placeholder="输入应用名称"
              maxlength="60"
            />
          </label>

          <label class="appearance-field">
            <span>自定义 Emoji</span>
            <div class="appearance-icon-row">
              <input
                v-model="draftIcon"
                type="text"
                class="appearance-input appearance-input-icon"
                placeholder="留空则按类型自动选择"
                maxlength="8"
              />
              <button class="appearance-reset" @click="draftIcon = ''">恢复默认</button>
            </div>
          </label>

          <div class="appearance-emoji-grid">
            <button
              v-for="emoji in EMOJI_OPTIONS"
              :key="emoji"
              :class="['appearance-emoji-btn', { active: draftIcon === emoji }]"
              @click="draftIcon = emoji"
            >
              {{ emoji }}
            </button>
          </div>

          <div class="appearance-actions">
            <button class="appearance-btn appearance-btn-secondary" @click="emit('cancel')">取消</button>
            <button class="appearance-btn appearance-btn-primary" @click="save">保存</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.appearance-overlay {
  position: fixed;
  inset: 0;
  z-index: 11000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.3);
  backdrop-filter: blur(10px);
}

.appearance-dialog {
  width: min(560px, calc(100vw - 32px));
  background:
    radial-gradient(circle at top right, var(--app-accent-soft), transparent 30%),
    linear-gradient(180deg, var(--app-panel), var(--app-panel-strong));
  border: 1px solid var(--app-border-strong);
  border-radius: 24px;
  box-shadow: var(--app-shadow);
  padding: 24px;
  color: var(--app-text);
}

.appearance-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.appearance-kicker {
  font-size: 0.72em;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--app-accent);
  margin-bottom: 6px;
}

.appearance-header h3 {
  margin: 0;
  font-size: 1.2em;
}

.appearance-close {
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  cursor: pointer;
}

.appearance-close:hover {
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
}

.appearance-preview {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 22px;
  padding: 18px;
  border-radius: 20px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
}

.appearance-preview-icon {
  width: 76px;
  height: 76px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 22px;
  font-size: 2.3em;
  background: linear-gradient(135deg, var(--app-accent-soft), var(--app-panel-subtle));
  box-shadow: inset 0 1px 0 var(--app-border), 0 18px 36px rgba(15, 23, 42, 0.16);
}

.appearance-preview-name {
  font-size: 1.05em;
  font-weight: 600;
}

.appearance-preview-type {
  margin-top: 4px;
  font-size: 0.84em;
  color: var(--app-text-muted);
  text-transform: capitalize;
}

.appearance-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 18px;
}

.appearance-field span {
  font-size: 0.82em;
  color: var(--app-text-soft);
}

.appearance-input {
  width: 100%;
  box-sizing: border-box;
  height: 44px;
  border-radius: 14px;
  border: 1px solid var(--app-input-border);
  background: var(--app-input-bg);
  color: var(--app-text-strong);
  padding: 0 14px;
  outline: none;
}

.appearance-input:focus {
  border-color: var(--app-accent-glow);
  box-shadow: 0 0 0 1px var(--app-accent-soft);
}

.appearance-icon-row {
  display: flex;
  gap: 10px;
}

.appearance-input-icon {
  flex: 1;
}

.appearance-reset {
  flex-shrink: 0;
  height: 44px;
  padding: 0 14px;
  border-radius: 14px;
  border: 1px solid var(--app-input-border);
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  cursor: pointer;
}

.appearance-reset:hover {
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
}

.appearance-emoji-grid {
  margin-top: 16px;
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 10px;
}

.appearance-emoji-btn {
  height: 48px;
  border-radius: 16px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  font-size: 1.35em;
  cursor: pointer;
  transition: transform 0.14s ease, border-color 0.14s ease, background 0.14s ease;
}

.appearance-emoji-btn:hover {
  transform: translateY(-2px);
  border-color: var(--app-accent-glow);
  background: var(--app-accent-soft);
}

.appearance-emoji-btn.active {
  background: var(--app-accent-soft);
  border-color: var(--app-accent-glow);
}

.appearance-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
}

.appearance-btn {
  height: 42px;
  padding: 0 16px;
  border-radius: 14px;
  border: 1px solid var(--app-border-strong);
  cursor: pointer;
  font-weight: 600;
}

.appearance-btn-secondary {
  background: var(--app-panel-muted);
  color: var(--app-text);
}

.appearance-btn-primary {
  background: linear-gradient(135deg, var(--app-accent), var(--app-accent-strong));
  color: #ffffff;
  border-color: transparent;
}

.appearance-pop-enter-active,
.appearance-pop-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.appearance-pop-enter-from,
.appearance-pop-leave-to {
  opacity: 0;
}

.appearance-pop-enter-from .appearance-dialog,
.appearance-pop-leave-to .appearance-dialog {
  transform: translateY(8px) scale(0.98);
}
</style>