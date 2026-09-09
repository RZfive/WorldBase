<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { TodoItem } from "../types";

const props = defineProps<{
  items: TodoItem[];
  isLoading: boolean;
}>();

const { t } = useI18n();
const collapsed = ref(true);
const completedCount = computed(
  () => props.items.filter((item) => item.status === "completed").length,
);
const inProgressItem = computed(
  () => props.items.find((item) => item.status === "in-progress") || null,
);
const currentStepItem = computed(
  () =>
    inProgressItem.value ||
    props.items.find((item) => item.status === "not-started") ||
    props.items[props.items.length - 1] ||
    null,
);
const currentStepTitle = computed(() => {
  if (currentStepItem.value) return currentStepItem.value.title;
  return t("chatUi.todoCompletedSummary", {
    completed: completedCount.value,
    total: props.items.length,
  });
});
const progressPercent = computed(() => {
  if (props.items.length === 0) return 0;
  return Math.round((completedCount.value / props.items.length) * 100);
});

watch(
  () =>
    props.items
      .map((item) => `${item.id}:${item.status}:${item.title}`)
      .join("|"),
  (_next, previous) => {
    if (!previous && props.items.length > 0) {
      collapsed.value = true;
    }
  },
  { immediate: true },
);

function getStatusLabel(status: TodoItem["status"]): string {
  if (status === "completed") return t("chatUi.todoStatusCompleted");
  if (status === "in-progress") return t("chatUi.todoStatusInProgress");
  return t("chatUi.todoStatusNotStarted");
}

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value;
}
</script>

<template>
  <section class="todo-shell" :aria-label="$t('chatUi.todoCurrentListAria')">
    <div class="todo-float" :class="{ expanded: !collapsed }">
      <Transition name="todo-expand">
        <div v-if="!collapsed" class="todo-detail">
          <div class="todo-detail-head">
            <span>{{ $t('chatUi.todoAll') }}</span>
            <span>{{ completedCount }}/{{ props.items.length }}</span>
          </div>

          <div class="todo-progress-track" aria-hidden="true">
            <div
              class="todo-progress-bar"
              :style="{ width: `${progressPercent}%` }"
            />
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
              <span class="todo-item-status" :class="item.status">{{
                getStatusLabel(item.status)
              }}</span>
            </div>
          </div>
        </div>
      </Transition>

      <button
        class="todo-strip"
        type="button"
        :aria-expanded="!collapsed"
        @click="toggleCollapsed"
      >
        <span
          v-if="currentStepItem"
          class="todo-strip-status"
          :class="currentStepItem.status"
        >
          {{ getStatusLabel(currentStepItem.status) }}
        </span>
        <span class="todo-strip-title">{{ currentStepTitle }}</span>
        <span class="todo-strip-count">{{ completedCount }}/{{ props.items.length }}</span>
        <span
          class="todo-live-dot"
          :class="{ active: props.isLoading }"
          :title="props.isLoading ? $t('chatUi.todoSyncing') : $t('chatUi.todoPaused')"
          aria-hidden="true"
        />
        <span class="todo-toggle" :class="{ collapsed }" aria-hidden="true">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.todo-shell {
  --todo-panel-max-width: 480px;
  position: relative;
  z-index: 9;
  height: 0;
  width: 100%;
  max-width: calc(var(--chat-message-track-max, 980px) - 32px);
  margin: 0 auto;
  padding: 0 calc(var(--chat-message-gutter, 28px) + 10px);
  box-sizing: border-box;
  pointer-events: none;
}

.todo-float {
  position: absolute;
  left: 50%;
  bottom: max(0px, calc(var(--chat-input-overlap, 56px) - 10px));
  width: min(
    var(--todo-panel-max-width),
    var(--chat-message-track-max, 980px),
    calc(100% - var(--chat-message-gutter, 28px) - var(--chat-message-gutter, 28px) - 24px)
  );
  max-width: calc(100% - 32px);
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
  box-sizing: border-box;
  pointer-events: auto;
  transform: translateX(-50%);
}

.todo-strip {
  width: 100%;
  height: 36px;
  min-width: 0;
  padding: 0 8px 0 10px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto auto;
  gap: 8px;
  align-items: center;
  border: 1px solid
    color-mix(in srgb, var(--app-accent) 16%, var(--app-border-strong));
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
  background: color-mix(in srgb, var(--app-panel) 96%, transparent);
  box-shadow: 0 -10px 28px rgba(0, 0, 0, 0.16);
  color: var(--app-text);
  cursor: pointer;
  text-align: left;
  backdrop-filter: blur(14px) saturate(130%);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
}

.todo-strip:hover {
  border-color: color-mix(in srgb, var(--app-accent) 30%, var(--app-border-strong));
  border-bottom: 0;
  background: color-mix(in srgb, var(--app-accent-soft) 34%, var(--app-panel));
}

.todo-strip-title {
  min-width: 0;
  color: var(--app-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.8rem;
  font-weight: 700;
}

.todo-strip-status,
.todo-strip-count {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 7px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  font-size: 0.68rem;
  font-weight: 800;
  white-space: nowrap;
}

.todo-strip-status.in-progress {
  color: var(--app-accent);
  border-color: color-mix(in srgb, var(--app-accent) 30%, var(--app-border-strong));
  background: var(--app-accent-soft);
}

.todo-strip-status.completed {
  color: var(--app-success);
  border-color: color-mix(in srgb, var(--app-success) 28%, var(--app-border-strong));
  background: color-mix(in srgb, var(--app-success) 12%, var(--app-panel));
}

.todo-live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px solid var(--app-border-strong);
  background: var(--app-text-faint);
}

.todo-live-dot.active {
  border-color: color-mix(in srgb, var(--app-accent) 34%, var(--app-border-strong));
  background: var(--app-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 14%, transparent);
}

.todo-toggle {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  transition:
    transform 0.18s ease,
    color 0.18s ease,
    border-color 0.18s ease;
}

.todo-toggle.collapsed {
  transform: rotate(180deg);
}

.todo-float.expanded .todo-toggle {
  color: var(--app-accent);
  border-color: color-mix(
    in srgb,
    var(--app-accent) 28%,
    var(--app-border-strong)
  );
}

.todo-detail {
  padding: 10px;
  border: 1px solid
    color-mix(in srgb, var(--app-accent) 16%, var(--app-border-strong));
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel) 96%, transparent);
  box-shadow: var(--app-shadow);
  overflow: hidden;
  backdrop-filter: blur(14px) saturate(130%);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
}

.todo-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  color: var(--app-text-muted);
  font-size: 0.72rem;
  font-weight: 800;
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
  background: linear-gradient(
    90deg,
    var(--app-accent),
    var(--app-accent-strong)
  );
  transition: width 0.2s ease;
}

.todo-scroll {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: min(260px, 38vh);
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
  border-radius: 8px;
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
  border-color: color-mix(
    in srgb,
    var(--app-accent) 24%,
    var(--app-border-strong)
  );
  color: var(--app-accent);
  background: var(--app-accent-soft);
}

.todo-item-status.completed {
  border-color: color-mix(
    in srgb,
    var(--app-success) 22%,
    var(--app-border-strong)
  );
  color: var(--app-success);
  background: color-mix(in srgb, var(--app-success) 12%, var(--app-panel));
}

.todo-expand-enter-active,
.todo-expand-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
  transform-origin: bottom center;
}

.todo-expand-enter-from,
.todo-expand-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

@media (max-width: 860px) {
  .todo-strip {
    grid-template-columns: auto minmax(0, 1fr) auto auto;
  }

  .todo-live-dot {
    display: none;
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
