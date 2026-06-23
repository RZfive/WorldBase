<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

interface ProviderItem {
  id: string
  name: string
  models: string[]
}

const props = withDefaults(defineProps<{
  providers: ProviderItem[]
  activeProviderId?: string
  selectedModel?: string
  title?: string
  disabled?: boolean
}>(), {
  title: '',
  disabled: false
})

const emit = defineEmits<{
  (e: 'update:active-provider-id', id: string): void
  (e: 'update:selected-model', model: string): void
}>()

const { t } = useI18n()

const triggerRef = ref<HTMLButtonElement | null>(null)
const open = ref(false)
const expandedProviderId = ref('')

const resolvedSelectedProvider = computed(() => {
  if (props.activeProviderId) {
    const exactProvider = props.providers.find(provider => provider.id === props.activeProviderId)
    if (exactProvider) {
      return exactProvider
    }
  }

  if (props.selectedModel) {
    return props.providers.find(provider => provider.models.includes(props.selectedModel || '')) || null
  }

  return null
})

const currentExpandedProvider = computed(() => {
  return props.providers.find(provider => provider.id === expandedProviderId.value)
    || resolvedSelectedProvider.value
    || props.providers[0]
    || null
})

const combinedLabel = computed(() => {
  if (props.selectedModel && resolvedSelectedProvider.value?.name) {
    return `${props.selectedModel} / ${resolvedSelectedProvider.value.name}`
  }
  if (props.selectedModel) {
    return props.selectedModel
  }
  if (resolvedSelectedProvider.value?.name) {
    return resolvedSelectedProvider.value.name
  }
  return props.title || t('chatUi.providerModelTitle')
})

const triggerTitle = computed(() => {
  if (props.selectedModel && resolvedSelectedProvider.value?.name) {
    return `${props.selectedModel}\n${resolvedSelectedProvider.value.name}`
  }
  return combinedLabel.value
})

const panelStyle = computed(() => {
  if (!open.value || !triggerRef.value) {
    return { display: 'none' }
  }

  const rect = triggerRef.value.getBoundingClientRect()
  const viewportPadding = 12
  const preferredWidth = Math.min(460, Math.max(380, window.innerWidth - viewportPadding * 2))
  const maxLeft = Math.max(viewportPadding, window.innerWidth - preferredWidth - viewportPadding)
  const left = Math.min(Math.max(viewportPadding, rect.left), maxLeft)
  const spaceBelow = window.innerHeight - rect.bottom - viewportPadding
  const spaceAbove = rect.top - viewportPadding
  const preferredHeight = 320
  const minHeight = 180
  const estimatedHeight = preferredHeight
  const placeAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow
  const availableHeight = Math.max(120, placeAbove ? spaceAbove : spaceBelow)
  const resolvedHeight = availableHeight >= minHeight
    ? Math.min(preferredHeight, availableHeight)
    : availableHeight

  return {
    position: 'fixed' as const,
    left: `${left}px`,
    width: `${preferredWidth}px`,
    height: `${resolvedHeight}px`,
    ...(placeAbove
      ? { bottom: `${window.innerHeight - rect.top + 6}px` }
      : { top: `${rect.bottom + 6}px` })
  }
})

watch([
  () => props.activeProviderId,
  () => props.selectedModel,
  () => props.providers
], () => {
  if (!open.value) {
    expandedProviderId.value = resolvedSelectedProvider.value?.id || props.providers[0]?.id || ''
  }
}, { deep: true, immediate: true })

function toggleOpen () {
  if (props.disabled || props.providers.length === 0) {
    return
  }

  open.value = !open.value
  if (open.value) {
    expandedProviderId.value = resolvedSelectedProvider.value?.id || props.providers[0]?.id || ''
    nextTick(() => {
      scrollCurrentIntoView()
    })
  }
}

function expandProvider (providerId: string) {
  expandedProviderId.value = providerId
}

function handleProviderClick (provider: ProviderItem) {
  expandedProviderId.value = provider.id

  if (provider.models.length === 0) {
    emit('update:active-provider-id', provider.id)
    emit('update:selected-model', '')
    open.value = false
  }
}

function selectModel (providerId: string, model: string) {
  emit('update:active-provider-id', providerId)
  emit('update:selected-model', model)
  open.value = false
}

function handlePanelKeydown (e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    open.value = false
    triggerRef.value?.focus()
  }
}

function scrollCurrentIntoView () {
  const selectedProvider = document.querySelector('.provider-model-provider.selected') as HTMLElement | null
  const selectedModel = document.querySelector('.provider-model-item.selected') as HTMLElement | null
  selectedProvider?.scrollIntoView({ block: 'nearest' })
  selectedModel?.scrollIntoView({ block: 'nearest' })
}

function onDocumentClick (e: MouseEvent) {
  if (!open.value) {
    return
  }

  const target = e.target as HTMLElement
  if (triggerRef.value?.contains(target)) {
    return
  }
  if (target.closest('.provider-model-panel')) {
    return
  }

  open.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick, true)
})
</script>

<template>
  <button
    ref="triggerRef"
    class="provider-model-trigger"
    :class="{ open, disabled }"
    type="button"
    :disabled="disabled || providers.length === 0"
    :title="triggerTitle"
    @click="toggleOpen"
  >
    <span class="provider-model-value" :title="triggerTitle">{{ combinedLabel }}</span>
    <svg class="provider-model-caret" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      class="provider-model-panel"
      :style="panelStyle"
      @click.stop
      @keydown="handlePanelKeydown"
    >
      <div class="provider-model-providers-column">
        <button
          v-for="provider in providers"
          :key="provider.id"
          class="provider-model-provider"
          :class="{ selected: provider.id === resolvedSelectedProvider?.id, active: provider.id === currentExpandedProvider?.id }"
          type="button"
          :title="provider.name"
          @click="handleProviderClick(provider)"
          @mouseenter="expandProvider(provider.id)"
          @focus="expandProvider(provider.id)"
        >
          <span class="provider-model-provider-name">{{ provider.name }}</span>
          <svg class="provider-model-provider-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <div class="provider-model-models-column">
        <div class="provider-model-models-heading" :title="currentExpandedProvider?.name || props.title">
          {{ currentExpandedProvider?.name || props.title }}
        </div>

        <div v-if="currentExpandedProvider && currentExpandedProvider.models.length > 0" class="provider-model-list">
          <button
            v-for="model in currentExpandedProvider.models"
            :key="model"
            class="provider-model-item"
            :class="{ selected: currentExpandedProvider.id === activeProviderId && model === selectedModel }"
            type="button"
            :title="`${model} · ${currentExpandedProvider.name}`"
            @click="selectModel(currentExpandedProvider.id, model)"
          >
            <span class="provider-model-item-label">{{ model }}</span>
            <svg v-if="currentExpandedProvider.id === activeProviderId && model === selectedModel" class="provider-model-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </button>
        </div>

        <div v-else class="provider-model-empty">{{ $t('chatUi.noAvailableModels') }}</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.provider-model-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  max-width: 220px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--app-input-border);
  background: var(--app-input-bg);
  color: var(--app-text);
  font-size: 0.76em;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}

.provider-model-trigger:hover:not(:disabled) {
  border-color: var(--app-accent);
}

.provider-model-trigger:focus {
  outline: none;
  border-color: var(--app-accent);
  box-shadow: 0 0 0 1px var(--app-accent-soft);
}

.provider-model-trigger.open {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 1px var(--app-accent-soft);
}

.provider-model-trigger.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.provider-model-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-model-caret {
  flex-shrink: 0;
  opacity: 0.6;
  transition: transform 0.18s ease;
}

.provider-model-trigger.open .provider-model-caret {
  transform: rotate(180deg);
}

.provider-model-panel {
  z-index: 10000;
  display: grid;
  grid-template-columns: minmax(150px, 170px) minmax(210px, 1fr);
  gap: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--app-border-strong);
  border-radius: 12px;
  background: var(--app-panel-strong);
  box-shadow: var(--app-shadow);
  backdrop-filter: blur(20px);
}

.provider-model-providers-column,
.provider-model-models-column {
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.provider-model-providers-column::-webkit-scrollbar,
.provider-model-models-column::-webkit-scrollbar,
.provider-model-list::-webkit-scrollbar {
  width: 5px;
}

.provider-model-providers-column::-webkit-scrollbar-track,
.provider-model-models-column::-webkit-scrollbar-track,
.provider-model-list::-webkit-scrollbar-track {
  background: transparent;
}

.provider-model-providers-column::-webkit-scrollbar-thumb,
.provider-model-models-column::-webkit-scrollbar-thumb,
.provider-model-list::-webkit-scrollbar-thumb {
  background: var(--app-scrollbar);
  border-radius: 3px;
}

.provider-model-providers-column {
  min-height: 0;
  padding: 6px;
  border-right: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel-muted) 65%, transparent);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.provider-model-models-column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 6px;
  overflow: hidden;
}

.provider-model-provider,
.provider-model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text);
  cursor: pointer;
  text-align: left;
}

.provider-model-provider {
  padding: 8px 10px;
}

.provider-model-provider:hover,
.provider-model-provider.active {
  background: var(--app-accent-soft);
}

.provider-model-provider.selected .provider-model-provider-name {
  color: var(--app-accent-strong);
}

.provider-model-provider-name,
.provider-model-models-heading,
.provider-model-item-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-model-provider-name {
  font-size: 0.8rem;
}

.provider-model-provider-caret {
  flex-shrink: 0;
  opacity: 0.55;
}

.provider-model-models-heading {
  padding: 8px 10px 10px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--app-text-muted);
}

.provider-model-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.provider-model-item {
  padding: 8px 10px;
}

.provider-model-item:hover,
.provider-model-item.selected {
  background: color-mix(in srgb, var(--app-accent-soft) 88%, transparent);
}

.provider-model-item.selected .provider-model-item-label {
  color: var(--app-accent-strong);
  font-weight: 600;
}

.provider-model-item-label {
  font-size: 0.8rem;
}

.provider-model-check {
  flex-shrink: 0;
  color: var(--app-accent);
}

.provider-model-empty {
  padding: 8px 10px;
  font-size: 0.74rem;
  color: var(--app-text-muted);
}
</style>
