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
  background: rgba(2, 6, 12, 0.58);
  backdrop-filter: blur(10px);
}

.appearance-dialog {
  width: min(560px, calc(100vw - 32px));
  background:
    radial-gradient(circle at top right, rgba(56, 189, 248, 0.14), transparent 30%),
    linear-gradient(180deg, rgba(11, 17, 25, 0.98), rgba(7, 11, 18, 0.96));
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 24px;
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.45);
  padding: 24px;
  color: #e4e4e7;
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
  color: #7dd3fc;
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
  background: rgba(255, 255, 255, 0.06);
  color: #cbd5e1;
  cursor: pointer;
}

.appearance-close:hover {
  background: rgba(255, 255, 255, 0.1);
}

.appearance-preview {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 22px;
  padding: 18px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(148, 163, 184, 0.12);
}

.appearance-preview-icon {
  width: 76px;
  height: 76px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 22px;
  font-size: 2.3em;
  background: linear-gradient(135deg, rgba(56, 189, 248, 0.24), rgba(255, 255, 255, 0.06));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 18px 36px rgba(0, 0, 0, 0.24);
}

.appearance-preview-name {
  font-size: 1.05em;
  font-weight: 600;
}

.appearance-preview-type {
  margin-top: 4px;
  font-size: 0.84em;
  color: #94a3b8;
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
  color: #cbd5e1;
}

.appearance-input {
  width: 100%;
  box-sizing: border-box;
  height: 44px;
  border-radius: 14px;
  border: 1px solid rgba(148, 163, 184, 0.14);
  background: rgba(255, 255, 255, 0.04);
  color: #f8fafc;
  padding: 0 14px;
  outline: none;
}

.appearance-input:focus {
  border-color: rgba(56, 189, 248, 0.42);
  box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.18);
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
  border: 1px solid rgba(148, 163, 184, 0.14);
  background: rgba(255, 255, 255, 0.04);
  color: #cbd5e1;
  cursor: pointer;
}

.appearance-reset:hover {
  background: rgba(255, 255, 255, 0.08);
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
  border: 1px solid rgba(148, 163, 184, 0.12);
  background: rgba(255, 255, 255, 0.04);
  font-size: 1.35em;
  cursor: pointer;
  transition: transform 0.14s ease, border-color 0.14s ease, background 0.14s ease;
}

.appearance-emoji-btn:hover {
  transform: translateY(-2px);
  border-color: rgba(56, 189, 248, 0.28);
  background: rgba(255, 255, 255, 0.08);
}

.appearance-emoji-btn.active {
  background: rgba(56, 189, 248, 0.16);
  border-color: rgba(56, 189, 248, 0.38);
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
  border: 1px solid rgba(148, 163, 184, 0.14);
  cursor: pointer;
  font-weight: 600;
}

.appearance-btn-secondary {
  background: rgba(255, 255, 255, 0.04);
  color: #e2e8f0;
}

.appearance-btn-primary {
  background: linear-gradient(135deg, #38bdf8, #0ea5e9);
  color: #082f49;
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