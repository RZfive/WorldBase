<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * Custom multi-select dropdown for reasoning-effort levels (cc-switch style).
 * Fully hand-rendered — no native <select>/<checkbox>: a styled trigger opens
 * a teleported popover where level rows toggle on/off. "All levels selected"
 * is emitted as undefined (no restriction — session strength clamps to the
 * gateway-declared set); a partial pick narrows the clamp domain.
 */
const props = withDefaults(defineProps<{
  /** Selectable levels: the gateway-declared set or the canonical enum. */
  universe: string[]
  /** Allowed levels; undefined/empty = everything allowed. */
  modelValue?: string[]
  /** Gateway-declared default level, badged in the option list. */
  defaultLevel?: string
  disabled?: boolean
  ariaLabel?: string
}>(), {
  modelValue: undefined,
  defaultLevel: undefined,
  disabled: false,
  ariaLabel: undefined
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[] | undefined): void
}>()

const { t } = useI18n()

const open = ref(false)
const activeIndex = ref(0)
const triggerRef = ref<HTMLButtonElement | null>(null)
const panelRef = ref<HTMLDivElement | null>(null)

/** true when the user narrowed the pick below "everything allowed". */
const restricting = computed(() => (props.modelValue?.length ?? 0) > 0)

const selectedSet = computed(() => new Set(restricting.value ? props.modelValue! : props.universe))

const selectedCount = computed(() =>
  props.universe.reduce((count, level) => count + (selectedSet.value.has(level) ? 1 : 0), 0)
)

const summaryText = computed(() => {
  if (props.universe.length === 0) return t('settings.provider.effortNoLevels')
  if (!restricting.value) return t('settings.provider.effortAllLevels')
  return props.universe.filter(level => selectedSet.value.has(level)).join(' / ')
})

const countText = computed(() => `${selectedCount.value}/${props.universe.length}`)

const panelStyle = computed(() => {
  if (!open.value || !triggerRef.value) return { display: 'none' }

  const rect = triggerRef.value.getBoundingClientRect()
  const viewportPadding = 12
  const width = Math.min(Math.max(rect.width, 240), 320)
  const maxLeft = Math.max(viewportPadding, window.innerWidth - width - viewportPadding)
  const left = Math.min(Math.max(viewportPadding, rect.left), maxLeft)
  const spaceBelow = window.innerHeight - rect.bottom - viewportPadding
  const spaceAbove = rect.top - viewportPadding
  const preferredHeight = 300
  const minAvailableHeight = 160
  const placeAbove = spaceBelow < 240 && spaceAbove > spaceBelow
  const availableHeight = Math.max(minAvailableHeight, placeAbove ? spaceAbove : spaceBelow)
  const maxHeight = Math.min(preferredHeight, availableHeight)

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

watch(() => props.universe.length, (length) => {
  activeIndex.value = 0
  if (activeIndex.value >= length) activeIndex.value = Math.max(0, length - 1)
})

function emitNext (next: Set<string>): void {
  // A full selection is stored as "no restriction" so untouched providers
  // keep the follow-session behaviour.
  if (next.size >= props.universe.length) {
    emit('update:modelValue', undefined)
    return
  }
  emit('update:modelValue', props.universe.filter(level => next.has(level)))
}

function toggleLevel (level: string): void {
  if (props.disabled) return
  const next = new Set(selectedSet.value)
  if (next.has(level)) {
    // Keep at least one level allowed — an empty pick would silently mean
    // "no restriction" again, which is confusing to see in the trigger.
    if (next.size <= 1) return
    next.delete(level)
  } else {
    next.add(level)
  }
  emitNext(next)
}

function selectAll (): void {
  if (props.disabled) return
  emit('update:modelValue', undefined)
}

function scrollActiveIntoView (): void {
  const activeElement = panelRef.value?.querySelector('.effort-select-option.active') as HTMLElement | null
  activeElement?.scrollIntoView({ block: 'nearest' })
}

function closePanel (): void {
  open.value = false
}

function handleViewportChange (event: Event): void {
  const target = event.target
  if (target instanceof Node && panelRef.value?.contains(target)) return
  closePanel()
}

function toggleOpen (): void {
  if (props.disabled || props.universe.length === 0) return
  open.value = !open.value
  if (!open.value) return
  activeIndex.value = Math.max(0, props.universe.findIndex(level => selectedSet.value.has(level)))
  nextTick(scrollActiveIntoView)
}

function handlePanelKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closePanel()
    triggerRef.value?.focus()
    return
  }
  if (props.universe.length === 0) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % props.universe.length
    nextTick(scrollActiveIntoView)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + props.universe.length) % props.universe.length
    nextTick(scrollActiveIntoView)
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    const level = props.universe[activeIndex.value]
    if (!level) return
    event.preventDefault()
    toggleLevel(level)
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
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick, true)
  document.removeEventListener('scroll', handleViewportChange, true)
  window.removeEventListener('resize', handleViewportChange)
})

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('scroll', handleViewportChange, true)
    window.addEventListener('resize', handleViewportChange)
    return
  }
  document.removeEventListener('scroll', handleViewportChange, true)
  window.removeEventListener('resize', handleViewportChange)
})
</script>

<template>
  <div class="effort-select-root" :class="{ disabled: props.disabled }">
    <button
      ref="triggerRef"
      type="button"
      class="effort-select-trigger"
      :class="{ open, restricting: restricting }"
      :disabled="props.disabled || props.universe.length === 0"
      :aria-label="props.ariaLabel"
      :aria-expanded="open"
      @click="toggleOpen"
    >
      <span class="effort-select-summary">{{ summaryText }}</span>
      <span class="effort-select-meta">
        <span class="effort-select-count">{{ countText }}</span>
        <svg class="effort-select-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        class="effort-select-panel"
        :style="panelStyle"
        role="listbox"
        aria-multiselectable="true"
        @click.stop
        @keydown="handlePanelKeydown"
      >
        <div class="effort-select-panel-head">
          <span class="effort-select-panel-title">{{ $t('settings.provider.reasoningLevelLabel') }}</span>
          <button type="button" class="effort-select-action" @click.prevent="selectAll">
            {{ $t('settings.provider.effortSelectAll') }}
          </button>
        </div>

        <div class="effort-select-options">
          <button
            v-for="(level, idx) in props.universe"
            :key="level"
            type="button"
            role="option"
            class="effort-select-option"
            :class="{ selected: selectedSet.has(level), active: idx === activeIndex }"
            :aria-selected="selectedSet.has(level)"
            @mouseenter="activeIndex = idx"
            @click="toggleLevel(level)"
          >
            <span class="effort-select-check" :class="{ on: selectedSet.has(level) }">
              <svg v-if="selectedSet.has(level)" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <span class="effort-select-level">{{ level }}</span>
            <span v-if="level === props.defaultLevel" class="effort-select-default-tag">
              {{ $t('settings.provider.effortDefaultTag') }}
            </span>
          </button>
        </div>

        <div class="effort-select-panel-foot">
          <span>{{ $t('settings.provider.effortSelectedCount', { count: selectedCount, total: props.universe.length }) }}</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.effort-select-root {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.effort-select-root.disabled {
  opacity: 0.7;
}

.effort-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  border: 1px solid var(--app-input-border);
  border-radius: 7px;
  background: var(--app-input-bg);
  color: var(--app-text);
  cursor: pointer;
  padding: 5px 7px;
  font-size: 0.8em;
  text-align: left;
  outline: none;
  min-width: 0;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.effort-select-trigger:hover:not(:disabled),
.effort-select-trigger.open {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 1px var(--app-accent-soft);
}

.effort-select-trigger:disabled {
  cursor: not-allowed;
}

.effort-select-trigger.restricting:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-input-border));
}

.effort-select-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.effort-select-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.effort-select-count {
  min-width: 18px;
  height: 17px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--app-panel-strong, var(--app-panel));
  color: var(--app-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.72rem;
}

.effort-select-caret {
  opacity: 0.6;
  transition: transform 0.18s ease;
}

.effort-select-trigger.open .effort-select-caret {
  transform: rotate(180deg);
}

.effort-select-panel {
  z-index: var(--multi-select-panel-z-index, 10000);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--app-border-strong);
  border-radius: 14px;
  background-color: var(--app-panel-strong);
  background: color-mix(in srgb, var(--app-panel-strong) 92%, transparent);
  backdrop-filter: blur(20px);
  box-shadow: var(--app-shadow);
}

.effort-select-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel-muted, var(--app-panel)) 64%, transparent);
}

.effort-select-panel-title {
  font-size: 0.8rem;
  color: var(--app-text-soft);
}

.effort-select-action {
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text);
  border-radius: 9px;
  padding: 5px 10px;
  font-size: 0.78rem;
  cursor: pointer;
}

.effort-select-action:hover {
  border-color: var(--app-accent);
  color: var(--app-accent);
}

.effort-select-options {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  overflow-x: hidden;
  overflow-y: auto;
  min-height: 0;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.effort-select-options::-webkit-scrollbar {
  width: 5px;
}

.effort-select-options::-webkit-scrollbar-track {
  background: transparent;
}

.effort-select-options::-webkit-scrollbar-thumb {
  background: var(--app-scrollbar);
  border-radius: 999px;
}

.effort-select-option {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 9px;
  color: var(--app-text);
  padding: 7px 9px;
  font-size: 0.84rem;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.12s ease, background 0.12s ease;
}

.effort-select-option.active {
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 76%, var(--app-panel));
}

.effort-select-option.selected {
  border-color: color-mix(in srgb, var(--app-accent) 65%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 88%, var(--app-panel));
}

.effort-select-check {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border: 1.5px solid var(--app-border-strong);
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: var(--app-panel);
  transition: background 0.12s ease, border-color 0.12s ease;
}

.effort-select-check.on {
  background: var(--app-accent);
  border-color: var(--app-accent);
}

.effort-select-level {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.effort-select-default-tag {
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 60%, var(--app-panel));
  color: var(--app-text-soft);
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 0.7rem;
}

.effort-select-panel-foot {
  padding: 8px 12px;
  border-top: 1px solid var(--app-border);
  color: var(--app-text-faint);
  font-size: 0.74rem;
}
</style>
