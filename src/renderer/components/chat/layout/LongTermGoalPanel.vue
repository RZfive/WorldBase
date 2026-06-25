<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import GoalConversationDialog from './GoalConversationDialog.vue'
import ProviderModelDropdown from './ProviderModelDropdown.vue'
import type { ChatMessage, ChatMessageBlock, ToolRun } from '../types'

interface ProviderItem {
  id: string
  name: string
  models: string[]
  activeModel?: string
}

const props = defineProps<{
  goal: LongTermGoalDefinition | null
  snapshot: LongTermGoalSnapshot | null
  loading?: boolean
  providers?: ProviderItem[]
  activeProviderId?: string
  selectedModel?: string
  availableAgents?: Array<{ id: string; name: string; icon?: string }>
  selectedAgentId?: string
}>()

const emit = defineEmits<{
  (e: 'create', seed?: string, options?: { providerId?: string | null; modelId?: string | null }): void
  (e: 'runNow', goalId: string): void
  (e: 'pause', goal: LongTermGoalDefinition): void
  (e: 'resume', goal: LongTermGoalDefinition): void
  (e: 'archive', goal: LongTermGoalDefinition): void
  (e: 'delete-goal', goal: LongTermGoalDefinition): void
  (e: 'save-goal', goal: LongTermGoalDefinition, patch: Partial<LongTermGoalDefinition>): void
  (e: 'sendMessage', goalId: string, content: string): void
  (e: 'applyChangeSet', changeSetId: string): void
  (e: 'cancelChangeSet', changeSetId: string): void
  (e: 'answerIntervention', goalId: string, interventionId: string, answers: Array<{ questionId: string; selectedOption: string | null; customAnswer: string | null }>): void
  (e: 'update:selected-agent-id', id: string): void
}>()

const { t, locale } = useI18n()

type DialogKind = 'report' | 'run' | 'intervention' | 'adjust' | 'memory' | 'create' | null
type InterventionPriority = 'urgent' | 'high' | 'medium' | 'low'

const RUN_PAGE_SIZE = 8

const activeDialog = ref<DialogKind>(null)
const activeRunId = ref<string | null>(null)
const activeInterventionId = ref<string | null>(null)
const selectedAnswers = ref<Record<string, string>>({})
const customAnswers = ref<Record<string, string>>({})
const titleDraft = ref('')
const editingTitle = ref(false)
const runDateFilter = ref('')
const runPage = ref(1)
const createProviderId = ref('')
const createModelId = ref('')

const providers = computed(() => props.providers || [])
const activities = computed(() => props.snapshot?.activities || [])
const reviews = computed(() => props.snapshot?.reviews || [])
const runs = computed(() => props.snapshot?.runs || [])
const memories = computed(() => props.snapshot?.memories || [])
const conversations = computed(() => props.snapshot?.conversations || [])
const draftChangeSets = computed(() => (props.snapshot?.changeSets || []).filter(item => item.status === 'draft'))
const latestReview = computed(() => reviews.value[0] || null)
const latestRun = computed(() => runs.value[0] || null)
const openInterventions = computed(() => (props.goal?.openInterventions || []).filter(item => item.status === 'open'))
const selectedIntervention = computed(() => openInterventions.value.find(item => item.id === activeInterventionId.value) || openInterventions.value[0] || null)
const activeRun = computed(() => runs.value.find(item => item.id === activeRunId.value) || null)
const nextTasks = computed(() => props.goal?.nextTasks.filter(item => item.status !== 'done' && item.status !== 'skipped').slice(0, 8) || [])

const currentProviderId = computed(() => {
  const goalProvider = props.goal?.providerId || ''
  if (goalProvider && providers.value.some(provider => provider.id === goalProvider)) return goalProvider
  if (props.activeProviderId && providers.value.some(provider => provider.id === props.activeProviderId)) return props.activeProviderId
  return providers.value[0]?.id || ''
})

const currentModelId = computed(() => {
  const provider = providers.value.find(item => item.id === currentProviderId.value)
  if (props.goal?.modelId && provider?.models.includes(props.goal.modelId)) return props.goal.modelId
  if (props.selectedModel && provider?.models.includes(props.selectedModel)) return props.selectedModel
  return provider?.activeModel || provider?.models[0] || ''
})

const latestReportText = computed(() => {
  return latestRun.value?.resultText ||
    latestReview.value?.progressSummary ||
    props.goal?.progressSummary ||
    t('chatUi.longTermGoalNoProgress')
})

const reportPreview = computed(() => {
  return latestReview.value?.progressSummary ||
    latestRun.value?.progressSummary ||
    props.goal?.progressSummary ||
    t('chatUi.longTermGoalNoProgress')
})

const allDateKeys = computed(() => {
  const dates = new Set<string>()
  for (const run of runs.value) {
    const key = toDateInputValue(run.startedAt || run.createdAt)
    if (key) dates.add(key)
  }
  return Array.from(dates).sort((left, right) => right.localeCompare(left))
})

const filteredRuns = computed(() => {
  if (!runDateFilter.value) return runs.value
  return runs.value.filter(run => toDateInputValue(run.startedAt || run.createdAt) === runDateFilter.value)
})

const runPageCount = computed(() => Math.max(1, Math.ceil(filteredRuns.value.length / RUN_PAGE_SIZE)))
const pagedRuns = computed(() => {
  const page = Math.min(runPage.value, runPageCount.value)
  const start = (page - 1) * RUN_PAGE_SIZE
  return filteredRuns.value.slice(start, start + RUN_PAGE_SIZE)
})

watch(
  () => props.goal?.id,
  () => {
    titleDraft.value = props.goal?.title || ''
    closeDialog()
    runPage.value = 1
    runDateFilter.value = ''
  },
  { immediate: true }
)

watch(
  () => props.goal?.title,
  (title) => {
    if (!editingTitle.value) titleDraft.value = title || ''
  }
)

watch(
  () => [runDateFilter.value, filteredRuns.value.length],
  () => {
    runPage.value = Math.min(runPage.value, runPageCount.value)
  }
)

watch(
  () => [props.activeProviderId, props.selectedModel, providers.value.length],
  () => {
    if (createProviderId.value && providers.value.some(provider => provider.id === createProviderId.value)) return
    createProviderId.value = props.activeProviderId || providers.value[0]?.id || ''
    const provider = providers.value.find(item => item.id === createProviderId.value)
    createModelId.value = props.selectedModel && provider?.models.includes(props.selectedModel)
      ? props.selectedModel
      : provider?.activeModel || provider?.models[0] || ''
  },
  { immediate: true }
)

function formatTime (value?: string | null): string {
  if (!value) return t('chatUi.notScheduled')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(locale.value)
}

function toDateInputValue (value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function todayKey (): string {
  return toDateInputValue(new Date().toISOString())
}

function statusLabel (goal: LongTermGoalDefinition): string {
  if (goal.openInterventions.length > 0) return t('chatUi.longTermGoalNeedsInput')
  if (goal.lastRunStatus === 'running') return t('chatUi.longTermGoalRunning')
  if (goal.status === 'paused') return t('chatUi.longTermGoalPaused')
  if (goal.status === 'completed') return t('chatUi.longTermGoalCompleted')
  if (goal.status === 'archived') return t('chatUi.longTermGoalArchived')
  return t('chatUi.longTermGoalActive')
}

function priorityForIntervention (intervention: LongTermGoalIntervention): InterventionPriority {
  if (intervention.severity === 'blocked' || intervention.severity === 'authorization') return 'urgent'
  if (intervention.severity === 'decision') return 'high'
  return 'low'
}

function priorityLabel (priority: InterventionPriority): string {
  if (priority === 'urgent') return t('chatUi.priorityUrgent')
  if (priority === 'high') return t('chatUi.priorityHigh')
  if (priority === 'medium') return t('chatUi.priorityMedium')
  return t('chatUi.priorityLow')
}

function runStatusLabel (status: LongTermGoalRun['status']): string {
  if (status === 'running') return t('chatUi.longTermGoalRunning')
  if (status === 'reviewing') return t('chatUi.dailyReview')
  if (status === 'failed') return t('chatUi.toolStatusFailed')
  return t('chatUi.toolStatusCompleted')
}

function runTitle (run: LongTermGoalRun): string {
  if (run.status === 'running') return t('chatUi.longTermGoalRunning')
  if (run.status === 'failed') return t('chatUi.executionFailed')
  if (run.status === 'reviewing') return t('chatUi.dailyReview')
  return t('chatUi.executionCompleted')
}

function runSummary (run: LongTermGoalRun): string {
  return run.status === 'running'
    ? (run.progressSummary || t('chatUi.longTermGoalRunningNow'))
    : (run.progressSummary || run.error || t('chatUi.longTermGoalNoProgress'))
}

function getRunActivities (run: LongTermGoalRun): LongTermGoalActivityEvent[] {
  return activities.value.filter(event => event.runId === run.id || event.runId === run.scheduledReportId)
}

function normalizeToolRuns (run: LongTermGoalRun): ToolRun[] {
  return (run.toolRuns || []).map(toolRun => ({
    id: toolRun.id,
    name: toolRun.name,
    status: toolRun.status,
    progress: toolRun.progress.map(step => ({ ...step }))
  }))
}

function buildRunContent (run: LongTermGoalRun): string {
  const runActivities = getRunActivities(run)
  const progressLines = (run.progress || [])
    .filter(entry => entry.kind !== 'thinking' && entry.kind !== 'tool_start' && entry.kind !== 'tool_end')
    .map(entry => `- ${formatTime(entry.at)} · ${[entry.stage, entry.detail].filter(Boolean).join(': ')}`)
  const activityLines = runActivities.map(event => `- ${formatTime(event.createdAt)} · ${event.title}: ${event.summary}`)
  const sections = [
    `# ${runTitle(run)}`,
    `_${formatTime(run.startedAt)}${run.finishedAt ? ` - ${formatTime(run.finishedAt)}` : ''}_`,
    `**${runStatusLabel(run.status)}**`,
    run.progressSummary ? `## ${t('chatUi.progressToday')}\n${run.progressSummary}` : '',
    run.gapToGoal ? `## ${t('chatUi.gapToGoal')}\n${run.gapToGoal}` : '',
    run.error ? `## ${t('chatUi.executionError')}\n${run.error}` : '',
    run.resultText ? `## ${t('chatUi.latestTaskReport')}\n${run.resultText}` : '',
    progressLines.length > 0 ? `## ${t('chatUi.executionProgress')}\n${progressLines.join('\n')}` : '',
    activityLines.length > 0 ? `## ${t('chatUi.viewTrace')}\n${activityLines.join('\n')}` : ''
  ].filter(Boolean)
  return sections.join('\n\n')
}

function closeDialog (): void {
  activeDialog.value = null
  activeRunId.value = null
  activeInterventionId.value = null
  selectedAnswers.value = {}
  customAnswers.value = {}
}

function openRun (runId: string): void {
  activeRunId.value = runId
  activeDialog.value = 'run'
}

function openInterventionDialog (interventionId: string): void {
  activeInterventionId.value = interventionId
  selectedAnswers.value = {}
  customAnswers.value = {}
  activeDialog.value = 'intervention'
}

function asAssistantMessage (content: string, speakerName = 'Long-Term Goal'): ChatMessage {
  return {
    role: 'assistant',
    content,
    speakerName,
    blocks: [{ id: `goal_content_${Math.random().toString(36).slice(2)}`, kind: 'content', content }]
  }
}

function asUserMessage (content: string): ChatMessage {
  return {
    role: 'user',
    content,
    blocks: [{ id: `goal_user_${Math.random().toString(36).slice(2)}`, kind: 'content', content }]
  }
}

function asRunMessage (run: LongTermGoalRun): ChatMessage {
  const blocks: ChatMessageBlock[] = []
  if (run.thinkingText?.trim()) {
    blocks.push({
      id: `goal_run_thinking_${run.id}`,
      kind: 'thinking',
      text: run.thinkingText
    })
  }
  for (const toolRun of normalizeToolRuns(run)) {
    blocks.push({
      id: `goal_run_tool_${toolRun.id}`,
      kind: 'tool',
      toolRun
    })
  }
  const content = buildRunContent(run)
  blocks.push({
    id: `goal_run_content_${run.id}`,
    kind: 'content',
    content
  })
  return {
    role: 'assistant',
    content,
    speakerName: props.goal?.title || 'Long-Term Goal',
    toolRuns: normalizeToolRuns(run),
    thinking: run.thinkingText,
    blocks
  }
}

const reportMessages = computed<ChatMessage[]>(() => {
  const review = latestReview.value
  const sections = [
    `# ${t('chatUi.latestTaskReport')}`,
    latestRun.value?.resultText || props.goal?.progressSummary || '',
    review ? `## ${t('chatUi.progressToday')}\n${review.progressSummary}` : '',
    review ? `## ${t('chatUi.gapToGoal')}\n${review.gapAnalysis}` : '',
    review && review.nextPlan.length > 0 ? `## ${t('chatUi.nextTaskQueue')}\n${review.nextPlan.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '',
    review && review.blockers.length > 0 ? `## ${t('chatUi.blockers')}\n${review.blockers.map(item => `- ${item}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n')
  return [asAssistantMessage(sections || latestReportText.value)]
})

const runMessages = computed<ChatMessage[]>(() => {
  const run = activeRun.value
  if (!run) return []
  return [asRunMessage(run)]
})

const interventionMessages = computed<ChatMessage[]>(() => {
  const intervention = selectedIntervention.value
  if (!intervention) return [asAssistantMessage(t('chatUi.goalWillContinueQuietly'))]
  const content = [
    `# ${intervention.title}`,
    `**${priorityLabel(priorityForIntervention(intervention))}** · ${intervention.severity}`,
    intervention.summary,
    intervention.questions.length > 0
      ? `## ${t('chatUi.needsDecision')}\n${intervention.questions.map((question, index) => {
          const options = question.options.length > 0 ? `\n${question.options.map(option => `- ${option}`).join('\n')}` : ''
          return `${index + 1}. ${question.question}${options}${question.reason ? `\n\n${question.reason}` : ''}`
        }).join('\n\n')}`
      : ''
  ].filter(Boolean).join('\n\n')
  return [asAssistantMessage(content)]
})

const memoryMessages = computed<ChatMessage[]>(() => {
  const content = [
    `# ${t('chatUi.goalMemory')}`,
    memories.value.length === 0
      ? t('chatUi.noGoalMemory')
      : memories.value.map(memory => `## ${memory.title}\n\n\`${memory.kind}\` · ${memory.importance.toFixed(2)}\n\n${memory.content}`).join('\n\n')
  ].join('\n\n')
  return [asAssistantMessage(content)]
})

const adjustMessages = computed<ChatMessage[]>(() => {
  const turns = [...conversations.value].reverse().map(turn => turn.role === 'user' ? asUserMessage(turn.content) : asAssistantMessage(turn.content))
  if (turns.length > 0) return turns
  return [asAssistantMessage(t('chatUi.quickAdjustDialogIntro'))]
})

const createMessages = computed<ChatMessage[]>(() => [
  asAssistantMessage(t('chatUi.createGoalDialogIntro'))
])

function sendDialogMessage (text: string): void {
  const goal = props.goal
  if (activeDialog.value === 'create') {
    emit('create', text, {
      providerId: createProviderId.value || null,
      modelId: createModelId.value || null
    })
    closeDialog()
    return
  }
  if (!goal) return
  emit('sendMessage', goal.id, text)
}

function startTitleEdit (): void {
  titleDraft.value = props.goal?.title || ''
  editingTitle.value = true
}

function commitTitle (): void {
  const goal = props.goal
  if (!goal) return
  const title = titleDraft.value.trim()
  editingTitle.value = false
  if (!title || title === goal.title) {
    titleDraft.value = goal.title
    return
  }
  emit('save-goal', goal, { title })
}

function saveGoalProvider (providerId: string, modelId?: string): void {
  const goal = props.goal
  if (!goal) return
  const provider = providers.value.find(item => item.id === providerId)
  const resolvedModelId = modelId != null
    ? modelId
    : (provider?.models.includes(currentModelId.value) ? currentModelId.value : provider?.activeModel || provider?.models[0] || '')
  emit('save-goal', goal, {
    providerId: providerId || null,
    modelId: resolvedModelId || null
  })
}

function setCreateProvider (providerId: string): void {
  createProviderId.value = providerId
  const provider = providers.value.find(item => item.id === providerId)
  if (!provider?.models.includes(createModelId.value)) {
    createModelId.value = provider?.activeModel || provider?.models[0] || ''
  }
}

function setCreateModel (modelId: string): void {
  createModelId.value = modelId
}

function confirmDeleteGoal (): void {
  const goal = props.goal
  if (!goal) return
  const ok = window.confirm(t('chatUi.deleteLongTermGoalConfirm', { title: goal.title }))
  if (!ok) return
  emit('delete-goal', goal)
}

function chooseAnswer (questionId: string, option: string): void {
  selectedAnswers.value = { ...selectedAnswers.value, [questionId]: option }
  const nextCustom = { ...customAnswers.value }
  delete nextCustom[questionId]
  customAnswers.value = nextCustom
}

function updateCustomAnswer (questionId: string, value: string): void {
  customAnswers.value = { ...customAnswers.value, [questionId]: value }
  if (value.trim()) {
    const next = { ...selectedAnswers.value }
    delete next[questionId]
    selectedAnswers.value = next
  }
}

function submitIntervention (): void {
  const goal = props.goal
  const intervention = selectedIntervention.value
  if (!goal || !intervention) return
  const answers = intervention.questions.map(question => {
    const custom = (customAnswers.value[question.id] || '').trim()
    return {
      questionId: question.id,
      selectedOption: custom ? null : (selectedAnswers.value[question.id] || null),
      customAnswer: custom || null
    }
  })
  emit('answerIntervention', goal.id, intervention.id, answers)
  closeDialog()
}
</script>

<template>
  <section class="goal-panel">
    <div v-if="!goal" class="goal-empty">
      <h2>{{ $t('chatUi.longTermGoals') }}</h2>
      <p>{{ $t('chatUi.longTermGoalEmptyDetail') }}</p>
      <button type="button" class="goal-primary-btn" @click="activeDialog = 'create'">{{ $t('chatUi.newLongTermGoal') }}</button>
    </div>

    <template v-else>
      <header class="goal-titlebar">
        <div class="goal-title-main">
          <div class="goal-kicker">
            <span class="goal-status-dot" :class="{ waiting: goal.openInterventions.length > 0, running: goal.lastRunStatus === 'running', paused: goal.status === 'paused' }"></span>
            <span>{{ statusLabel(goal) }}</span>
            <span>{{ $t('chatUi.nextRun') }} {{ formatTime(goal.nextRunAt) }}</span>
            <span>{{ $t('chatUi.nextReview') }} {{ formatTime(goal.nextReviewAt) }}</span>
          </div>
          <div class="goal-title-row">
            <input
              v-if="editingTitle"
              v-model="titleDraft"
              class="goal-title-input"
              type="text"
              @keydown.enter.prevent="commitTitle"
              @keydown.escape.prevent="editingTitle = false; titleDraft = goal.title"
              @blur="commitTitle"
            >
            <h1 v-else>{{ goal.title }}</h1>
            <button type="button" class="goal-icon-btn" :title="$t('chatUi.editGoalTitle')" @click="startTitleEdit">✎</button>
          </div>
        </div>
        <div class="goal-actions">
          <ProviderModelDropdown
            v-if="providers.length > 0"
            :providers="providers"
            :active-provider-id="currentProviderId"
            :selected-model="currentModelId"
            :title="$t('chatUi.executionProvider')"
            @update:active-provider-id="(id) => saveGoalProvider(id)"
            @update:selected-model="(model) => saveGoalProvider(currentProviderId, model)"
          />
          <button type="button" class="goal-ghost-btn" @click="activeDialog = 'adjust'">{{ $t('chatUi.quickAdjustGoal') }}</button>
          <button type="button" class="goal-ghost-btn" @click="activeDialog = 'memory'">{{ $t('chatUi.goalMemory') }}</button>
          <button type="button" class="goal-ghost-btn" @click="emit('runNow', goal.id)">{{ $t('chatUi.runNow') }}</button>
          <button v-if="goal.status === 'paused'" type="button" class="goal-ghost-btn" @click="emit('resume', goal)">{{ $t('chatUi.resumeGoal') }}</button>
          <button v-else type="button" class="goal-ghost-btn" @click="emit('pause', goal)">{{ $t('chatUi.pauseGoal') }}</button>
          <button type="button" class="goal-danger-btn" @click="confirmDeleteGoal">{{ $t('chatUi.deleteLongTermGoal') }}</button>
        </div>
      </header>

      <main class="goal-content">
        <section class="goal-overview-grid">
          <button type="button" class="goal-summary-card" @click="activeDialog = 'report'">
            <div class="goal-section-head">
              <h2>{{ $t('chatUi.latestTaskReport') }}</h2>
              <span>{{ $t('chatUi.openFullMarkdown') }}</span>
            </div>
            <p>{{ reportPreview }}</p>
          </button>

          <section class="goal-summary-card goal-next-card">
            <div class="goal-section-head">
              <h2>{{ $t('chatUi.nextTaskQueue') }}</h2>
              <span>{{ nextTasks.length }}</span>
            </div>
            <ol v-if="nextTasks.length > 0" class="goal-next-list">
              <li v-for="task in nextTasks" :key="task.id">
                <span>{{ task.title }}</span>
                <small>{{ task.reason || task.priority }}</small>
              </li>
            </ol>
            <p v-else class="goal-muted">{{ $t('chatUi.noNextTasks') }}</p>
          </section>

          <section class="goal-summary-card goal-needs-card">
            <div class="goal-section-head">
              <h2>{{ $t('chatUi.needsYou') }}</h2>
              <span>{{ openInterventions.length }}</span>
            </div>
            <div v-if="openInterventions.length > 0" class="goal-intervention-list">
              <button
                v-for="intervention in openInterventions"
                :key="intervention.id"
                type="button"
                :class="['goal-intervention-item', `priority-${priorityForIntervention(intervention)}`]"
                @click="openInterventionDialog(intervention.id)"
              >
                <strong>{{ intervention.title }}</strong>
                <span>{{ priorityLabel(priorityForIntervention(intervention)) }} · {{ intervention.summary }}</span>
              </button>
            </div>
            <p v-else class="goal-muted">{{ $t('chatUi.noNeedToAct') }}</p>
          </section>
        </section>

        <section class="goal-card">
          <div class="goal-section-head goal-activity-head">
            <div>
              <h2>{{ $t('chatUi.goalActivity') }}</h2>
              <span>{{ filteredRuns.length }} / {{ runs.length }}</span>
            </div>
            <div class="goal-activity-tools">
              <button type="button" class="goal-ghost-btn compact" @click="runDateFilter = ''">{{ $t('chatUi.activityFilterAll') }}</button>
              <button type="button" class="goal-ghost-btn compact" @click="runDateFilter = todayKey()">{{ $t('chatUi.activityFilterToday') }}</button>
              <input
                v-model="runDateFilter"
                class="goal-date-input"
                type="date"
                :list="allDateKeys.length > 0 ? 'goal-activity-dates' : undefined"
              >
              <datalist id="goal-activity-dates">
                <option v-for="date in allDateKeys" :key="date" :value="date" />
              </datalist>
            </div>
          </div>
          <div v-if="runs.length === 0" class="goal-muted">{{ $t('chatUi.noGoalActivity') }}</div>
          <div v-else-if="filteredRuns.length === 0" class="goal-muted">{{ $t('chatUi.noGoalActivityForDate') }}</div>
          <div v-else class="goal-activity-list">
            <button
              v-for="run in pagedRuns"
              :key="run.id"
              type="button"
              :class="{ running: run.status === 'running', failed: run.status === 'failed' }"
              @click="openRun(run.id)"
            >
              <time>{{ formatTime(run.startedAt) }}</time>
              <strong>{{ runTitle(run) }}</strong>
              <span>{{ runSummary(run) }}</span>
            </button>
          </div>
          <div v-if="filteredRuns.length > RUN_PAGE_SIZE" class="goal-pagination">
            <button type="button" class="goal-ghost-btn compact" :disabled="runPage <= 1" @click="runPage -= 1">{{ $t('chatUi.previousPage') }}</button>
            <span>{{ runPage }} / {{ runPageCount }}</span>
            <button type="button" class="goal-ghost-btn compact" :disabled="runPage >= runPageCount" @click="runPage += 1">{{ $t('chatUi.nextPage') }}</button>
          </div>
        </section>

        <section v-if="draftChangeSets.length > 0" class="goal-card">
          <div class="goal-section-head">
            <h2>{{ $t('chatUi.changePreview') }}</h2>
            <span>{{ draftChangeSets.length }}</span>
          </div>
          <article v-for="change in draftChangeSets" :key="change.id" class="goal-change">
            <p>{{ change.summary }}</p>
            <div>
              <button type="button" class="goal-primary-btn" @click="emit('applyChangeSet', change.id)">{{ $t('chatUi.applyChange') }}</button>
              <button type="button" class="goal-ghost-btn" @click="emit('cancelChangeSet', change.id)">{{ $t('common.cancel') }}</button>
            </div>
          </article>
        </section>
      </main>

      <GoalConversationDialog
        :open="activeDialog === 'report'"
        :title="$t('chatUi.latestTaskReport')"
        :subtitle="goal.title"
        :messages="reportMessages"
        @close="closeDialog"
      />

      <GoalConversationDialog
        :open="activeDialog === 'run'"
        :title="activeRun ? runTitle(activeRun) : $t('chatUi.goalActivity')"
        :subtitle="activeRun ? formatTime(activeRun.startedAt) : goal.title"
        :messages="runMessages"
        @close="closeDialog"
      />

      <GoalConversationDialog
        :open="activeDialog === 'memory'"
        :title="$t('chatUi.goalMemory')"
        :subtitle="goal.title"
        :messages="memoryMessages"
        @close="closeDialog"
      />

      <GoalConversationDialog
        :open="activeDialog === 'adjust'"
        :title="$t('chatUi.quickAdjustGoal')"
        :subtitle="goal.title"
        :messages="adjustMessages"
        allow-input
        :providers="providers"
        :active-provider-id="currentProviderId"
        :selected-model="currentModelId"
        :available-agents="availableAgents"
        :selected-agent-id="selectedAgentId"
        @send="sendDialogMessage"
        @update:active-provider-id="(id) => saveGoalProvider(id)"
        @update:selected-model="(model) => saveGoalProvider(currentProviderId, model)"
        @update:selected-agent-id="(id) => emit('update:selected-agent-id', id)"
        @close="closeDialog"
      />

      <GoalConversationDialog
        :open="activeDialog === 'intervention'"
        :title="$t('chatUi.needsYou')"
        :subtitle="goal.title"
        :messages="interventionMessages"
        allow-input
        :providers="providers"
        :active-provider-id="currentProviderId"
        :selected-model="currentModelId"
        :available-agents="availableAgents"
        :selected-agent-id="selectedAgentId"
        @send="sendDialogMessage"
        @update:active-provider-id="(id) => saveGoalProvider(id)"
        @update:selected-model="(model) => saveGoalProvider(currentProviderId, model)"
        @update:selected-agent-id="(id) => emit('update:selected-agent-id', id)"
        @close="closeDialog"
      >
        <div v-if="selectedIntervention" class="goal-decision-panel">
          <div v-for="question in selectedIntervention.questions" :key="question.id" class="goal-question">
            <strong>{{ question.question }}</strong>
            <div>
              <button
                v-for="option in question.options"
                :key="option"
                type="button"
                :class="{ active: selectedAnswers[question.id] === option }"
                @click="chooseAnswer(question.id, option)"
              >
                {{ option }}
              </button>
            </div>
            <input
              :value="customAnswers[question.id] || ''"
              type="text"
              :placeholder="$t('chatUi.goalCustomAnswer')"
              @input="updateCustomAnswer(question.id, ($event.target as HTMLInputElement).value)"
            >
          </div>
          <button type="button" class="goal-primary-btn" @click="submitIntervention">{{ $t('chatUi.submitDecision') }}</button>
        </div>
      </GoalConversationDialog>
    </template>

    <GoalConversationDialog
      :open="activeDialog === 'create'"
      :title="$t('chatUi.newLongTermGoal')"
      :messages="createMessages"
      allow-input
      :providers="providers"
      :active-provider-id="createProviderId"
      :selected-model="createModelId"
      :available-agents="availableAgents"
      :selected-agent-id="selectedAgentId"
      @send="sendDialogMessage"
      @update:active-provider-id="setCreateProvider"
      @update:selected-model="setCreateModel"
      @update:selected-agent-id="(id) => emit('update:selected-agent-id', id)"
      @close="closeDialog"
    />
  </section>
</template>

<style scoped>
.goal-panel {
  min-height: 100%;
  overflow: auto;
  padding: 18px;
  background: var(--app-chat-canvas);
  color: var(--app-text);
}

.goal-empty {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex-direction: column;
  text-align: center;
}

.goal-titlebar,
.goal-content {
  max-width: 1180px;
  margin: 0 auto;
}

.goal-titlebar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.goal-title-main {
  min-width: 0;
}

.goal-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: 6px;
}

.goal-title-row h1 {
  min-width: 0;
  margin: 0;
  font-size: 1.38rem;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}

.goal-title-input {
  width: min(560px, 100%);
  height: 36px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-input-bg);
  color: var(--app-text);
  padding: 0 10px;
  font-size: 1rem;
}

.goal-kicker,
.goal-section-head span,
.goal-muted,
.goal-next-list small,
.goal-activity-list time,
.goal-pagination {
  color: var(--app-text-muted);
  font-size: 0.78rem;
}

.goal-next-list small {
  font-size: 0.71rem;
  line-height: 1.25;
}

.goal-kicker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.goal-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #16a34a;
}

.goal-status-dot.waiting {
  background: #f59e0b;
}

.goal-status-dot.running {
  background: #2563eb;
}

.goal-status-dot.paused {
  background: #94a3b8;
}

.goal-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.goal-content {
  margin-top: 16px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
}

.goal-overview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.goal-summary-card,
.goal-card {
  min-width: 0;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  padding: 10px;
}

button.goal-summary-card {
  text-align: left;
  color: var(--app-text);
  cursor: pointer;
}

button.goal-summary-card:hover,
.goal-intervention-item:hover,
.goal-activity-list button:hover {
  border-color: color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
}

.goal-summary-card p,
.goal-change p {
  margin: 0;
  color: var(--app-text-muted);
  line-height: 1.38;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 0.8rem;
}

.goal-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.goal-section-head h2 {
  margin: 0;
  font-size: 0.94rem;
  letter-spacing: 0;
}

.goal-next-list {
  margin: 0;
  padding-left: 16px;
}

.goal-next-list li {
  margin: 4px 0;
}

.goal-next-list span {
  display: block;
  font-size: 0.82rem;
  line-height: 1.35;
}

.goal-intervention-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.goal-intervention-item {
  border: 1px solid var(--app-border);
  border-left-width: 4px;
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text);
  text-align: left;
  padding: 6px 8px;
  cursor: pointer;
}

.goal-intervention-item strong,
.goal-intervention-item span {
  display: block;
  min-width: 0;
}

.goal-intervention-item span {
  margin-top: 3px;
  color: var(--app-text-muted);
  font-size: 0.72rem;
  line-height: 1.3;
}

.goal-intervention-item strong {
  font-size: 0.82rem;
  line-height: 1.3;
}

.goal-intervention-item.priority-urgent {
  border-left-color: #dc2626;
}

.goal-intervention-item.priority-high {
  border-left-color: #f59e0b;
}

.goal-intervention-item.priority-medium {
  border-left-color: #2563eb;
}

.goal-intervention-item.priority-low {
  border-left-color: #64748b;
}

.goal-activity-head {
  align-items: flex-start;
}

.goal-activity-head > div:first-child span {
  display: inline-block;
  margin-top: 3px;
}

.goal-activity-tools {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.goal-date-input {
  height: 30px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-input-bg);
  color: var(--app-text);
  padding: 0 8px;
  font-size: 0.78rem;
}

.goal-activity-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.goal-activity-list button {
  display: grid;
  grid-template-columns: 150px 180px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  min-height: 44px;
  text-align: left;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel-muted) 48%, transparent);
  color: var(--app-text);
  cursor: pointer;
  padding: 8px 10px;
}

.goal-activity-list button.running {
  border-color: color-mix(in srgb, #2563eb 42%, var(--app-border));
  background: color-mix(in srgb, #2563eb 8%, var(--app-panel-muted));
}

.goal-activity-list button.failed {
  border-color: color-mix(in srgb, #dc2626 36%, var(--app-border));
  background: color-mix(in srgb, #dc2626 7%, var(--app-panel-muted));
}

.goal-activity-list span {
  color: var(--app-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goal-pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.goal-primary-btn,
.goal-ghost-btn,
.goal-danger-btn,
.goal-icon-btn {
  min-height: 32px;
  border-radius: 8px;
  padding: 0 10px;
  border: 1px solid transparent;
  cursor: pointer;
  font-size: 0.82rem;
}

.goal-primary-btn {
  color: #fff;
  background: var(--app-accent);
}

.goal-ghost-btn,
.goal-icon-btn {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 86%, transparent);
  border-color: var(--app-border);
}

.goal-ghost-btn.compact {
  min-height: 30px;
  padding: 0 8px;
  font-size: 0.76rem;
}

.goal-ghost-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.goal-danger-btn {
  color: #b91c1c;
  border-color: color-mix(in srgb, #dc2626 36%, var(--app-border));
  background: color-mix(in srgb, #dc2626 8%, var(--app-panel));
}

.goal-icon-btn {
  width: 32px;
  padding: 0;
}

.goal-change {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  border-top: 1px solid var(--app-border);
  padding-top: 10px;
}

.goal-change:first-of-type {
  border-top: 0;
  padding-top: 0;
}

.goal-change div {
  display: flex;
  gap: 8px;
}

.goal-decision-panel {
  max-height: 34vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 96%, transparent);
}

.goal-question {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.goal-question div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.goal-question button {
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text);
  padding: 6px 10px;
  cursor: pointer;
}

.goal-question button.active {
  border-color: var(--app-accent-strong);
  background: var(--app-accent-soft);
}

.goal-question input {
  width: 100%;
  box-sizing: border-box;
  height: 34px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text);
  padding: 0 10px;
}

@media (max-width: 1120px) {
  .goal-overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 860px) {
  .goal-titlebar {
    flex-direction: column;
  }

  .goal-actions {
    justify-content: flex-start;
  }

  .goal-overview-grid,
  .goal-activity-list button {
    grid-template-columns: 1fr;
  }

  .goal-activity-tools {
    justify-content: flex-start;
  }
}
</style>
