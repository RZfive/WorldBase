<script setup lang="ts">
import { computed, ref } from 'vue'

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
</script>

<template>
  <div class="multi-select-root" :class="{ disabled: props.disabled }">
    <span class="multi-select-label">{{ props.label }}</span>
    <details class="multi-select-shell">
      <summary class="multi-select-summary">
        <span class="multi-select-summary-text">{{ summaryText }}</span>
        <span class="multi-select-summary-count">{{ props.modelValue.length }}</span>
      </summary>

      <div class="multi-select-panel">
        <div class="multi-select-actions">
          <input v-model="query" class="multi-select-search" :placeholder="props.searchPlaceholder">
          <button type="button" class="multi-select-action" @click.prevent="selectAll">全选</button>
          <button type="button" class="multi-select-action" @click.prevent="clearAll">清空</button>
        </div>

        <div v-if="filteredOptions.length > 0" class="multi-select-options">
          <label v-for="option in filteredOptions" :key="option.value" class="multi-select-option">
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
    </details>
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

.multi-select-shell {
  border: 1px solid var(--app-input-border);
  border-radius: 12px;
  background: var(--app-input-bg);
  overflow: hidden;
}

.multi-select-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  list-style: none;
  cursor: pointer;
  padding: 10px 12px;
}

.multi-select-summary::-webkit-details-marker {
  display: none;
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

.multi-select-panel {
  border-top: 1px solid var(--app-border);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
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

.multi-select-options {
  max-height: 240px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.multi-select-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--app-panel);
  border: 1px solid var(--app-border);
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
  padding: 6px 2px 2px;
}
</style>