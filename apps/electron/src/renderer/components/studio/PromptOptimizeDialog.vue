<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

interface TextModelOption {
  providerId: string
  providerName: string
  model: string
  value: string
  label: string
}

const props = defineProps<{
  visible: boolean
  originalPrompt: string
  isNegative: boolean
  modelOptions: TextModelOption[]
  defaultModelValue: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'apply', optimizedPrompt: string): void
}>()

const optimizing = ref(false)
const errorMsg = ref('')
const optimizedPrompt = ref('')
const editablePrompt = ref('')
const selectedValue = ref('')
const { t } = useI18n()

const selectedOption = computed(() => {
  return props.modelOptions.find(option => option.value === selectedValue.value) ?? null
})

async function doOptimize () {
  if (!window.electronAPI?.optimizeImagePrompt) {
    errorMsg.value = t('studioUi.optimizeUnsupported')
    return
  }
  if (!props.originalPrompt.trim()) {
    errorMsg.value = t('studioUi.enterPromptFirst')
    return
  }
  if (!selectedOption.value) {
    errorMsg.value = t('studioUi.noTextModel')
    return
  }

  optimizing.value = true
  errorMsg.value = ''
  optimizedPrompt.value = ''
  editablePrompt.value = ''

  try {
    const result = await window.electronAPI.optimizeImagePrompt({
      providerId: selectedOption.value.providerId,
      model: selectedOption.value.model,
      prompt: props.originalPrompt.trim(),
      isNegative: props.isNegative
    })

    if (result.ok && result.optimizedPrompt) {
      optimizedPrompt.value = result.optimizedPrompt
      editablePrompt.value = result.optimizedPrompt
    } else {
      errorMsg.value = result.error || t('studioUi.optimizeFailed')
    }
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : t('studioUi.promptOptimizeFailed')
  } finally {
    optimizing.value = false
  }
}

function applyPrompt () {
  emit('apply', editablePrompt.value.trim())
  emit('close')
}

function onOpen () {
  optimizedPrompt.value = ''
  editablePrompt.value = ''
  errorMsg.value = ''
  selectedValue.value = props.defaultModelValue
  if (!selectedValue.value) {
    errorMsg.value = t('studioUi.noTextModel')
    return
  }
  doOptimize()
}

// Auto-optimize when dialog opens
defineExpose({ onOpen })
</script>

<template>
  <Teleport to="body">
    <div v-if="props.visible" class="opt-overlay" @click.self="emit('close')">
      <div class="opt-dialog">
        <header class="opt-header">
          <h3>✨ {{ $t('studioUi.aiPromptOptimize') }}</h3>
          <span class="opt-type-badge">{{ isNegative ? $t('studioUi.negativePrompt') : $t('studioUi.positivePrompt') }}</span>
          <button class="opt-close" type="button" @click="emit('close')" :title="$t('common.close')">✕</button>
        </header>

        <div class="opt-body">
          <div class="opt-section">
            <span class="opt-label">{{ $t('studioUi.optimizeModel') }}</span>
            <select v-model="selectedValue" class="opt-select" :disabled="optimizing || props.modelOptions.length === 0">
              <option v-for="option in props.modelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <span class="opt-hint">{{ $t('studioUi.optimizeModelHint') }}</span>
          </div>

          <div class="opt-section">
            <span class="opt-label">{{ $t('studioUi.originalPrompt') }}</span>
            <p class="opt-original">{{ props.originalPrompt || $t('studioUi.emptyValue') }}</p>
          </div>

          <div v-if="optimizing" class="opt-loading">
            <span class="opt-spinner">⏳</span>
            <p>{{ $t('studioUi.optimizingPrompt') }}</p>
          </div>

          <div v-else-if="errorMsg" class="opt-error">
            <p>{{ errorMsg }}</p>
            <button class="opt-btn" type="button" @click="doOptimize">{{ $t('common.retry') }}</button>
          </div>

          <div v-else-if="optimizedPrompt" class="opt-section">
            <span class="opt-label">{{ $t('studioUi.optimizedPrompt') }} <span class="opt-hint">{{ $t('studioUi.editableApplyHint') }}</span></span>
            <textarea
              v-model="editablePrompt"
              class="opt-textarea"
              rows="6"
              :placeholder="$t('studioUi.optimizedPromptPlaceholder')"
            ></textarea>
          </div>
        </div>

        <footer class="opt-footer">
          <button class="opt-btn" type="button" @click="emit('close')">{{ $t('common.cancel') }}</button>
          <button class="opt-btn opt-btn-retry" type="button" :disabled="optimizing || !props.originalPrompt.trim()" @click="doOptimize">
            ↻ {{ $t('studioUi.optimizeWithSelectedModel') }}
          </button>
          <button
            class="opt-btn opt-btn-primary"
            type="button"
            :disabled="!editablePrompt.trim()"
            @click="applyPrompt"
          >
            ✓ {{ $t('studioUi.applyToPrompt') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.opt-overlay {
  position: fixed;
  inset: 0;
  z-index: 10300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  padding: 24px;
}

.opt-dialog {
  width: min(580px, 94vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-strong);
  box-shadow: var(--app-shadow);
  overflow: hidden;
}

.opt-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--app-border);
}

.opt-header h3 {
  margin: 0;
  font-size: 1rem;
  color: var(--app-text-strong);
  flex: 1;
}

.opt-type-badge {
  font-size: 0.72em;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
}

.opt-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  cursor: pointer;
  font-size: 0.9em;
}
.opt-close:hover { background: var(--app-accent-soft); color: var(--app-text-strong); }

.opt-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.opt-section { display: flex; flex-direction: column; gap: 6px; }
.opt-label { font-size: 0.82em; font-weight: 600; color: var(--app-text-soft); }
.opt-hint { font-weight: 400; color: var(--app-text-faint); font-size: 0.9em; }

.opt-original {
  margin: 0;
  padding: 10px 12px;
  border-radius: 9px;
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  font-size: 0.86em;
  white-space: pre-wrap;
  word-break: break-word;
}

.opt-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  font-size: 0.86em;
  font-family: inherit;
  resize: vertical;
}

.opt-textarea:focus {
  outline: none;
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px var(--app-accent-glow);
}

.opt-select {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  font-size: 0.86em;
}

.opt-select:focus {
  outline: none;
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px var(--app-accent-glow);
}

.opt-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 30px;
  color: var(--app-text-muted);
}
.opt-loading p { margin: 0; font-size: 0.86em; }
.opt-spinner { display: inline-block; animation: opt-spin 1.2s linear infinite; font-size: 1.4em; }
@keyframes opt-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

.opt-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 20px;
  border-radius: 10px;
  background: rgba(220, 38, 38, 0.08);
  border: 1px solid rgba(220, 38, 38, 0.25);
}
.opt-error p { margin: 0; color: var(--app-danger); font-size: 0.86em; }

.opt-footer {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding: 14px 20px;
  border-top: 1px solid var(--app-border);
}

.opt-btn {
  padding: 8px 16px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  font-size: 0.84em;
  cursor: pointer;
  transition: all 0.12s ease;
}

.opt-btn:hover:not(:disabled) { background: var(--app-accent-soft); color: var(--app-text-strong); }
.opt-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.opt-btn-retry { border-color: var(--app-accent-glow); }

.opt-btn-primary {
  background: var(--app-accent);
  border-color: var(--app-accent);
  color: #fff;
}
.opt-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
</style>
