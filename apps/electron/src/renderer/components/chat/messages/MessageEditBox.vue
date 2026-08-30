<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  initialText: string
  hasImages: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'submit', text: string, mode: 'fork' | 'inplace'): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()
const text = ref(props.initialText)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const canSubmit = computed(() => text.value.trim().length > 0 && !props.busy)

onMounted(async () => {
  await nextTick()
  const textarea = textareaRef.value
  if (!textarea) return
  textarea.focus()
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
})

function submit (mode: 'fork' | 'inplace'): void {
  if (!canSubmit.value) return
  emit('submit', text.value, mode)
}

function onKeyDown (event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('cancel')
    return
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    submit('fork')
  }
}
</script>

<template>
  <div class="message-edit-box">
    <textarea
      ref="textareaRef"
      v-model="text"
      class="message-edit-textarea"
      rows="4"
      :disabled="props.busy"
      @keydown="onKeyDown"
    />
    <div v-if="props.hasImages" class="message-edit-hint">{{ $t('chatUi.editImagesKeptHint') }}</div>
    <div class="message-edit-actions">
      <button
        class="message-edit-btn primary"
        type="button"
        :disabled="!canSubmit"
        @click="submit('fork')"
      >
        {{ $t('chatUi.editResendFork') }}
      </button>
      <button
        class="message-edit-btn"
        type="button"
        :disabled="!canSubmit"
        @click="submit('inplace')"
      >
        {{ $t('chatUi.editResendInPlace') }}
      </button>
      <button
        class="message-edit-btn ghost"
        type="button"
        :disabled="props.busy"
        @click="emit('cancel')"
      >
        {{ $t('chatUi.editCancel') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.message-edit-box {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--app-accent);
  border-radius: 14px;
  background: var(--app-input-bg);
}

.message-edit-textarea {
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
  min-height: 88px;
  max-height: 320px;
  padding: 8px 10px;
  border: 1px solid var(--app-input-border);
  border-radius: 10px;
  background: var(--app-panel);
  color: var(--app-text);
  font-family: var(--chat-font-family);
  font-size: var(--chat-font-size);
  line-height: 1.5;
  outline: none;
}

.message-edit-textarea:focus {
  border-color: var(--app-accent);
}

.message-edit-hint {
  font-size: 0.75rem;
  color: var(--app-text-muted);
}

.message-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.message-edit-btn {
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--app-border);
  background: transparent;
  color: var(--app-text);
  font-size: 0.8rem;
  cursor: pointer;
}

.message-edit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.message-edit-btn.primary {
  border-color: var(--app-accent);
  background: var(--app-accent-soft, var(--app-accent));
  color: var(--app-text-strong);
  font-weight: 700;
}

.message-edit-btn.ghost {
  color: var(--app-text-muted);
}
</style>
