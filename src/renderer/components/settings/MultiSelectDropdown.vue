<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

interface MultiSelectOption {
  value: string
  label: string
  description?: string
}

const props = withDefaults(defineProps<{
  modelValue: string[]
  options: MultiSelectOption[]
  label: string
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
}>(), {
  placeholder: '请选择',
  searchPlaceholder: '搜索',
  emptyText: '暂无可选项',
  disabled: false
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[]): void
}>()

const query = ref('')
const open = ref(false)
const activeIndex = ref(0)
const triggerRef = ref<HTMLButtonElement | null>(null)
const panelRef = ref<HTMLDivElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)

const selectedValues = computed(() => new Set(props.modelValue))
const filteredOptions = computed(() => {
  const normalizedQuery = query.value.trim().toLowerCase()
  if (!normalizedQuery) return props.options
  return props.options.filter(option => {
    return option.label.toLowerCase().includes(normalizedQuery)
      || option.value.toLowerCase().includes(normalizedQuery)
      || option.description?.toLowerCase().includes(normalizedQuery)
  })
})
const summaryText = computed(() => {
  if (props.modelValue.length === 0) return props.placeholder
  const selectedLabels = props.options
    .filter(option => selectedValues.value.has(option.value))
    .map(option => option.label)

  if (selectedLabels.length === 0) return props.placeholder
  if (selectedLabels.length <= 2) return selectedLabels.join('、')
  return `${selectedLabels.slice(0, 2).join('、')} 等 ${selectedLabels.length} 项`
})
const panelStyle = computed(() => {
  if (!open.value || !triggerRef.value) return { display: 'none' }

  const rect = triggerRef.value.getBoundingClientRect()
  const viewportPadding = 12
  const availableWidth = window.innerWidth - viewportPadding * 2
  const minWidth = 280
  const preferredWidth = Math.max(rect.width, 300)
  const maxWidth = Math.max(minWidth, Math.min(420, availableWidth))
  const width = Math.min(preferredWidth, maxWidth)
  const maxLeft = Math.max(viewportPadding, window.innerWidth - width - viewportPadding)
  const left = Math.min(Math.max(viewportPadding, rect.left), maxLeft)
  const spaceBelow = window.innerHeight - rect.bottom - viewportPadding
  const spaceAbove = rect.top - viewportPadding
  const preferredHeight = 360
  const minHeight = 220
  const minAvailableHeight = 180
  const placeAbove = spaceBelow < preferredHeight && spaceAbove > spaceBelow
  const availableHeight = Math.max(minAvailableHeight, placeAbove ? spaceAbove : spaceBelow)
  const maxHeight = availableHeight >= minHeight
    ? Math.min(preferredHeight, availableHeight)
    : availableHeight

  return {
    position: 'fixed' as const,
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
    ...(placeAbove
      ? { bottom: `${window.innerHeight - rect.top + 8}px` }
      : { top: `${rect.bottom + 8}px` })
  }
})

watch(() => filteredOptions.value.length, (length) => {
  if (length === 0) {
    activeIndex.value = 0
    return
  }
  if (activeIndex.value >= length) {
    activeIndex.value = length - 1
  }
})

function updateValues (nextValues: string[]): void {
  emit('update:modelValue', Array.from(new Set(nextValues)))
}

function toggleOption (value: string): void {
  if (props.disabled) return
  if (selectedValues.value.has(value)) {
    updateValues(props.modelValue.filter(item => item !== value))
    return
  }
  updateValues([...props.modelValue, value])
}

function selectAll (): void {
  if (props.disabled) return
  updateValues(props.options.map(option => option.value))
}

function clearAll (): void {
  if (props.disabled) return
  updateValues([])
}

function syncActiveIndex (): void {
  const currentIndex = filteredOptions.value.findIndex(option => selectedValues.value.has(option.value))
  activeIndex.value = currentIndex >= 0 ? currentIndex : 0
}

function scrollActiveIntoView (): void {
  const activeElement = panelRef.value?.querySelector('.multi-select-option.active') as HTMLElement | null
  activeElement?.scrollIntoView({ block: 'nearest' })
}

function closePanel (): void {
  open.value = false
}

function handleViewportChange (): void {
  closePanel()
}

function toggleOpen (): void {
  if (props.disabled) return

  open.value = !open.value
  if (!open.value) return

  syncActiveIndex()
  nextTick(() => {
    searchRef.value?.focus()
    scrollActiveIntoView()
  })
}

function handlePanelKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closePanel()
    triggerRef.value?.focus()
    return
  }

  if (filteredOptions.value.length === 0) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % filteredOptions.value.length
    nextTick(scrollActiveIntoView)
    return
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + filteredOptions.value.length) % filteredOptions.value.length
    nextTick(scrollActiveIntoView)
    return
  }

  if (event.key === 'Enter' || event.key === ' ') {
    const option = filteredOptions.value[activeIndex.value]
    if (!option) return
    event.preventDefault()
    toggleOption(option.value)
  }
}

function onDocumentClick (event: MouseEvent): void {
  if (!open.value) return

  const target = event.target as HTMLElement
  if (triggerRef.value?.contains(target)) return
  if (panelRef.value?.contains(target)) return

  closePanel()
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true)
  document.addEventListener('scroll', handleViewportChange, true)
  window.addEventListener('resize', handleViewportChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick, true)
  document.removeEventListener('scroll', handleViewportChange, true)
  window.removeEventListener('resize', handleViewportChange)
})
</script>

<template>
  <div class="multi-select-root" :class="{ disabled: props.disabled }">
    <span class="multi-select-label">{{ props.label }}</span>
    <button
      ref="triggerRef"
      class="multi-select-trigger"
      :class="{ open }"
      type="button"
      :disabled="props.disabled"
      @click="toggleOpen"
    >
      <span class="multi-select-summary-text">{{ summaryText }}</span>
      <span class="multi-select-trigger-meta">
        <span class="multi-select-summary-count">{{ props.modelValue.length }}</span>
        <svg class="multi-select-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        class="multi-select-panel"
        :style="panelStyle"
        @click.stop
        @keydown="handlePanelKeydown"
      >
        <div class="multi-select-panel-head">
          <input
            ref="searchRef"
            v-model="query"
            class="multi-select-search"
            :placeholder="props.searchPlaceholder"
          >
          <div class="multi-select-actions">
            <button type="button" class="multi-select-action" @click.prevent="selectAll">全选</button>
            <button type="button" class="multi-select-action" @click.prevent="clearAll">清空</button>
          </div>
        </div>

        <div class="multi-select-panel-summary">
          <span>{{ props.modelValue.length }} 项已选</span>
          <span>{{ filteredOptions.length }} 项可见</span>
        </div>

        <div v-if="filteredOptions.length > 0" class="multi-select-options">
          <label
            v-for="(option, idx) in filteredOptions"
            :key="option.value"
            class="multi-select-option"
            :class="{ selected: selectedValues.has(option.value), active: idx === activeIndex }"
            @mouseenter="activeIndex = idx"
          >
            <input
              :checked="selectedValues.has(option.value)"
              type="checkbox"
              @change="toggleOption(option.value)"
            >
            <div class="multi-select-option-copy">
              <span class="multi-select-option-label">{{ option.label }}</span>
              <span v-if="option.description" class="multi-select-option-description">{{ option.description }}</span>
            </div>
          </label>
        </div>

        <div v-else class="multi-select-empty">{{ props.emptyText }}</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.multi-select-root {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.multi-select-root.disabled {
  opacity: 0.7;
}

.multi-select-label {
  color: var(--app-text-soft);
  font-size: 0.88rem;
}

.multi-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  border: 1px solid var(--app-input-border);
  border-radius: 12px;
  background: var(--app-input-bg);
  color: var(--app-text);
  cursor: pointer;
  padding: 10px 12px;
  text-align: left;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}

.multi-select-trigger:hover:not(:disabled),
.multi-select-trigger.open {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 1px var(--app-accent-soft);
}

.multi-select-trigger:focus {
  outline: none;
  border-color: var(--app-accent);
  box-shadow: 0 0 0 1px var(--app-accent-soft);
}

.multi-select-trigger:disabled {
  cursor: not-allowed;
}

.multi-select-trigger-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.multi-select-summary-text {
  min-width: 0;
  color: var(--app-text);
  font-size: 0.88rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.multi-select-summary-count {
  flex-shrink: 0;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.76rem;
}

.multi-select-caret {
  opacity: 0.6;
  transition: transform 0.18s ease;
}

.multi-select-trigger.open .multi-select-caret {
  transform: rotate(180deg);
}

.multi-select-panel {
  z-index: var(--multi-select-panel-z-index, 10000);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--app-border-strong);
  border-radius: 16px;
  background-color: var(--app-panel-strong);
  background: color-mix(in srgb, var(--app-panel-strong) 92%, transparent);
  backdrop-filter: blur(20px);
  box-shadow: var(--app-shadow);
}

.multi-select-panel-head {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel-muted) 64%, transparent);
}

.multi-select-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.multi-select-search {
  flex: 1;
  min-width: 160px;
  border: 1px solid var(--app-input-border);
  background: var(--app-panel);
  color: var(--app-text);
  border-radius: 10px;
  padding: 8px 10px;
}

.multi-select-action {
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text);
  border-radius: 10px;
  padding: 8px 10px;
  cursor: pointer;
}

.multi-select-panel-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px 0;
  color: var(--app-text-soft);
  font-size: 0.76rem;
}

.multi-select-options {
  padding: 10px 12px 12px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.multi-select-options::-webkit-scrollbar {
  width: 5px;
}

.multi-select-options::-webkit-scrollbar-track {
  background: transparent;
}

.multi-select-options::-webkit-scrollbar-thumb {
  background: var(--app-scrollbar);
  border-radius: 999px;
}

.multi-select-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  transition: border-color 0.15s ease, background 0.15s ease;
}

.multi-select-option.active {
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 76%, var(--app-panel));
}

.multi-select-option.selected {
  border-color: color-mix(in srgb, var(--app-accent) 65%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 88%, var(--app-panel));
}

.multi-select-option-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.multi-select-option-label {
  color: var(--app-text);
  font-size: 0.84rem;
  word-break: break-word;
}

.multi-select-option-description {
  color: var(--app-text-soft);
  font-size: 0.76rem;
  line-height: 1.45;
}

.multi-select-empty {
  color: var(--app-text-soft);
  font-size: 0.82rem;
  padding: 18px 12px;
  text-align: center;
}
</style>
