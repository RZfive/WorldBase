<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import GoalConversationDialog from './GoalConversationDialog.vue'
import GoalCreationConfirmCard from './GoalCreationConfirmCard.vue'
import ProviderModelDropdown from './ProviderModelDropdown.vue'
import type { ChatMessage, ChatMessageBlock, ToolRun } from '../types'
import type { LongTermGoalConversationTurn, LongTermGoalMemoryEntry, LongTermGoalMessageResult } from '../../../../shared/long-term-goal-types'

interface ProviderItem {
  id: string
  name: string
  models: string[]
  activeModel?: string
}

interface LongTermGoalMemoryCompactionProgress {
  goalId: string
  status: 'running' | 'completed' | 'failed'
  stage: string
  detail?: string
  percent: number
  error?: string
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
  streamingAdjust?: { userContent: string; message: ChatMessage } | null
  streamingCreate?: { userContent: string; message: ChatMessage } | null
  streamingRun?: { goalId: string; run: LongTermGoalRun } | null
  memoryCompaction?: LongTermGoalMemoryCompactionProgress | null
  createConversationHistory?: ChatMessage[]
  pendingCreationConfirm?: { changeSet: LongTermGoalChangeSet; proposal: NonNullable<LongTermGoalMessageResult['proposal']> } | null
  goalAutoOpenRunId?: string | null
  streamingReplan?: { goalId: string; message: ChatMessage } | null
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
  (e: 'compactMemory', goalId: string): void
  (e: 'applyChangeSet', changeSetId: string): void
  (e: 'cancelChangeSet', changeSetId: string): void
  (e: 'confirmCreation', changeSetId: string): void
  (e: 'cancelCreation', changeSetId: string): void
  (e: 'resetCreation'): void
  (e: 'answerIntervention', goalId: string, interventionId: string, answers: Array<{ questionId: string; selectedOption: string | null; customAnswer: string | null }>): void
  (e: 'update:selected-agent-id', id: string): void
  (e: 'clear-auto-open-run'): void
}>()

const { t, locale } = useI18n()

type DialogKind = 'report' | 'run' | 'intervention' | 'adjust' | 'memory' | 'create' | 'projects' | 'skills' | null
type InterventionPriority = 'urgent' | 'high' | 'medium' | 'low'
type GoalAdjustmentPhase = 'idle' | 'clarifying' | 'proposal'

const RUN_PAGE_SIZE = 8

const activeDialog = ref<DialogKind>(null)
const activeRunId = ref<string | null>(null)
const activeInterventionId = ref<string | null>(null)
const adjustmentPhase = ref<GoalAdjustmentPhase>('idle')
const adjustmentProposal = ref<null | LongTermGoalMessageResult['proposal']>(null)
const selectedAnswers = ref<Record<string, string>>({})
const customAnswers = ref<Record<string, string>>({})
const titleDraft = ref('')
const editingTitle = ref(false)
const runDateFilter = ref('')
const runPage = ref(1)
const createProviderId = ref('')
const createModelId = ref('')
/** 可绑定项目列表 + 当前选中集合（projects 弹窗用）。 */
interface BindableProject { id: string; name: string }
const availableProjects = ref<BindableProject[]>([])
const selectedProjectIds = ref<Set<string>>(new Set())
const projectsLoading = ref(false)
/** 可绑定技能列表 + 当前选中集合（skills 弹窗用）。 */
interface BindableSkill { id: string; name: string; description?: string }
const availableSkills = ref<BindableSkill[]>([])
const selectedSkillIds = ref<Set<string>>(new Set())
const skillsLoading = ref(false)
const providers = computed(() => props.providers || [])
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
const activeMemoryCompaction = computed(() => (
  props.goal?.id && props.memoryCompaction?.goalId === props.goal.id
    ? props.memoryCompaction
    : null
))
const memoryCompacting = computed(() => activeMemoryCompaction.value?.status === 'running')
const memoryProgressPercent = computed(() => Math.max(0, Math.min(100, activeMemoryCompaction.value?.percent ?? 0)))
const memoryProgressLabel = computed(() => `${Math.round(memoryProgressPercent.value)}%`)
const visibleMemoryCards = computed(() => {
  return [...memories.value]
    .sort((left, right) => {
      if (right.importance !== left.importance) return right.importance - left.importance
      return right.updatedAt.localeCompare(left.updatedAt)
    })
})

/** 未来 24 小时执行时间表（按时间升序），来自 AI 输出 + nextTasks 补充。 */
const upcoming24h = computed(() => {
  const now = Date.now()
  const horizon = now + 24 * 60 * 60 * 1000
  return (props.goal?.upcomingSchedule || [])
    .filter(slot => {
      const ts = Date.parse(slot.at)
      return Number.isFinite(ts) && ts >= now && ts <= horizon
    })
    .sort((a, b) => a.at.localeCompare(b.at))
})

function formatSlotTime (value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  const hour = `${date.getHours()}`.padStart(2, '0')
  const minute = `${date.getMinutes()}`.padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

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

watch(
  () => props.goalAutoOpenRunId,
  (runId) => {
    if (runId) {
      openRun(runId)
      emit('clear-auto-open-run')
    }
  }
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
  if (goal.status === 'paused') return t('chatUi.longTermGoalPaused')
  if (goal.openInterventions.length > 0) return t('chatUi.longTermGoalNeedsInput')
  if (goal.lastRunStatus === 'running') return t('chatUi.longTermGoalRunning')
  if (goal.status === 'completed') return t('chatUi.longTermGoalCompleted')
  if (goal.status === 'archived') return t('chatUi.longTermGoalArchived')
  return goal.nextRunAt ? t('chatUi.longTermGoalReady') : t('chatUi.longTermGoalActive')
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

function normalizeToolRuns (run: LongTermGoalRun): ToolRun[] {
  return (run.toolRuns || []).map(toolRun => ({
    id: toolRun.id,
    name: toolRun.name,
    status: toolRun.status,
    progress: toolRun.progress.map(step => ({ ...step }))
  }))
}

function normalizeConversationToolRuns (turn: LongTermGoalConversationTurn): ToolRun[] {
  return (turn.toolRuns || []).map(toolRun => ({
    id: toolRun.id,
    name: toolRun.name,
    status: toolRun.status,
    progress: toolRun.progress.map(step => ({ ...step }))
  }))
}

function getRunContent (run: LongTermGoalRun): string {
  return stripGoalRunMetadataForDisplay(run.resultText || '').trim() ||
    run.error?.trim() ||
    run.progressSummary ||
    t('chatUi.longTermGoalNoProgress')
}

function stripGoalRunMetadataForDisplay (text: string): string {
  return text
    .replace(new RegExp(`<!--\\s*LONG_TERM_GOAL_RUN_METADATA\\s*[\\s\\S]*?\\s*-->`, 'gi'), '')
    .trim()
}

function closeDialog (): void {
  activeDialog.value = null
  activeRunId.value = null
  activeInterventionId.value = null
  adjustmentPhase.value = 'idle'
  adjustmentProposal.value = null
  selectedAnswers.value = {}
  customAnswers.value = {}
}

function openCreateDialog (): void {
  // Drop any stale proposal/history from a previous abandoned creation attempt.
  emit('resetCreation')
  activeDialog.value = 'create'
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

/**
 * MessageStudio memo: the goal dialogs rebuild their message arrays from
 * `computed`s (conversations, runs, …) on every snapshot change. Without
 * memoization each re-evaluation produces brand-new ChatMessage objects, so
 * MessageList's WeakMap (keyed by object identity) misses, assigns a new v-for
 * key, and tears down/rebuilds every MessageRow — which destroys ThinkingBlock
 * mid-toggle, making the expand/collapse feel stuck or snap-back.
 *
 * Cache each message by a stable key + content signature so the same data
 * returns the same object reference until something that affects rendering
 * actually changes. Streaming messages are held by the parent (useChatPanel)
 * and passed through verbatim, so they never hit this cache.
 */
const messageCache = new Map<string, { sig: string; msg: ChatMessage }>()

function memoizeMessage (key: string, sig: string, build: () => ChatMessage): ChatMessage {
  const cached = messageCache.get(key)
  if (cached && cached.sig === sig) return cached.msg
  const msg = build()
  messageCache.set(key, { sig, msg })
  return msg
}

function asAssistantMessage (content: string, speakerName = 'Long-Term Goal'): ChatMessage {
  return memoizeMessage(
    `assistant:${speakerName}`,
    content,
    () => ({
      role: 'assistant',
      content,
      speakerName,
      // Stable block id (derived from content) so ThinkingBlock/tool blocks keep
      // their identity across re-renders instead of regenerating Math.random ids.
      blocks: [{ id: `goal_content_${hashStr(content)}`, kind: 'content', content }]
    })
  )
}

function asUserMessage (content: string): ChatMessage {
  return memoizeMessage(
    `user:${content}`,
    content,
    () => ({
      role: 'user',
      content,
      blocks: [{ id: `goal_user_${hashStr(content)}`, kind: 'content', content }]
    })
  )
}

/** Tiny stable hash for deriving block ids from content (display-only, not security). */
function hashStr (value: string): string {
  let h = 5381
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function asRunMessage (run: LongTermGoalRun): ChatMessage {
  const toolRuns = normalizeToolRuns(run)
  const content = getRunContent(run)
  const thinking = run.thinkingText?.trim() || ''
  const speakerName = props.goal?.title || 'Long-Term Goal'
  // Signature covers every field that affects rendering; if nothing changed we
  // reuse the cached message object so MessageList's WeakMap key stays stable.
  const sig = [run.id, thinking, content, speakerName,
    toolRuns.map(t => `${t.id}:${t.status}:${t.progress.map(p => `${p.stage}:${p.detail || ''}`).join('>')}`).join('|')
  ].join('::')
  return memoizeMessage(`run:${run.id}`, sig, () => {
    const blocks: ChatMessageBlock[] = []
    if (thinking) {
      blocks.push({ id: `goal_run_thinking_${run.id}`, kind: 'thinking', text: thinking })
    }
    for (const toolRun of toolRuns) {
      blocks.push({ id: `goal_run_tool_${toolRun.id}`, kind: 'tool', toolRun })
    }
    blocks.push({ id: `goal_run_content_${run.id}`, kind: 'content', content })
    return { role: 'assistant', content, speakerName, toolRuns, thinking, blocks }
  })
}

function asConversationTurnMessage (turn: LongTermGoalConversationTurn): ChatMessage {
  const toolRuns = normalizeConversationToolRuns(turn)
  const thinking = turn.thinking?.trim() || ''
  const content = turn.content
  const speakerName = props.goal?.title || 'Long-Term Goal'
  const sig = [turn.id, thinking, content, speakerName,
    toolRuns.map(t => `${t.id}:${t.status}:${t.progress.map(p => `${p.stage}:${p.detail || ''}`).join('>')}`).join('|')
  ].join('::')
  return memoizeMessage(`turn:${turn.id}`, sig, () => {
    const blocks: ChatMessageBlock[] = []
    if (thinking) {
      blocks.push({ id: `goal_turn_thinking_${turn.id}`, kind: 'thinking', text: thinking })
    }
    for (const toolRun of toolRuns) {
      blocks.push({ id: `goal_turn_tool_${toolRun.id}`, kind: 'tool', toolRun })
    }
    blocks.push({ id: `goal_turn_content_${turn.id}`, kind: 'content', content })
    return { role: 'assistant', content, speakerName, toolRuns, thinking, blocks }
  })
}

const reportMessages = computed<ChatMessage[]>(() => {
  return [asAssistantMessage(
    stripGoalRunMetadataForDisplay(latestRun.value?.resultText || '') ||
    latestRun.value?.error?.trim() ||
    latestReview.value?.progressSummary ||
    props.goal?.progressSummary ||
    t('chatUi.longTermGoalNoProgress')
  )]
})

const runMessages = computed<ChatMessage[]>(() => {
  if (props.streamingRun) {
    return [asRunMessage(props.streamingRun.run)]
  }
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

const adjustMessages = computed<ChatMessage[]>(() => {
  const turns = [...conversations.value]
    .filter(turn => turn.goalId === props.goal?.id)
    .reverse()
    .map(turn => turn.role === 'user' ? asUserMessage(turn.content) : asConversationTurnMessage(turn))
  if (props.streamingAdjust) {
    return [...turns, asUserMessage(props.streamingAdjust.userContent), props.streamingAdjust.message]
  }
  if (turns.length > 0) return turns
  return [asAssistantMessage(t('chatUi.quickAdjustDialogIntro'))]
})

const createMessages = computed<ChatMessage[]>(() => {
  const base = [asAssistantMessage(t('chatUi.createGoalDialogIntro')), ...(props.createConversationHistory || [])]
  if (props.streamingCreate) {
    return [...base, asUserMessage(props.streamingCreate.userContent), props.streamingCreate.message]
  }
  return base
})

function sendDialogMessage (text: string): void {
  const goal = props.goal
  if (activeDialog.value === 'create') {
    emit('create', text, {
      providerId: createProviderId.value || null,
      modelId: createModelId.value || null
    })
    // Keep the create dialog open: the AI response (and any proposal/confirmation card) streams in here.
    return
  }
  if (!goal) return
  if (activeDialog.value === 'adjust') {
    adjustmentPhase.value = 'clarifying'
    emit('sendMessage', goal.id, text)
    return
  }
  emit('sendMessage', goal.id, text)
}

function compactMemory (): void {
  const goal = props.goal
  if (!goal || memoryCompacting.value) return
  emit('compactMemory', goal.id)
}

function plainMemoryText (value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, block => block.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function memoryPreview (memory: LongTermGoalMemoryEntry): string {
  return plainMemoryText(memory.content) || t('chatUi.noGoalMemoryContent')
}

function memoryKindLabel (kind: LongTermGoalMemoryEntry['kind']): string {
  const keyMap: Record<LongTermGoalMemoryEntry['kind'], string> = {
    goal_profile: 'chatUi.goalMemoryKindGoalProfile',
    execution_brief: 'chatUi.goalMemoryKindExecutionBrief',
    achievement: 'chatUi.goalMemoryKindAchievement',
    skill: 'chatUi.goalMemoryKindSkill',
    progress_summary: 'chatUi.goalMemoryKindProgress',
    daily_review: 'chatUi.goalMemoryKindDailyReview',
    decision: 'chatUi.goalMemoryKindDecision',
    blocker: 'chatUi.goalMemoryKindBlocker',
    plan: 'chatUi.goalMemoryKindPlan',
    artifact: 'chatUi.goalMemoryKindArtifact'
  }
  return t(keyMap[kind])
}

/** 打开绑定项目弹窗：拉项目列表 + 初始化选中集合为当前绑定。 */
async function openProjectsDialog (): Promise<void> {
  if (!props.goal) return
  selectedProjectIds.value = new Set(props.goal.targetProjectIds || [])
  activeDialog.value = 'projects'
  if (availableProjects.value.length === 0) {
    projectsLoading.value = true
    try {
      const list = await window.electronAPI?.listProjects?.()
      availableProjects.value = (list || []).map((p) => {
        const record = p as Record<string, unknown>
        return {
          id: String(record.id || ''),
          name: String(record.name || record.id || '')
        }
      })
    } catch {
      availableProjects.value = []
    } finally {
      projectsLoading.value = false
    }
  }
}

function toggleProjectBinding (projectId: string): void {
  const next = new Set(selectedProjectIds.value)
  if (next.has(projectId)) next.delete(projectId)
  else next.add(projectId)
  selectedProjectIds.value = next
}

/** 保存绑定项目到当前 goal。 */
async function saveProjectBindings (): Promise<void> {
  const goal = props.goal
  if (!goal) return
  const targetProjectIds = [...selectedProjectIds.value]
  emit('save-goal', goal, { targetProjectIds })
  closeDialog()
}

/** 打开绑定技能弹窗：拉技能列表 + 初始化选中集合为当前绑定。 */
async function openSkillsDialog (): Promise<void> {
  if (!props.goal) return
  selectedSkillIds.value = new Set(props.goal.selectedSkillIds || [])
  activeDialog.value = 'skills'
  if (availableSkills.value.length === 0) {
    skillsLoading.value = true
    try {
      const list = await window.electronAPI?.listSkills?.()
      availableSkills.value = (list || []).map((s) => ({
        id: String(s.id || ''),
        name: String(s.name || s.id || ''),
        description: typeof s.description === 'string' && s.description ? s.description : undefined
      }))
    } catch {
      availableSkills.value = []
    } finally {
      skillsLoading.value = false
    }
  }
}

function toggleSkillBinding (skillId: string): void {
  const next = new Set(selectedSkillIds.value)
  if (next.has(skillId)) next.delete(skillId)
  else next.add(skillId)
  selectedSkillIds.value = next
}

/** 保存绑定技能到当前 goal。 */
async function saveSkillBindings (): Promise<void> {
  const goal = props.goal
  if (!goal) return
  const selectedSkillIdsValue = [...selectedSkillIds.value]
  emit('save-goal', goal, { selectedSkillIds: selectedSkillIdsValue })
  closeDialog()
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

/**
 * ProviderModelDropdown 的单次原子选择事件：一次拿到 providerId + model，
 * 直接保存，避免分别处理两个 update: 事件时的竞态（旧实现第二次保存会用
 * stale currentProviderId 覆盖第一次，导致跨供应商切换失败、UI 不更新）。
 */
function handleProviderModelSelect (payload: { providerId: string; model: string }): void {
  saveGoalProvider(payload.providerId, payload.model || undefined)
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

watch(
  () => props.snapshot?.changeSets || [],
  (changeSets) => {
    const latestDraft = [...changeSets].find(item => item.status === 'draft')
    if (!latestDraft) return
    adjustmentPhase.value = 'proposal'
    adjustmentProposal.value = {
      title: props.goal?.title || '',
      objective: props.goal?.objective || '',
      summary: latestDraft.summary,
      before: latestDraft.before,
      after: latestDraft.after,
      questions: []
    }
  },
  { immediate: true }
)

// Close the create dialog once a real goal has been opened (confirm-creation succeeded). The dialog
// is opened from the empty state (goal === null), so a goal appearing means creation completed.
// Cancel/adjust keep goal null, so the dialog stays open for another attempt.
watch(
  () => props.goal?.id ?? null,
  (goalId, prevId) => {
    if (goalId && !prevId && activeDialog.value === 'create') {
      closeDialog()
    }
  }
)
</script>

<template>
  <section class="goal-panel">
    <div v-if="!goal" class="goal-empty">
      <h2>{{ $t('chatUi.longTermGoals') }}</h2>
      <p>{{ $t('chatUi.longTermGoalEmptyDetail') }}</p>
      <button type="button" class="goal-primary-btn" @click="openCreateDialog">{{ $t('chatUi.newLongTermGoal') }}</button>
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
            @select="handleProviderModelSelect"
          />
          <button type="button" class="goal-ghost-btn" @click="activeDialog = 'adjust'">{{ $t('chatUi.quickAdjustGoal') }}</button>
          <button type="button" class="goal-ghost-btn" @click="activeDialog = 'memory'">{{ $t('chatUi.goalMemory') }}</button>
          <button type="button" class="goal-ghost-btn" @click="openProjectsDialog()">{{ $t('chatUi.bindProjects') }}<span v-if="(goal.targetProjectIds || []).length" class="goal-btn-badge">{{ (goal.targetProjectIds || []).length }}</span></button>
          <button type="button" class="goal-ghost-btn" @click="openSkillsDialog()">{{ $t('chatUi.bindSkills') }}<span v-if="(goal.selectedSkillIds || []).length" class="goal-btn-badge">{{ (goal.selectedSkillIds || []).length }}</span></button>
          <button type="button" class="goal-ghost-btn" @click="emit('runNow', goal.id)">{{ $t('chatUi.runNowOnce') }}</button>
          <button v-if="goal.status === 'paused'" type="button" class="goal-ghost-btn" @click="emit('resume', goal)">{{ $t('chatUi.resumeContinuousGoal') }}</button>
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

        <div class="goal-activity-row">
        <section class="goal-card goal-activity-main">
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

        <aside class="goal-upcoming">
          <div class="goal-section-head">
            <h2>{{ $t('chatUi.upcoming24h') }}</h2>
            <span>{{ upcoming24h.length }}</span>
          </div>
          <div v-if="streamingReplan && streamingReplan.goalId === goal.id" class="goal-upcoming-replan">{{ $t('chatUi.replanning') }}</div>
          <div v-if="upcoming24h.length === 0" class="goal-muted">{{ $t('chatUi.noUpcomingSchedule') }}</div>
          <ol v-else class="goal-upcoming-list">
            <li v-for="slot in upcoming24h" :key="slot.id" :class="{ derived: slot.source === 'task' }">
              <time>{{ formatSlotTime(slot.at) }}</time>
              <strong>{{ slot.title }}</strong>
              <small v-if="slot.reason">{{ slot.reason }}</small>
            </li>
          </ol>
        </aside>
        </div>

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
        :messages="[]"
        @close="closeDialog"
      >
        <template #header-actions>
          <button
            type="button"
            class="goal-ghost-btn compact goal-memory-compact-btn"
            :disabled="memoryCompacting"
            @click="compactMemory"
          >
            {{ memoryCompacting ? $t('chatUi.goalMemoryCompacting') : $t('chatUi.compactGoalMemory') }}
          </button>
        </template>
        <template #messages>
          <div class="goal-memory-panel">
            <div v-if="activeMemoryCompaction" class="goal-memory-compacting">
              <section
                class="goal-memory-progress-card"
                :class="`is-${activeMemoryCompaction.status}`"
                role="status"
              >
                <div class="goal-memory-progress-head">
                  <strong>{{ activeMemoryCompaction.stage }}</strong>
                  <span>{{ memoryProgressLabel }}</span>
                </div>
                <div class="goal-memory-progress-track" aria-hidden="true">
                  <span :style="{ width: `${memoryProgressPercent}%` }"></span>
                </div>
                <p>{{ activeMemoryCompaction.error || activeMemoryCompaction.detail || $t('chatUi.goalMemoryCompactingDetail') }}</p>
              </section>
            </div>
            <div v-else-if="visibleMemoryCards.length === 0" class="goal-memory-empty">
              {{ $t('chatUi.noGoalMemory') }}
            </div>
            <div v-else class="goal-memory-grid">
              <article v-for="memory in visibleMemoryCards" :key="memory.id" class="goal-memory-card">
                <header>
                  <span>{{ memoryKindLabel(memory.kind) }}</span>
                  <strong>{{ memory.importance.toFixed(2) }}</strong>
                </header>
                <h3>{{ memory.title }}</h3>
                <p>{{ memoryPreview(memory) }}</p>
                <footer>{{ formatTime(memory.updatedAt) }}</footer>
              </article>
            </div>
          </div>
        </template>
      </GoalConversationDialog>

      <GoalConversationDialog
        :open="activeDialog === 'adjust'"
        :title="$t('chatUi.quickAdjustGoal')"
        :subtitle="goal.title"
        :messages="adjustMessages"
        :is-loading="!!streamingAdjust"
        allow-input
        :providers="providers"
        :active-provider-id="currentProviderId"
        :selected-model="currentModelId"
        :available-agents="availableAgents"
        :selected-agent-id="selectedAgentId"
        @send="sendDialogMessage"
        @select="handleProviderModelSelect"
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
        @select="handleProviderModelSelect"
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

    <!-- Bind projects dialog (multi-select) -->
    <Teleport to="body">
      <div v-if="activeDialog === 'projects'" class="goal-dialog-backdrop" @click.self="closeDialog">
        <section class="goal-dialog goal-projects-dialog" role="dialog" aria-modal="true">
          <header class="goal-dialog-head">
            <div>
              <h2>{{ $t('chatUi.bindProjects') }}</h2>
              <p>{{ $t('chatUi.bindProjectsHint') }}</p>
            </div>
            <button type="button" class="goal-dialog-close" @click="closeDialog">×</button>
          </header>
          <div class="goal-projects-list">
            <div v-if="projectsLoading" class="goal-projects-empty">{{ $t('common.loading') }}</div>
            <div v-else-if="availableProjects.length === 0" class="goal-projects-empty">{{ $t('chatUi.noProjectsToBind') }}</div>
            <label
              v-for="p in availableProjects"
              :key="p.id"
              class="goal-project-item"
              :class="{ active: selectedProjectIds.has(p.id) }"
            >
              <input
                type="checkbox"
                :checked="selectedProjectIds.has(p.id)"
                @change="toggleProjectBinding(p.id)"
              >
              <span class="goal-project-name">{{ p.name }}</span>
              <span class="goal-project-id">{{ p.id }}</span>
            </label>
          </div>
          <footer class="goal-projects-foot">
            <button type="button" class="goal-ghost-btn" @click="closeDialog">{{ $t('common.cancel') }}</button>
            <button type="button" class="goal-primary-btn" @click="saveProjectBindings">{{ $t('common.save') }}</button>
          </footer>
        </section>
      </div>
    </Teleport>

    <!-- Bind skills dialog (multi-select) -->
    <Teleport to="body">
      <div v-if="activeDialog === 'skills'" class="goal-dialog-backdrop" @click.self="closeDialog">
        <section class="goal-dialog goal-projects-dialog" role="dialog" aria-modal="true">
          <header class="goal-dialog-head">
            <div>
              <h2>{{ $t('chatUi.bindSkills') }}</h2>
              <p>{{ $t('chatUi.bindSkillsHint') }}</p>
            </div>
            <button type="button" class="goal-dialog-close" @click="closeDialog">×</button>
          </header>
          <div class="goal-projects-list">
            <div v-if="skillsLoading" class="goal-projects-empty">{{ $t('common.loading') }}</div>
            <div v-else-if="availableSkills.length === 0" class="goal-projects-empty">{{ $t('chatUi.noSkillsToBind') }}</div>
            <label
              v-for="s in availableSkills"
              :key="s.id"
              class="goal-project-item"
              :class="{ active: selectedSkillIds.has(s.id) }"
            >
              <input
                type="checkbox"
                :checked="selectedSkillIds.has(s.id)"
                @change="toggleSkillBinding(s.id)"
              >
              <span class="goal-project-name">{{ s.name }}</span>
              <span v-if="s.description" class="goal-project-id">{{ s.description }}</span>
            </label>
          </div>
          <footer class="goal-projects-foot">
            <button type="button" class="goal-ghost-btn" @click="closeDialog">{{ $t('common.cancel') }}</button>
            <button type="button" class="goal-primary-btn" @click="saveSkillBindings">{{ $t('common.save') }}</button>
          </footer>
        </section>
      </div>
    </Teleport>

    <GoalConversationDialog
      :open="activeDialog === 'create'"
      :title="$t('chatUi.newLongTermGoal')"
      :messages="createMessages"
      :is-loading="!!streamingCreate"
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
    >
      <GoalCreationConfirmCard
        v-if="pendingCreationConfirm"
        :proposal="pendingCreationConfirm.proposal"
        @confirm="emit('confirmCreation', pendingCreationConfirm!.changeSet.id)"
        @cancel="emit('cancelCreation', pendingCreationConfirm!.changeSet.id)"
        @adjust="emit('resetCreation')"
      />
    </GoalConversationDialog>
  </section>
</template>

<style scoped>
.goal-panel {
  height: 100%;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
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
  width: 100%;
  max-width: 1320px;
  margin: 0 auto;
}

.goal-titlebar {
  display: flex;
  flex: 0 0 auto;
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
  flex: 1 1 auto;
  min-height: 0;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 12px;
  overflow: hidden;
}

.goal-overview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  align-items: stretch;
}

.goal-summary-card,
.goal-card {
  min-width: 0;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  padding: 10px;
}

.goal-summary-card {
  height: 148px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
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
  line-height: 1.42;
  flex: 1;
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 0.79rem;
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
  overflow: auto;
  min-height: 0;
  max-height: 98px;
}

.goal-next-list li {
  margin: 3px 0;
}

.goal-next-list span {
  display: block;
  font-size: 0.76rem;
  line-height: 1.35;
}

.goal-intervention-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  overflow: auto;
  min-height: 0;
  max-height: 98px;
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
  min-height: 0;
  overflow: auto;
}

.goal-activity-list button {
  display: grid;
  grid-template-columns: 118px 132px minmax(0, 1fr);
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

.goal-primary-btn:disabled,
.goal-ghost-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.goal-memory-compact-btn {
  flex: 0 0 auto;
  white-space: nowrap;
}

.goal-memory-panel {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  padding: 14px 18px 18px;
  scrollbar-gutter: stable;
  background: color-mix(in srgb, var(--app-chat-canvas) 96%, transparent);
}

.goal-memory-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 10px;
  align-content: start;
}

.goal-memory-card {
  min-width: 0;
  min-height: 150px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 10px;
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
}

.goal-memory-card header,
.goal-memory-card footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  color: var(--app-text-muted);
  font-size: 0.72rem;
}

.goal-memory-card header span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goal-memory-card header strong {
  flex: 0 0 auto;
  color: var(--app-accent);
  font-size: 0.72rem;
}

.goal-memory-card h3 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.9rem;
  line-height: 1.35;
  letter-spacing: 0;
}

.goal-memory-card p {
  margin: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--app-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  font-size: 0.78rem;
  line-height: 1.45;
}

.goal-memory-card footer {
  justify-content: flex-start;
  margin-top: auto;
}

.goal-memory-empty {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--app-text-muted);
  font-size: 0.86rem;
}

.goal-memory-compacting {
  height: 100%;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
}

.goal-memory-progress-card {
  width: min(520px, 100%);
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel) 94%, transparent);
  padding: 16px;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
}

.goal-memory-progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  font-size: 0.86rem;
}

.goal-memory-progress-head strong {
  min-width: 0;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goal-memory-progress-head span {
  flex: 0 0 auto;
  color: var(--app-text-muted);
  font-variant-numeric: tabular-nums;
}

.goal-memory-progress-track {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-border) 68%, transparent);
}

.goal-memory-progress-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: color-mix(in srgb, var(--app-accent) 82%, #22c55e);
  transition: width 180ms ease;
}

.goal-memory-progress-card p {
  margin: 12px 0 0;
  color: var(--app-text-muted);
  font-size: 0.82rem;
  line-height: 1.45;
}

.goal-memory-progress-card.is-completed .goal-memory-progress-track span {
  background: #16a34a;
}

.goal-memory-progress-card.is-failed {
  border-color: color-mix(in srgb, #dc2626 42%, var(--app-border));
}

.goal-memory-progress-card.is-failed .goal-memory-progress-track span {
  background: #dc2626;
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

  .goal-activity-row {
    grid-template-columns: 1fr;
  }

  .goal-activity-tools {
    justify-content: flex-start;
  }
}

/* ── Bind projects dialog ── */
.goal-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
}
.goal-projects-dialog {
  width: min(560px, 100%);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-chat-canvas);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.36);
}
.goal-projects-dialog .goal-dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--app-border);
}
.goal-projects-dialog .goal-dialog-head h2 { margin: 0; font-size: 1.02rem; }
.goal-projects-dialog .goal-dialog-head p { margin: 4px 0 0; color: var(--app-text-muted); font-size: 0.82rem; }
.goal-dialog-close {
  width: 32px; height: 32px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text);
  cursor: pointer;
}
.goal-projects-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.goal-projects-empty { padding: 24px 8px; text-align: center; color: var(--app-text-muted); }
.goal-project-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.12s ease;
}
.goal-project-item:hover { background: var(--app-panel-muted); }
.goal-project-item.active { border-color: var(--app-accent); background: var(--app-accent-soft, var(--app-panel-muted)); }
.goal-project-item input { flex-shrink: 0; }
.goal-project-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.goal-project-id { font-size: 0.74em; color: var(--app-text-faint); font-family: var(--app-font-mono, monospace); }
.goal-projects-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--app-border);
}
.goal-primary-btn {
  padding: 7px 16px;
  border: none;
  border-radius: 8px;
  background: var(--app-accent);
  color: #fff;
  font-size: 0.86em;
  cursor: pointer;
}
.goal-primary-btn:hover { filter: brightness(1.08); }
.goal-btn-badge {
  margin-left: 5px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--app-accent-soft, var(--app-panel-muted));
  color: var(--app-accent);
  font-size: 0.82em;
  font-weight: 600;
}

/* ── Activity + 24h schedule row ── */
.goal-activity-row {
  display: grid;
  grid-template-columns: minmax(420px, 0.9fr) minmax(340px, 0.58fr);
  gap: 12px;
  align-items: stretch;
  min-height: 0;
}
.goal-activity-main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.goal-upcoming {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  padding: 10px;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.goal-upcoming-replan {
  color: var(--app-accent);
  font-size: 0.76rem;
  margin-bottom: 6px;
}
.goal-upcoming-list {
  margin: 0;
  padding-left: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.goal-upcoming-list li {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-left: 3px solid var(--app-accent);
  padding: 4px 0 4px 8px;
}
.goal-upcoming-list li.derived {
  border-left-color: var(--app-border);
}
.goal-upcoming-list time {
  color: var(--app-text-muted);
  font-size: 0.72rem;
}
.goal-upcoming-list strong {
  font-size: 0.78rem;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.goal-upcoming-list small {
  color: var(--app-text-muted);
  font-size: 0.7rem;
  line-height: 1.25;
}
</style>
