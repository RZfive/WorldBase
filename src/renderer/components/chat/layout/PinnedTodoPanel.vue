<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TodoItem } from '../types'

const props = defineProps<{
  items: TodoItem[]
  isLoading: boolean
}>()

const collapsed = ref(true)
const completedCount = computed(() => props.items.filter(item => item.status === 'completed').length)
const inProgressItem = computed(() => props.items.find(item => item.status === 'in-progress') || null)
const progressPercent = computed(() => {
  if (props.items.length === 0) return 0
  return Math.round((completedCount.value / props.items.length) * 100)
})

watch(
  () => props.items.map(item => `${item.id}:${item.status}:${item.title}`).join('|'),
  (_next, previous) => {
    if (!previous && props.items.length > 0) {
      collapsed.value = true
    }
  },
  { immediate: true }
)

function getStatusLabel (status: TodoItem['status']): string {
  if (status === 'completed') return '已完成'
  if (status === 'in-progress') return '进行中'
  return '未开始'
}

function toggleCollapsed (): void {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <section class="todo-shell" aria-label="当前执行清单">
    <div class="todo-card" :class="{ expanded: !collapsed }">
      <button class="todo-summary" type="button" @click="toggleCollapsed">
        <div class="todo-summary-copy">
          <div class="todo-summary-kicker-row">
            <span class="todo-kicker">Todo</span>
            <span class="todo-badge sync" :class="{ active: props.isLoading }">{{ props.isLoading ? '同步中' : '已暂停' }}</span>
          </div>
          <div class="todo-heading">
            {{ inProgressItem ? inProgressItem.title : `已完成 ${completedCount}/${props.items.length} 项` }}
          </div>
          <div class="todo-subtitle">{{ collapsed ? `共 ${props.items.length} 步` : '当前会话的 AI Todo 进度' }}</div>
        </div>

        <div class="todo-summary-actions">
          <div class="todo-progress-text">{{ completedCount }}/{{ props.items.length }}</div>
          <div class="todo-toggle" :class="{ collapsed }" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </div>
      </button>

      <div v-if="!collapsed" class="todo-detail">
        <div class="todo-progress-track" aria-hidden="true">
          <div class="todo-progress-bar" :style="{ width: `${progressPercent}%` }" />
        </div>

        <div class="todo-scroll">
        <div
          v-for="item in props.items"
          :key="item.id"
          class="todo-item"
          :class="item.status"
        >
          <div class="todo-item-index">{{ item.id }}</div>
          <div class="todo-item-copy">
            <div class="todo-item-title">{{ item.title }}</div>
          </div>
          <span class="todo-item-status" :class="item.status">{{ getStatusLabel(item.status) }}</span>
        </div>
      </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.todo-shell {
  padding: 8px var(--chat-message-gutter, 28px) 0;
}

.todo-card {
  width: min(100%, 760px);
  margin: 0 auto;
  border: 1px solid color-mix(in srgb, var(--app-accent) 16%, var(--app-border-strong));
  border-radius: 16px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: var(--app-shadow);
  overflow: hidden;
}

.todo-summary {
  width: 100%;
  padding: 10px 12px;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.todo-summary:hover {
  background: var(--app-panel-muted);
}

.todo-summary-copy {
  min-width: 0;
}

.todo-summary-kicker-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.todo-kicker {
  font-size: 0.67rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--app-accent);
}

.todo-heading {
  margin-top: 4px;
  font-size: 0.83rem;
  font-weight: 700;
  color: var(--app-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.todo-subtitle {
  margin-top: 2px;
  font-size: 0.7rem;
  line-height: 1.35;
  color: var(--app-text-muted);
}

.todo-summary-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.todo-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 600;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
}

.todo-badge.sync.active {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border-strong));
  color: var(--app-accent);
  background: var(--app-accent-soft);
}

.todo-progress-text {
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--app-text-strong);
}

.todo-toggle {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  transition: transform 0.18s ease, color 0.18s ease, border-color 0.18s ease;
}

.todo-toggle.collapsed {
  transform: rotate(-90deg);
}

.todo-card.expanded .todo-toggle {
  color: var(--app-accent);
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border-strong));
}

.todo-detail {
  padding: 0 12px 10px;
}

.todo-progress-track {
  height: 4px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--app-panel-muted);
}

.todo-progress-bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--app-accent), var(--app-accent-strong));
  transition: width 0.2s ease;
}

.todo-scroll {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 144px;
  overflow-y: auto;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.todo-item {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.todo-item.in-progress {
  border-color: color-mix(in srgb, var(--app-accent) 26%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 74%, var(--app-panel));
}

.todo-item.completed {
  border-color: color-mix(in srgb, var(--app-success) 26%, var(--app-border));
  background: color-mix(in srgb, var(--app-success) 10%, var(--app-panel));
}

.todo-item-index {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.66rem;
  font-weight: 700;
  color: var(--app-text-muted);
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border-strong);
}

.todo-item-title {
  font-size: 0.76rem;
  color: var(--app-text);
}

.todo-item-status {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 0.66rem;
  font-weight: 600;
  border: 1px solid var(--app-border-strong);
  color: var(--app-text-muted);
  background: var(--app-panel-strong);
}

.todo-item-status.in-progress {
  border-color: color-mix(in srgb, var(--app-accent) 24%, var(--app-border-strong));
  color: var(--app-accent);
  background: var(--app-accent-soft);
}

.todo-item-status.completed {
  border-color: color-mix(in srgb, var(--app-success) 22%, var(--app-border-strong));
  color: var(--app-success);
  background: color-mix(in srgb, var(--app-success) 12%, var(--app-panel));
}

@media (max-width: 860px) {
  .todo-shell {
    padding: 12px 16px 0;
  }

  .todo-summary {
    align-items: flex-start;
  }

  .todo-item {
    grid-template-columns: 26px 1fr;
  }

  .todo-item-status {
    grid-column: 2;
    justify-self: flex-start;
  }
}
</style>