<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

interface DropdownOption {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: DropdownOption[]
  title: string
  disabled?: boolean
}>(), {
  disabled: false
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const triggerRef = ref<HTMLButtonElement | null>(null)
const open = ref(false)
const activeIndex = ref(0)

const panelStyle = computed(() => {
  if (!open.value || !triggerRef.value) return { display: 'none' }
  const rect = triggerRef.value.getBoundingClientRect()
  const spaceBelow = window.innerHeight - rect.bottom - 8
  const spaceAbove = rect.top - 8
  const estimatedHeight = Math.min(280, props.options.length * 36 + 16)
  const placeAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow
  return {
    position: 'fixed' as const,
    left: `${rect.left}px`,
    width: `${Math.max(rect.width, 140)}px`,
    ...(placeAbove
      ? { bottom: `${window.innerHeight - rect.top + 6}px` }
      : { top: `${rect.bottom + 6}px` })
  }
})

function toggleOpen () {
  if (props.disabled) return
  open.value = !open.value
  if (open.value) {
    const currentIdx = props.options.findIndex(o => o.value === props.modelValue)
    activeIndex.value = currentIdx >= 0 ? currentIdx : 0
    nextTick(() => {
      scrollToActive()
    })
  }
}

function selectOption (value: string) {
  emit('update:modelValue', value)
  open.value = false
}

function handlePanelKeydown (e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    open.value = false
    triggerRef.value?.focus()
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % props.options.length
    scrollToActive()
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + props.options.length) % props.options.length
    scrollToActive()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const opt = props.options[activeIndex.value]
    if (opt) selectOption(opt.value)
  }
}

function scrollToActive () {
  const el = document.querySelector('.provider-dropdown-item.active') as HTMLElement | null
  el?.scrollIntoView({ block: 'nearest' })
}

function onDocumentClick (e: MouseEvent) {
  if (!open.value) return
  const target = e.target as HTMLElement
  if (triggerRef.value?.contains(target)) return
  if (target.closest('.provider-dropdown-panel')) return
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
    class="provider-dropdown-trigger"
    :class="{ open, disabled }"
    type="button"
    :disabled="disabled"
    @click="toggleOpen"
  >
    <span class="provider-dropdown-title">{{ title }}</span>
    <svg class="provider-dropdown-caret" width="10" height="10" viewBox="0 0 16 16" fill="none">
      <path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      class="provider-dropdown-panel"
      :style="panelStyle"
      @click.stop
      @keydown="handlePanelKeydown"
    >
      <button
        v-for="(opt, idx) in options"
        :key="opt.value"
        class="provider-dropdown-item"
        :class="{ active: idx === activeIndex, selected: opt.value === modelValue }"
        type="button"
        @click="selectOption(opt.value)"
        @mouseenter="activeIndex = idx"
      >
        <span class="provider-dropdown-item-label">{{ opt.label }}</span>
        <svg v-if="opt.value === modelValue" class="provider-dropdown-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.provider-dropdown-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--app-input-border);
  background: var(--app-input-bg);
  color: var(--app-text);
  font-size: 0.76em;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  max-width: 180px;
  white-space: nowrap;
}

.provider-dropdown-trigger:hover:not(:disabled) {
  border-color: var(--app-accent);
}

.provider-dropdown-trigger:focus {
  outline: none;
  border-color: var(--app-accent);
  box-shadow: 0 0 0 1px var(--app-accent-soft);
}

.provider-dropdown-trigger.open {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 1px var(--app-accent-soft);
}

.provider-dropdown-trigger.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.provider-dropdown-title {
  overflow: hidden;
  text-overflow: ellipsis;
}

.provider-dropdown-caret {
  flex-shrink: 0;
  opacity: 0.6;
  transition: transform 0.18s ease;
}

.provider-dropdown-trigger.open .provider-dropdown-caret {
  transform: rotate(180deg);
}

.provider-dropdown-panel {
  z-index: 10000;
  background: var(--app-panel-strong);
  backdrop-filter: blur(20px);
  border: 1px solid var(--app-border-strong);
  border-radius: 10px;
  padding: 4px 0;
  max-height: 280px;
  overflow-y: auto;
  overscroll-behavior: contain;
  box-shadow: var(--app-shadow);
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.provider-dropdown-panel::-webkit-scrollbar { width: 5px; }
.provider-dropdown-panel::-webkit-scrollbar-track { background: transparent; }
.provider-dropdown-panel::-webkit-scrollbar-thumb { background: var(--app-scrollbar); border-radius: 3px; }

.provider-dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 7px 12px;
  border: none;
  background: transparent;
  color: var(--app-text);
  font-size: 0.8em;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  transition: background 0.1s ease, color 0.1s ease;
}

.provider-dropdown-item:hover,
.provider-dropdown-item.active {
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
}

.provider-dropdown-item.selected {
  color: var(--app-accent-strong);
  font-weight: 600;
}

.provider-dropdown-item-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.provider-dropdown-check {
  flex-shrink: 0;
  color: var(--app-accent);
}
</style>
