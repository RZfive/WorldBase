<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import 'emoji-picker-element'
import { resolveProjectIcon } from '../../utils/project-icon'
import type { Project } from './types'

type EmojiClickEvent = CustomEvent<{
  unicode?: string
}>

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
const emojiPickerHost = ref<HTMLElement | null>(null)
const { t, locale } = useI18n()
let emojiPickerEl: HTMLElement | null = null

watch(
  () => [props.visible, props.project?.id],
  async () => {
    if (!props.visible || !props.project) {
      unmountEmojiPicker()
      return
    }

    draftName.value = props.project.name || props.project.id
    draftIcon.value = typeof props.project.icon === 'string' ? props.project.icon : ''

    await nextTick()
    mountEmojiPicker()
  },
  { immediate: true }
)

const previewIcon = computed(() => {
  return resolveProjectIcon(props.project?.type, draftIcon.value)
})

function handleEmojiClick (event: Event) {
  const emoji = (event as EmojiClickEvent).detail?.unicode?.trim()
  if (!emoji) return
  draftIcon.value = emoji
}

function mountEmojiPicker () {
  if (!emojiPickerHost.value || emojiPickerEl?.isConnected) return

  const picker = document.createElement('emoji-picker') as HTMLElement
  picker.className = 'appearance-emoji-picker'
  picker.setAttribute('locale', locale.value === 'zh-CN' ? 'zh-Hans' : 'en')
  picker.setAttribute('preview-position', 'none')
  picker.addEventListener('emoji-click', handleEmojiClick as EventListener)

  emojiPickerHost.value.replaceChildren(picker)
  emojiPickerEl = picker
}

function unmountEmojiPicker () {
  if (!emojiPickerEl) return
  emojiPickerEl.removeEventListener('emoji-click', handleEmojiClick as EventListener)
  emojiPickerEl.remove()
  emojiPickerEl = null
}

onBeforeUnmount(() => {
  unmountEmojiPicker()
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
              <div class="appearance-kicker">{{ $t('launchpad.appAppearance') }}</div>
              <h3>{{ $t('launchpad.editNameIcon') }}</h3>
            </div>
            <button class="appearance-close" @click="emit('cancel')" :title="$t('common.close')">✕</button>
          </div>

          <div class="appearance-preview">
            <div class="appearance-preview-icon">
              <img v-if="previewIcon.kind === 'image'" :src="previewIcon.value" alt="" class="appearance-preview-image" />
              <span v-else>{{ previewIcon.value }}</span>
            </div>
            <div class="appearance-preview-meta">
              <div class="appearance-preview-name">{{ draftName || project.id }}</div>
              <div class="appearance-preview-type">{{ project.type || $t('launchpad.app') }}</div>
            </div>
          </div>

          <label class="appearance-field">
            <span>{{ $t('launchpad.appName') }}</span>
            <input
              v-model="draftName"
              type="text"
              class="appearance-input"
              :placeholder="$t('launchpad.appNamePlaceholder')"
              maxlength="60"
            />
          </label>

          <label class="appearance-field">
            <span>{{ $t('launchpad.icon') }}</span>
            <div class="appearance-icon-row">
              <input
                v-model="draftIcon"
                type="text"
                class="appearance-input appearance-input-icon"
                :placeholder="$t('launchpad.iconPlaceholder')"
              />
              <button class="appearance-reset" type="button" @click="draftIcon = ''">{{ $t('launchpad.restoreDefault') }}</button>
            </div>
            <div class="appearance-hint">{{ $t('launchpad.iconHint') }}</div>
          </label>

          <div class="appearance-picker-shell">
            <div ref="emojiPickerHost" class="appearance-picker-host"></div>
          </div>

          <div class="appearance-actions">
            <button class="appearance-btn appearance-btn-secondary" type="button" @click="emit('cancel')">{{ $t('common.cancel') }}</button>
            <button class="appearance-btn appearance-btn-primary" type="button" @click="save">{{ $t('launchpad.save') }}</button>
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
  width: min(680px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  background:
    radial-gradient(circle at top right, var(--app-accent-soft), transparent 30%),
    linear-gradient(180deg, var(--app-panel), var(--app-panel-strong));
  border: 1px solid var(--app-border-strong);
  border-radius: 24px;
  box-shadow: var(--app-shadow);
  padding: 24px;
  color: var(--app-text);
  overflow-y: auto;
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

.appearance-preview-image {
  width: 58px;
  height: 58px;
  object-fit: contain;
  border-radius: 16px;
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

.appearance-hint {
  margin-top: 16px;
  font-size: 0.78em;
  color: var(--app-text-muted);
}

.appearance-picker-shell {
  margin-top: 18px;
  border-radius: 18px;
  border: 1px solid var(--app-border);
  background: linear-gradient(180deg, var(--app-panel-subtle), var(--app-panel-muted));
  padding: 10px;
}

.appearance-picker-host {
  min-height: 380px;
}

.appearance-picker-host :deep(.appearance-emoji-picker) {
  width: 100%;
  height: 380px;
  --background: transparent;
  --border-color: transparent;
  --border-radius: 14px;
  --button-hover-background: var(--app-accent-soft);
  --category-button-color: var(--app-text-soft);
  --category-button-active-color: var(--app-text-strong);
  --indicator-color: var(--app-accent);
  --input-border-color: var(--app-input-border);
  --input-font-color: var(--app-text-strong);
  --input-background-color: var(--app-input-bg);
  --outline-color: var(--app-accent-glow);
  --shadow: none;
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
