<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '../markdown'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'group_board' }>
}>()

const { t } = useI18n()
const snapshot = computed(() => props.block.board)
const board = computed(() => snapshot.value.board)
const goalHtml = computed(() => renderMarkdown(board.value.goal || `*${t('chatUi.groupBoardEmpty')}*`))
const recentUpdates = computed(() => snapshot.value.recentUpdates.slice(-5).reverse())

function fieldLabel (field: string): string {
  const map: Record<string, string> = {
    goal: t('chatUi.groupBoardGoal'),
    assumptions: t('chatUi.groupBoardAssumptions'),
    tasks: t('chatUi.groupBoardTasks'),
    decisions: t('chatUi.groupBoardDecisions'),
    evidenceRefs: t('chatUi.groupBoardEvidence'),
    openQuestions: t('chatUi.groupBoardOpenQuestions')
  }
  return map[field] || field
}

function opLabel (op: string): string {
  const map: Record<string, string> = {
    set: t('chatUi.groupBoardOpSet'),
    add: t('chatUi.groupBoardOpAdd'),
    update: t('chatUi.groupBoardOpUpdate'),
    remove: t('chatUi.groupBoardOpRemove')
  }
  return map[op] || op
}
</script>

<template>
  <section class="group-board-card">
    <div class="group-board-header">
      <span class="group-board-label">{{ $t('chatUi.groupBoardLabel') }}</span>
      <h4 class="group-board-title">{{ snapshot.groupName }}</h4>
      <span class="group-board-meta">{{ $t('chatUi.groupBoardUpdated', { at: new Date(snapshot.updatedAt).toLocaleTimeString() }) }}</span>
    </div>

    <div class="group-board-body">
      <section class="group-board-field">
        <div class="group-board-field-title">{{ fieldLabel('goal') }}</div>
        <div class="markdown-body group-board-field-content" v-html="goalHtml" />
      </section>

      <section v-if="board.assumptions.length > 0" class="group-board-field">
        <div class="group-board-field-title">{{ fieldLabel('assumptions') }}</div>
        <ul class="group-board-list">
          <li v-for="(item, index) in board.assumptions" :key="`assumption-${index}`">{{ item }}</li>
        </ul>
      </section>

      <section v-if="board.tasks.length > 0" class="group-board-field">
        <div class="group-board-field-title">{{ fieldLabel('tasks') }}</div>
        <ul class="group-board-list">
          <li v-for="task in board.tasks" :key="task.id" class="group-board-task">
            <span class="group-board-task-status" :data-status="task.status">[{{ task.status }}]</span>
            <span class="group-board-task-title">{{ task.title }}</span>
            <span v-if="task.ownerAgentId" class="group-board-task-owner">· {{ task.ownerAgentId }}</span>
          </li>
        </ul>
      </section>

      <section v-if="board.decisions.length > 0" class="group-board-field">
        <div class="group-board-field-title">{{ fieldLabel('decisions') }}</div>
        <ul class="group-board-list">
          <li v-for="(item, index) in board.decisions" :key="`decision-${index}`">{{ item }}</li>
        </ul>
      </section>

      <section v-if="board.evidenceRefs.length > 0" class="group-board-field">
        <div class="group-board-field-title">{{ fieldLabel('evidenceRefs') }}</div>
        <ul class="group-board-list">
          <li v-for="(item, index) in board.evidenceRefs" :key="`evidence-${index}`">{{ item }}</li>
        </ul>
      </section>

      <section v-if="board.openQuestions.length > 0" class="group-board-field">
        <div class="group-board-field-title">{{ fieldLabel('openQuestions') }}</div>
        <ul class="group-board-list">
          <li v-for="(item, index) in board.openQuestions" :key="`question-${index}`">{{ item }}</li>
        </ul>
      </section>
    </div>

    <section v-if="recentUpdates.length > 0" class="group-board-audit">
      <div class="group-board-audit-title">{{ $t('chatUi.groupBoardAudit') }}</div>
      <ul class="group-board-audit-list">
        <li v-for="update in recentUpdates" :key="update.id">
          <span class="group-board-audit-agent">{{ update.agentName }}</span>
          <span class="group-board-audit-op">{{ opLabel(update.op) }}</span>
          <span class="group-board-audit-field">{{ fieldLabel(update.field) }}</span>
          <span v-if="update.reason" class="group-board-audit-reason">— {{ update.reason }}</span>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.group-board-card {
  width: 100%;
  padding: 2px 0 0;
  color: var(--app-text);
}
.group-board-header {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
}
.group-board-label {
  color: var(--app-accent-strong);
  font-size: 0.72em;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.group-board-title {
  margin: 0;
  font-size: 0.98em;
  color: var(--app-text-strong);
  font-weight: 600;
}
.group-board-meta {
  color: var(--app-text-muted);
  font-size: 0.74em;
}
.group-board-body {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.group-board-field {
  padding: 12px 0 0;
  border-top: 1px solid var(--app-border);
  min-width: 0;
}
.group-board-field-title {
  font-size: 0.76em;
  font-weight: 700;
  color: var(--app-text-strong);
  margin-bottom: 6px;
}
.group-board-field-content {
  font-size: 0.82em;
  line-height: 1.55;
  color: var(--app-text);
}
.group-board-list {
  margin: 0;
  padding-left: 1.1em;
}
.group-board-list li {
  font-size: 0.8em;
  line-height: 1.5;
  color: var(--app-text);
  margin-bottom: 4px;
}
.group-board-task {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}
.group-board-task-status {
  font-family: var(--app-mono, monospace);
  font-size: 0.78em;
  font-weight: 700;
}
.group-board-task-status[data-status="done"] { color: #2f7a4a; }
.group-board-task-status[data-status="running"] { color: #0369a1; }
.group-board-task-status[data-status="blocked"] { color: #b25a1e; }
.group-board-task-status[data-status="todo"] { color: var(--app-text-muted); }
.group-board-task-owner {
  color: var(--app-text-muted);
  font-size: 0.86em;
}
.group-board-audit {
  margin-top: 14px;
  padding: 12px 0 0;
  border-top: 1px solid var(--app-border);
}
.group-board-audit-title {
  font-size: 0.72em;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--app-text-muted);
  margin-bottom: 8px;
}
.group-board-audit-list {
  margin: 0;
  padding-left: 1.1em;
}
.group-board-audit-list li {
  font-size: 0.76em;
  line-height: 1.5;
  color: var(--app-text-muted);
  margin-bottom: 3px;
}
.group-board-audit-agent { font-weight: 700; color: var(--app-accent-strong); }
.group-board-audit-op { color: var(--app-text-strong); }
.group-board-audit-field { color: var(--app-text); }
.group-board-audit-reason { color: var(--app-text-muted); }
</style>
