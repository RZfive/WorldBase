<script setup lang="ts">
import { computed, onActivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ScheduledTaskReportPanel from './ScheduledTaskReportPanel.vue'
import ProviderModelDropdown from '../chat/layout/ProviderModelDropdown.vue'
import { renderMarkdown } from '../chat/markdown'

interface ScheduledTaskReportRequest {
  report: ScheduledTaskRunReport
  seq: number
}

type ScheduleKind = 'once' | 'interval' | 'daily' | 'weekly' | 'dates'
type ToolPolicy = 'standard' | 'autoApprove'

const props = defineProps<{
  reportRequest?: ScheduledTaskReportRequest | null
}>()

const emit = defineEmits<{
  (e: 'reportRequestConsumed'): void
}>()

interface ScheduledTaskDraft {
  id: string
  title: string
  enabled: boolean
  createdBy: 'manual' | 'ai'
  prompt: string
  scheduleKind: ScheduleKind
  runAtInput: string
  everyMinutes: number
  intervalPreset: string
  startAtInput: string
  timeOfDayInput: string
  weekdays: number[]
  dateInputs: string[]
  nextDateInput: string
  selectedSkillIds: string[]
  selectedMcpServerIds: string[]
  toolPolicy: ToolPolicy
  /** '' = 跟随执行模型 / 默认；否则为任务级钉扎。 */
  providerId: string
  /** '' = 跟随供应商默认；否则为任务级钉扎。 */
  modelId: string
  maxRetries: number
  retryDelayMinutes: number
}

const tasks = ref<ScheduledTaskDefinition[]>([])
const reports = ref<ScheduledTaskRunReport[]>([])
const skills = ref<SkillInfo[]>([])
const mcpServers = ref<MCPServerConfig[]>([])
const providers = ref<AIProviderConfig[]>([])
const activeProviderId = ref('')
const globalModel = ref<{ providerId: string | null; modelId: string | null }>({
  providerId: null,
  modelId: null
})
const selectedTaskId = ref('')
const editing = ref(false)
const draft = ref<ScheduledTaskDraft | null>(null)
const saving = ref(false)
const aiGenerating = ref(false)
const statusMessage = ref('')
const aiDraftPrompt = ref('')
const activeReportId = ref<string | null>(null)
const pendingManualReportSince = ref(0)
const activeDetailTab = ref<'details' | 'logs'>('logs')
const searchQuery = ref('')
const statusFilter = ref<'all' | 'enabled' | 'disabled'>('all')
const { t, locale } = useI18n()

const scheduleModeOptions: Array<{ id: ScheduleKind; labelKey: string; detailKey: string }> = [
  { id: 'daily', labelKey: 'settings.scheduledTasks.modeDaily', detailKey: 'settings.scheduledTasks.modeDailyDetail' },
  { id: 'weekly', labelKey: 'settings.scheduledTasks.modeWeekly', detailKey: 'settings.scheduledTasks.modeWeeklyDetail' },
  { id: 'interval', labelKey: 'settings.scheduledTasks.modeInterval', detailKey: 'settings.scheduledTasks.modeIntervalDetail' },
  { id: 'once', labelKey: 'settings.scheduledTasks.modeOnce', detailKey: 'settings.scheduledTasks.modeOnceDetail' },
  { id: 'dates', labelKey: 'settings.scheduledTasks.modeDates', detailKey: 'settings.scheduledTasks.modeDatesDetail' }
]

const intervalPresetOptions = [
  { value: '15', labelKey: 'settings.scheduledTasks.interval15' },
  { value: '30', labelKey: 'settings.scheduledTasks.interval30' },
  { value: '60', labelKey: 'settings.scheduledTasks.interval60' },
  { value: '120', labelKey: 'settings.scheduledTasks.interval120' },
  { value: '360', labelKey: 'settings.scheduledTasks.interval360' },
  { value: '720', labelKey: 'settings.scheduledTasks.interval720' },
  { value: '1440', labelKey: 'settings.scheduledTasks.interval1440' },
  { value: 'custom', labelKey: 'settings.scheduledTasks.intervalCustom' }
]

const scheduleModeIcons: Record<ScheduleKind, string> = {
  daily: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="2.7"/><path d="M8 1.4v1.3M8 13.3v1.3M1.4 8h1.3M13.3 8h1.3M3.3 3.3l.9.9M11.8 11.8l.9.9M12.7 3.3l-.9.9M4.2 11.8l-.9.9"/></svg>',
  weekly: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.2" y="3.2" width="11.6" height="10.6" rx="2"/><path d="M2.2 6.5h11.6M5.2 1.8v2.6M10.8 1.8v2.6"/><path d="M5.2 9.3h1.1M8 9.3h1.1M10.7 9.3h.1M5.2 11.6h1.1M8 11.6h1.1"/></svg>',
  interval: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M13.1 6.2A5.4 5.4 0 0 0 3.3 4.1L2.2 5.6"/><path d="M2.9 9.8a5.4 5.4 0 0 0 9.8 2.1l1.1-1.5"/><path d="M2.2 2.5v3.1h3.1M13.8 13.5v-3.1h-3.1"/></svg>',
  once: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8.2" r="5.5"/><path d="M8 5.1v3.3l2.1 1.3"/><path d="M5.5 1.4h5"/></svg>',
  dates: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4 3.2h8M4 6.5h8M4 9.8h5.5M4 13.1h4"/><circle cx="11.9" cy="10.4" r="1.2" fill="currentColor" stroke="none"/><circle cx="11.9" cy="13.2" r="1.2" fill="currentColor" stroke="none"/></svg>'
}

const weekdayOptions = [
  { value: 1, labelKey: 'settings.scheduledTasks.weekdayMon' },
  { value: 2, labelKey: 'settings.scheduledTasks.weekdayTue' },
  { value: 3, labelKey: 'settings.scheduledTasks.weekdayWed' },
  { value: 4, labelKey: 'settings.scheduledTasks.weekdayThu' },
  { value: 5, labelKey: 'settings.scheduledTasks.weekdayFri' },
  { value: 6, labelKey: 'settings.scheduledTasks.weekdaySat' },
  { value: 7, labelKey: 'settings.scheduledTasks.weekdaySun' }
]

const toolPolicyOptions: Array<{ value: ToolPolicy; labelKey: string; detailKey: string }> = [
  { value: 'standard', labelKey: 'settings.scheduledTasks.toolPolicyStandard', detailKey: 'settings.scheduledTasks.toolPolicyStandardDetail' },
  { value: 'autoApprove', labelKey: 'settings.scheduledTasks.toolPolicyAutoApprove', detailKey: 'settings.scheduledTasks.toolPolicyAutoApproveDetail' }
]

let cleanupTasksChanged: (() => void) | null = null
let cleanupReportsChanged: (() => void) | null = null

const selectedTask = computed(() => {
  return tasks.value.find(task => task.id === selectedTaskId.value) || null
})

const selectedTaskReports = computed(() => {
  if (!selectedTask.value) return []
  return reports.value.filter(report => report.taskId === selectedTask.value?.id)
})

const statusFilterOptions = computed(() => [
  { id: 'all' as const, labelKey: 'settings.scheduledTasks.filterAll', count: tasks.value.length },
  { id: 'enabled' as const, labelKey: 'settings.scheduledTasks.filterEnabled', count: tasks.value.filter(task => task.enabled).length },
  { id: 'disabled' as const, labelKey: 'settings.scheduledTasks.filterDisabled', count: tasks.value.filter(task => !task.enabled).length }
])

const filteredTasks = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  return tasks.value.filter(task => {
    if (statusFilter.value === 'enabled' && !task.enabled) return false
    if (statusFilter.value === 'disabled' && task.enabled) return false
    if (!query) return true
    return `${task.title}\n${task.prompt}`.toLowerCase().includes(query)
  })
})

const enabledTaskCount = computed(() => tasks.value.filter(task => task.enabled).length)

const runningTaskCount = computed(() => {
  return tasks.value.filter(task => task.lastStatus === 'running' || task.lastStatus === 'retrying').length
})

const todayRunCount = computed(() => {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return reports.value.filter(report => {
    const startedAt = new Date(report.startedAt).getTime()
    return Number.isFinite(startedAt) && startedAt >= todayStart
  }).length
})

const successRate = computed<number | null>(() => {
  const finishedReports = reports.value.filter(report => report.status === 'completed' || report.status === 'failed')
  if (finishedReports.length === 0) return null
  const completed = finishedReports.filter(report => report.status === 'completed').length
  return Math.round((completed / finishedReports.length) * 100)
})

const editingExistingTask = computed(() => {
  return Boolean(draft.value && tasks.value.some(task => task.id === draft.value?.id))
})

const activeReport = computed(() => {
  if (!activeReportId.value) return null
  return reports.value.find(report => report.id === activeReportId.value) || null
})

const reportPanelOpen = computed(() => Boolean(activeReport.value))

const skillNameMap = computed(() => {
  return new Map(skills.value.map(skill => [skill.id, skill.name]))
})

const mcpNameMap = computed(() => {
  return new Map(mcpServers.value.map(server => [server.id, server.name]))
})

const providerNameMap = computed(() => {
  return new Map(providers.value.map(provider => [provider.id, provider.name]))
})

function providerDisplayName (id?: string | null): string {
  if (!id) return ''
  return providerNameMap.value.get(id) || id
}

const draftModelOptions = computed(() => {
  const providerId = draft.value?.providerId
  if (!providerId) return []
  return providers.value.find(provider => provider.id === providerId)?.models || []
})

/** 聊天页同款多层选择：首位伪供应商 = 「跟随默认」（无模型，点击即清除钉扎）。 */
const schedulerProviderOptions = computed(() => [
  { id: '__follow__', name: t('settings.scheduledTasks.followDefault'), models: [] as string[] },
  ...providers.value
])

function onExecutionModelSelect (selection: { providerId: string; model: string }) {
  if (selection.providerId === '__follow__') {
    globalModel.value = { providerId: null, modelId: null }
  } else {
    globalModel.value = {
      providerId: selection.providerId,
      modelId: selection.model || null
    }
  }
  void saveModelSettings()
}

async function saveModelSettings () {
  if (!window.electronAPI?.setScheduledTaskModelSettings) return
  try {
    await window.electronAPI.setScheduledTaskModelSettings({
      providerId: globalModel.value.providerId,
      modelId: globalModel.value.modelId
    })
  } catch (error) {
    setStatus(t('settings.scheduledTasks.modelSettingsFailed', { message: (error as Error).message }))
  }
}

function taskModelLabel (task: ScheduledTaskDefinition): string {
  const provider = providerDisplayName(task.providerId)
    || t('settings.scheduledTasks.followDefault')
  return task.modelId ? `${provider} / ${task.modelId}` : provider
}

function setStatus (message: string) {
  statusMessage.value = message
  window.setTimeout(() => {
    if (statusMessage.value === message) {
      statusMessage.value = ''
    }
  }, 2400)
}

function generateTaskId (): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `task_${globalThis.crypto.randomUUID()}`
  }
  return `task_${Date.now().toString(36)}`
}

function toLocalDateTimeInput (value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return localDate.toISOString().slice(0, 16)
}

function fromLocalDateTimeInput (value: string): string | null {
  if (!value.trim()) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function normalizeTimeOfDayInput (value: string): string | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null
  }

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
}

function formatTimestamp (value?: string | null): string {
  if (!value) return t('settings.scheduledTasks.notScheduled')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(locale.value)
}

function statusLabel (status?: ScheduledTaskDefinition['lastStatus']): string {
  switch (status) {
    case 'completed': return t('settings.scheduledTasks.statusCompleted')
    case 'failed': return t('settings.scheduledTasks.statusFailed')
    case 'retrying': return t('settings.scheduledTasks.statusRetrying')
    case 'running': return t('settings.scheduledTasks.statusRunning')
    default: return t('settings.scheduledTasks.statusIdle')
  }
}

function statusClass (status?: ScheduledTaskDefinition['lastStatus']): string {
  switch (status) {
    case 'completed': return 'is-completed'
    case 'failed': return 'is-failed'
    case 'retrying': return 'is-retrying'
    case 'running': return 'is-running'
    default: return 'is-idle'
  }
}

function runStatusLabel (status: ScheduledTaskRunReport['status']): string {
  switch (status) {
    case 'completed': return t('settings.scheduledTasks.statusCompleted')
    case 'failed': return t('settings.scheduledTasks.statusFailed')
    case 'retrying': return t('settings.scheduledTasks.statusRetrying')
    default: return t('settings.scheduledTasks.statusRunning')
  }
}

function formatWeekdays (weekdays: number[]): string {
  const labels = new Map(weekdayOptions.map(option => [option.value, t(option.labelKey)]))
  return weekdays.map(weekday => labels.get(weekday)).filter(Boolean).join(t('settings.scheduledTasks.listDelimiter'))
}

function scheduleSummary (task: ScheduledTaskDefinition): string {
  if (task.schedule.kind === 'once') {
    return t('settings.scheduledTasks.summaryOnce', { time: formatTimestamp(task.schedule.runAt) })
  }
  if (task.schedule.kind === 'daily') {
    return t('settings.scheduledTasks.summaryDaily', { time: task.schedule.timeOfDay })
  }
  if (task.schedule.kind === 'weekly') {
    return t('settings.scheduledTasks.summaryWeekly', { weekdays: formatWeekdays(task.schedule.weekdays), time: task.schedule.timeOfDay })
  }
  if (task.schedule.kind === 'dates') {
    return t('settings.scheduledTasks.summaryDates', { count: task.schedule.dates.length })
  }
  return t('settings.scheduledTasks.summaryInterval', { minutes: task.schedule.everyMinutes })
}

function taskNextRunAt (task: ScheduledTaskDefinition): string | null {
  return task.retryScheduledAt || task.nextRunAt || null
}

function formatRelativeRun (value?: string | null): string {
  if (!value) return t('settings.scheduledTasks.notScheduled')
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return value

  const diff = timestamp - Date.now()
  if (diff <= 0) {
    return diff > -60_000 ? t('settings.scheduledTasks.relativeDueNow') : t('settings.scheduledTasks.relativeOverdue')
  }

  const minutes = Math.ceil(diff / 60_000)
  if (minutes < 60) return t('settings.scheduledTasks.relativeInMinutes', { count: minutes })

  const hours = Math.ceil(diff / 3_600_000)
  if (hours < 24) return t('settings.scheduledTasks.relativeInHours', { count: hours })

  return t('settings.scheduledTasks.relativeInDays', { count: Math.ceil(diff / 86_400_000) })
}

function reportStatusClass (status: ScheduledTaskRunReport['status']): string {
  switch (status) {
    case 'completed': return 'is-completed'
    case 'failed': return 'is-failed'
    case 'retrying': return 'is-retrying'
    default: return 'is-running'
  }
}

function intervalPresetFor (everyMinutes: number): string {
  const normalized = Math.floor(Number(everyMinutes))
  return intervalPresetOptions.some(option => option.value === String(normalized))
    ? String(normalized)
    : 'custom'
}

function isScheduleKind (value: unknown): value is ScheduleKind {
  return value === 'once' || value === 'interval' || value === 'daily' || value === 'weekly' || value === 'dates'
}

function buildEmptyDraft (): ScheduledTaskDraft {
  return {
    id: generateTaskId(),
    title: '',
    enabled: true,
    createdBy: 'manual',
    prompt: '',
    scheduleKind: 'daily',
    runAtInput: '',
    everyMinutes: 60,
    intervalPreset: '60',
    startAtInput: '',
    timeOfDayInput: '09:00',
    weekdays: [1, 2, 3, 4, 5],
    dateInputs: [],
    nextDateInput: '',
    selectedSkillIds: [],
    selectedMcpServerIds: [],
    toolPolicy: 'standard',
    providerId: '',
    modelId: '',
    maxRetries: 0,
    retryDelayMinutes: 5
  }
}

function buildDraftFromTask (task: ScheduledTaskDefinition): ScheduledTaskDraft {
  return {
    id: task.id,
    title: task.title,
    enabled: task.enabled,
    createdBy: task.createdBy,
    prompt: task.prompt,
    scheduleKind: task.schedule.kind,
    runAtInput: task.schedule.kind === 'once' ? toLocalDateTimeInput(task.schedule.runAt) : '',
    everyMinutes: task.schedule.kind === 'interval' ? task.schedule.everyMinutes : 60,
    intervalPreset: task.schedule.kind === 'interval' ? intervalPresetFor(task.schedule.everyMinutes) : '60',
    startAtInput: task.schedule.kind === 'interval' ? toLocalDateTimeInput(task.schedule.startAt) : '',
    timeOfDayInput: task.schedule.kind === 'daily' || task.schedule.kind === 'weekly' ? task.schedule.timeOfDay : '09:00',
    weekdays: task.schedule.kind === 'weekly' ? [...task.schedule.weekdays] : [1, 2, 3, 4, 5],
    dateInputs: task.schedule.kind === 'dates' ? task.schedule.dates.map(value => toLocalDateTimeInput(value)).filter(Boolean) : [],
    nextDateInput: '',
    selectedSkillIds: [...task.selectedSkillIds],
    selectedMcpServerIds: [...task.selectedMcpServerIds],
    toolPolicy: task.toolPolicy === 'autoApprove' ? 'autoApprove' : 'standard',
    providerId: task.providerId || '',
    modelId: task.modelId || '',
    maxRetries: task.retryPolicy.maxRetries,
    retryDelayMinutes: task.retryPolicy.retryDelayMinutes
  }
}

function normalizeSelection (values: string[], allowedValues: Set<string>): string[] {
  return Array.from(new Set(values.filter(value => allowedValues.has(value))))
}

function materializeDraft (value: ScheduledTaskDraft): ScheduledTaskDefinition | null {
  const prompt = value.prompt.trim()
  if (!prompt) {
    setStatus(t('settings.scheduledTasks.requiredPrompt'))
    return null
  }

  let schedule: ScheduledTaskSchedule | null = null
  if (value.scheduleKind === 'once') {
    const runAt = fromLocalDateTimeInput(value.runAtInput)
    if (!runAt) {
      setStatus(t('settings.scheduledTasks.requiredOnceTime'))
      return null
    }
    schedule = { kind: 'once', runAt }
  } else if (value.scheduleKind === 'dates') {
    const dates = value.dateInputs
      .map(fromLocalDateTimeInput)
      .filter((date): date is string => Boolean(date))
      .sort((left, right) => left.localeCompare(right))
    if (dates.length === 0) {
      setStatus(t('settings.scheduledTasks.requiredDates'))
      return null
    }
    schedule = { kind: 'dates', dates }
  } else if (value.scheduleKind === 'daily') {
    const timeOfDay = normalizeTimeOfDayInput(value.timeOfDayInput)
    if (!timeOfDay) {
      setStatus(t('settings.scheduledTasks.requiredDailyTime'))
      return null
    }
    schedule = { kind: 'daily', timeOfDay }
  } else if (value.scheduleKind === 'weekly') {
    const timeOfDay = normalizeTimeOfDayInput(value.timeOfDayInput)
    const weekdays = Array.from(new Set(value.weekdays))
      .filter(weekday => Number.isInteger(weekday) && weekday >= 1 && weekday <= 7)
      .sort((left, right) => left - right)
    if (!timeOfDay) {
      setStatus(t('settings.scheduledTasks.requiredWeeklyTime'))
      return null
    }
    if (weekdays.length === 0) {
      setStatus(t('settings.scheduledTasks.requiredWeekday'))
      return null
    }
    schedule = { kind: 'weekly', weekdays, timeOfDay }
  } else {
    if (!Number.isFinite(Number(value.everyMinutes)) || Number(value.everyMinutes) <= 0) {
      setStatus(t('settings.scheduledTasks.requiredInterval'))
      return null
    }
    schedule = {
      kind: 'interval',
      everyMinutes: Math.floor(Number(value.everyMinutes)),
      startAt: fromLocalDateTimeInput(value.startAtInput) || undefined
    }
  }

  const allowedSkillIds = new Set(skills.value.map(skill => skill.id))
  const allowedServerIds = new Set(mcpServers.value.map(server => server.id))
  const existingTask = tasks.value.find(task => task.id === value.id)
  const now = new Date().toISOString()

  return {
    id: value.id,
    title: value.title.trim() || prompt.replace(/\s+/g, ' ').slice(0, 24) || t('settings.scheduledTasks.untitledTask'),
    enabled: value.enabled,
    createdBy: existingTask?.createdBy || value.createdBy,
    prompt,
    schedule,
    selectedSkillIds: normalizeSelection(value.selectedSkillIds, allowedSkillIds),
    selectedMcpServerIds: normalizeSelection(value.selectedMcpServerIds, allowedServerIds),
    toolPolicy: value.toolPolicy === 'autoApprove' ? 'autoApprove' : 'standard',
    providerId: value.providerId || null,
    modelId: value.modelId || null,
    retryPolicy: {
      maxRetries: Number.isFinite(Number(value.maxRetries)) && Number(value.maxRetries) >= 0
        ? Math.floor(Number(value.maxRetries))
        : 0,
      retryDelayMinutes: Number.isFinite(Number(value.retryDelayMinutes)) && Number(value.retryDelayMinutes) > 0
        ? Math.floor(Number(value.retryDelayMinutes))
        : 5
    },
    createdAt: existingTask?.createdAt || now,
    updatedAt: now,
    nextRunAt: existingTask?.nextRunAt || null,
    retryScheduledAt: existingTask?.retryScheduledAt || null,
    lastRunAt: existingTask?.lastRunAt || null,
    lastStatus: existingTask?.lastStatus || 'idle',
    lastReportId: existingTask?.lastReportId || null
  }
}

function extractAssistantText (content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part.type === 'text')
    .map(part => part.text || '')
    .join('\n')
}

function parseJsonPayload (value: string): Record<string, unknown> | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = codeFenceMatch?.[1]?.trim() || trimmed
  const objectMatch = candidate.match(/\{[\s\S]*\}/)
  const jsonText = objectMatch?.[0] || candidate

  try {
    const parsed = JSON.parse(jsonText)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function applyGeneratedDraft (payload: Record<string, unknown>) {
  const nextDraft = draft.value || buildEmptyDraft()
  const allowedSkillIds = new Set(skills.value.map(skill => skill.id))
  const allowedServerIds = new Set(mcpServers.value.map(server => server.id))

  nextDraft.title = typeof payload.title === 'string' ? payload.title.trim() : nextDraft.title
  nextDraft.prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : nextDraft.prompt
  nextDraft.enabled = typeof payload.enabled === 'boolean' ? payload.enabled : nextDraft.enabled
  nextDraft.createdBy = 'ai'

  nextDraft.scheduleKind = isScheduleKind(payload.schedule_kind)
    ? payload.schedule_kind
    : nextDraft.scheduleKind

  if (typeof payload.run_at === 'string') {
    nextDraft.runAtInput = toLocalDateTimeInput(payload.run_at)
  }
  if (Number.isFinite(Number(payload.every_minutes)) && Number(payload.every_minutes) > 0) {
    nextDraft.everyMinutes = Math.floor(Number(payload.every_minutes))
    nextDraft.intervalPreset = intervalPresetFor(nextDraft.everyMinutes)
  }
  if (typeof payload.start_at === 'string') {
    nextDraft.startAtInput = toLocalDateTimeInput(payload.start_at)
  }
  if (typeof payload.time_of_day === 'string') {
    nextDraft.timeOfDayInput = normalizeTimeOfDayInput(payload.time_of_day) || nextDraft.timeOfDayInput
  }
  if (Array.isArray(payload.weekdays)) {
    const weekdays = payload.weekdays
      .map(value => Number(value))
      .filter(weekday => Number.isInteger(weekday) && weekday >= 1 && weekday <= 7)
    if (weekdays.length > 0) {
      nextDraft.weekdays = Array.from(new Set(weekdays)).sort((left, right) => left - right)
    }
  }
  if (Array.isArray(payload.dates)) {
    nextDraft.dateInputs = payload.dates
      .filter((value): value is string => typeof value === 'string')
      .map(value => toLocalDateTimeInput(value))
      .filter(Boolean)
  }
  if (Array.isArray(payload.selected_skill_ids)) {
    nextDraft.selectedSkillIds = normalizeSelection(
      payload.selected_skill_ids.filter((value): value is string => typeof value === 'string'),
      allowedSkillIds
    )
  }
  if (Array.isArray(payload.selected_mcp_server_ids)) {
    nextDraft.selectedMcpServerIds = normalizeSelection(
      payload.selected_mcp_server_ids.filter((value): value is string => typeof value === 'string'),
      allowedServerIds
    )
  }
  if (payload.tool_policy === 'auto_approve' || payload.tool_policy === 'autoApprove' || payload.tool_policy === 'standard') {
    nextDraft.toolPolicy = payload.tool_policy === 'standard' ? 'standard' : 'autoApprove'
  }
  if (Number.isFinite(Number(payload.max_retries)) && Number(payload.max_retries) >= 0) {
    nextDraft.maxRetries = Math.floor(Number(payload.max_retries))
  }
  if (Number.isFinite(Number(payload.retry_delay_minutes)) && Number(payload.retry_delay_minutes) > 0) {
    nextDraft.retryDelayMinutes = Math.floor(Number(payload.retry_delay_minutes))
  }

  draft.value = nextDraft
  editing.value = true
}

async function loadData () {
  if (!window.electronAPI) return

  try {
    const [nextTasks, nextReports, nextSkills, nextServers] = await Promise.all([
      window.electronAPI.listScheduledTasks?.() || Promise.resolve([]),
      window.electronAPI.listScheduledTaskReports?.() || Promise.resolve([]),
      window.electronAPI.listSkills?.() || Promise.resolve([]),
      window.electronAPI.getMcpServers?.() || Promise.resolve([])
    ])

    tasks.value = nextTasks
    reports.value = nextReports
    skills.value = nextSkills
    mcpServers.value = nextServers

    if (tasks.value.length > 0 && !tasks.value.some(task => task.id === selectedTaskId.value)) {
      selectedTaskId.value = tasks.value[0].id
    }
    if (tasks.value.length === 0) {
      selectedTaskId.value = ''
    }
  } catch (error) {
    setStatus(t('settings.scheduledTasks.loadFailed', { message: (error as Error).message }))
  }
}

function startAdd () {
  activeReportId.value = null
  editing.value = true
  draft.value = buildEmptyDraft()
  selectedTaskId.value = draft.value.id
}

function startEdit () {
  if (!selectedTask.value) return
  activeReportId.value = null
  editing.value = true
  draft.value = buildDraftFromTask(selectedTask.value)
}

function cancelEdit () {
  editing.value = false
  draft.value = null
  if (tasks.value.length > 0 && !tasks.value.some(task => task.id === selectedTaskId.value)) {
    selectedTaskId.value = tasks.value[0].id
  }
}

function selectTask (taskId: string) {
  if (editing.value) return
  selectedTaskId.value = taskId
  activeDetailTab.value = 'logs'
  activeReportId.value = null
}

function addDateInput () {
  if (!draft.value || !draft.value.nextDateInput) return
  if (!draft.value.dateInputs.includes(draft.value.nextDateInput)) {
    draft.value.dateInputs = [...draft.value.dateInputs, draft.value.nextDateInput].sort()
  }
  draft.value.nextDateInput = ''
}

function removeDateInput (value: string) {
  if (!draft.value) return
  draft.value.dateInputs = draft.value.dateInputs.filter(item => item !== value)
}

function applyIntervalPreset () {
  if (!draft.value || draft.value.intervalPreset === 'custom') return
  const everyMinutes = Number(draft.value.intervalPreset)
  if (Number.isFinite(everyMinutes) && everyMinutes > 0) {
    draft.value.everyMinutes = Math.floor(everyMinutes)
  }
}

function markIntervalCustom () {
  if (!draft.value) return
  draft.value.intervalPreset = 'custom'
}

function toggleWeekday (weekday: number) {
  if (!draft.value) return

  const selected = new Set(draft.value.weekdays)
  if (selected.has(weekday)) {
    selected.delete(weekday)
  } else {
    selected.add(weekday)
  }
  draft.value.weekdays = Array.from(selected).sort((left, right) => left - right)
}

async function saveDraft () {
  if (!draft.value || !window.electronAPI?.saveScheduledTask) return
  const task = materializeDraft(draft.value)
  if (!task) return

  saving.value = true
  try {
    const savedTask = await window.electronAPI.saveScheduledTask(task)
    tasks.value = [savedTask, ...tasks.value.filter(item => item.id !== savedTask.id)]
      .sort((left, right) => left.title.localeCompare(right.title, locale.value))
    selectedTaskId.value = savedTask.id
    activeDetailTab.value = 'logs'
    editing.value = false
    draft.value = null
    setStatus(t('settings.scheduledTasks.saved'))
    await loadData()
  } catch (error) {
    setStatus(t('common.saveFailed', { message: (error as Error).message }))
  } finally {
    saving.value = false
  }
}

async function deleteSelectedTask () {
  const taskToDelete = selectedTask.value
  if (!taskToDelete || !window.electronAPI?.deleteScheduledTask) return
  if (!window.confirm(t('settings.scheduledTasks.deleteConfirm', { title: taskToDelete.title }))) return

  try {
    // Capture the primitive ID before the reactive selection can change. Passing a
    // Vue proxy through Electron's structured-clone IPC boundary throws
    // `An object could not be cloned.`
    await window.electronAPI.deleteScheduledTask(String(taskToDelete.id))
    activeReportId.value = null
    selectedTaskId.value = ''
    await loadData()
    setStatus(t('settings.scheduledTasks.deleted'))
  } catch (error) {
    setStatus(t('settings.scheduledTasks.deleteFailed', { message: (error as Error).message }))
  }
}

async function toggleSelectedTaskEnabled () {
  const taskToToggle = selectedTask.value
  if (!taskToToggle || !window.electronAPI?.saveScheduledTask) return

  try {
    // `selectedTask` is derived from a Vue reactive array. Spreading it only
    // removes the top-level proxy; nested schedule/retry/array values can still
    // cross the Electron IPC boundary as reactive proxies. Build a plain task
    // payload explicitly before invoking IPC.
    const taskPayload: ScheduledTaskDefinition = {
      id: String(taskToToggle.id),
      title: String(taskToToggle.title),
      enabled: !Boolean(taskToToggle.enabled),
      hidden: taskToToggle.hidden === true,
      createdBy: taskToToggle.createdBy === 'ai' ? 'ai' : 'manual',
      prompt: String(taskToToggle.prompt),
      schedule: JSON.parse(JSON.stringify(taskToToggle.schedule)) as ScheduledTaskDefinition['schedule'],
      providerId: taskToToggle.providerId == null ? null : String(taskToToggle.providerId),
      modelId: taskToToggle.modelId == null ? null : String(taskToToggle.modelId),
      selectedSkillIds: Array.from(taskToToggle.selectedSkillIds, String),
      selectedMcpServerIds: Array.from(taskToToggle.selectedMcpServerIds, String),
      toolPolicy: taskToToggle.toolPolicy === 'autoApprove' ? 'autoApprove' : 'standard',
      retryPolicy: {
        maxRetries: Number(taskToToggle.retryPolicy.maxRetries),
        retryDelayMinutes: Number(taskToToggle.retryPolicy.retryDelayMinutes)
      },
      createdAt: String(taskToToggle.createdAt),
      updatedAt: new Date().toISOString(),
      nextRunAt: taskToToggle.nextRunAt == null ? null : String(taskToToggle.nextRunAt),
      retryScheduledAt: taskToToggle.retryScheduledAt == null ? null : String(taskToToggle.retryScheduledAt),
      lastRunAt: taskToToggle.lastRunAt == null ? null : String(taskToToggle.lastRunAt),
      lastStatus: taskToToggle.lastStatus,
      lastReportId: taskToToggle.lastReportId == null ? null : String(taskToToggle.lastReportId)
    }
    const savedTask = await window.electronAPI.saveScheduledTask(taskPayload)
    selectedTaskId.value = savedTask.id
    await loadData()
    setStatus(savedTask.enabled ? t('settings.scheduledTasks.taskEnabled') : t('settings.scheduledTasks.taskDisabled'))
  } catch (error) {
    setStatus(t('settings.scheduledTasks.enableUpdateFailed', { message: (error as Error).message }))
  }
}

async function runSelectedTaskNow () {
  if (!selectedTask.value || !window.electronAPI?.runScheduledTaskNow) return

  try {
    const manualRunStartedAt = Date.now()
    pendingManualReportSince.value = manualRunStartedAt
    window.setTimeout(() => {
      if (pendingManualReportSince.value === manualRunStartedAt) {
        pendingManualReportSince.value = 0
      }
    }, 120_000)
    const report = await window.electronAPI.runScheduledTaskNow(selectedTask.value.id)
    if (report?.id) {
      activeReportId.value = report.id
      activeDetailTab.value = 'logs'
    }
    setStatus(t('settings.scheduledTasks.started'))
    await loadData()
    if (activeReportId.value && reports.value.some(item => item.id === activeReportId.value)) {
      pendingManualReportSince.value = 0
    } else {
      // The run-now response may be a run record rather than the lazily created
      // report. Keep the pending window open for the reports-changed event.
      if (activeReportId.value) activeReportId.value = null
      const candidate = findPendingManualReport(reports.value)
      if (candidate) {
        activeReportId.value = candidate.id
        activeDetailTab.value = 'logs'
        pendingManualReportSince.value = 0
      }
    }
  } catch (error) {
    pendingManualReportSince.value = 0
    setStatus(t('settings.scheduledTasks.runNowFailed', { message: (error as Error).message }))
  }
}

function findPendingManualReport (list: ScheduledTaskRunReport[]): ScheduledTaskRunReport | null {
  if (!selectedTaskId.value || pendingManualReportSince.value <= 0) return null
  return list.find(report => {
    return report.taskId === selectedTaskId.value &&
      (report.status === 'running' || report.status === 'retrying')
  }) || list.find(report => {
    const startedAt = new Date(report.startedAt).getTime()
    return report.taskId === selectedTaskId.value &&
      Number.isFinite(startedAt) &&
      startedAt >= pendingManualReportSince.value
  }) || null
}

function openReport (reportId: string) {
  activeReportId.value = reportId
  activeDetailTab.value = 'logs'
}

function closeReportPanel () {
  activeReportId.value = null
}

function applyReportRequest (request: ScheduledTaskReportRequest | null | undefined) {
  if (!request) return
  reports.value = [
    request.report,
    ...reports.value.filter(report => report.id !== request.report.id)
  ]
  if (!editing.value) {
    selectedTaskId.value = request.report.taskId
    activeDetailTab.value = 'logs'
  }
  activeReportId.value = request.report.id
  emit('reportRequestConsumed')
}

watch(() => props.reportRequest, applyReportRequest, { immediate: true })
onActivated(() => applyReportRequest(props.reportRequest))

async function generateDraftWithAi () {
  if (!window.electronAPI?.chat || !aiDraftPrompt.value.trim()) return

  aiGenerating.value = true
  try {
    const systemPrompt = [
      '你是一个定时任务配置生成器。',
      '根据用户描述，返回严格 JSON，不要输出 Markdown，不要解释，不要调用任何工具。',
      'JSON 字段仅允许使用：title, prompt, enabled, schedule_kind, run_at, every_minutes, start_at, time_of_day, weekdays, dates, selected_skill_ids, selected_mcp_server_ids, tool_policy, max_retries, retry_delay_minutes。',
      'schedule_kind 只能是 once、interval、daily、weekly、dates。',
      '每天或每周固定时间执行时优先使用 daily 或 weekly，time_of_day 用 HH:mm；weekly 的 weekdays 用 1-7 表示周一到周日。',
      'selected_skill_ids 和 selected_mcp_server_ids 必须只从提供的可用 ID 中选择。',
      'tool_policy 只能是 standard（默认，需确认的工具会被跳过）或 auto_approve（用户明确要求任务可以执行 shell 等需要确认的操作时使用）；只有当用户描述明确需要执行命令/shell 时才设置 auto_approve。'
    ].join('\n')

    const availableSkills = skills.value.map(skill => `${skill.id}: ${skill.name}`).join('\n') || '无'
    const availableServers = mcpServers.value.map(server => `${server.id}: ${server.name}${server.enabled ? '' : ' (disabled)'}`).join('\n') || '无'
    const userPrompt = [
      `当前时间: ${new Date().toISOString()}`,
      '可用 Skill:',
      availableSkills,
      '可用 MCP 服务:',
      availableServers,
      '用户需求:',
      aiDraftPrompt.value.trim()
    ].join('\n\n')

    const response = await window.electronAPI.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ])
    const text = extractAssistantText(response.content as string | Array<{ type: string; text?: string }>)
    const payload = parseJsonPayload(text)
    if (!payload) {
      throw new Error(t('settings.scheduledTasks.invalidAiJson'))
    }

    applyGeneratedDraft(payload)
    setStatus(t('settings.scheduledTasks.aiDraftReady'))
  } catch (error) {
    setStatus(t('settings.scheduledTasks.aiGenerateFailed', { message: (error as Error).message }))
  } finally {
    aiGenerating.value = false
  }
}

onMounted(async () => {
  await loadData()
  void (async () => {
    if (!window.electronAPI) return
    try {
      const [config, modelSettings] = await Promise.all([
        window.electronAPI.getProviders?.() || Promise.resolve(null),
        window.electronAPI.getScheduledTaskModelSettings?.() || Promise.resolve(null)
      ])
      if (config) {
        providers.value = config.providers || []
        activeProviderId.value = config.activeProviderId || ''
      }
      if (modelSettings) {
        globalModel.value = {
          providerId: modelSettings.providerId || null,
          modelId: modelSettings.modelId || null
        }
      }
    } catch {
      // 供应商/执行模型加载失败不阻塞面板；下拉会退化为空列表。
    }
  })()
  if (window.electronAPI?.onScheduledTasksChanged) {
    cleanupTasksChanged = window.electronAPI.onScheduledTasksChanged((nextTasks) => {
      tasks.value = nextTasks
      if (tasks.value.length > 0 && !tasks.value.some(task => task.id === selectedTaskId.value)) {
        selectedTaskId.value = tasks.value[0].id
      }
      if (tasks.value.length === 0) {
        selectedTaskId.value = ''
      }
    })
  }
  if (window.electronAPI?.onScheduledTaskReportsChanged) {
    cleanupReportsChanged = window.electronAPI.onScheduledTaskReportsChanged((nextReports) => {
      reports.value = nextReports
      // Rust executions create their report lazily on the first tool event, so
      // the run-now response may carry no report id. Only chase that report for
      // an explicit manual run; scheduled background runs must not open a panel
      // while the user is doing something else.
      if (!activeReportId.value && selectedTaskId.value && pendingManualReportSince.value > 0) {
        const candidate = findPendingManualReport(nextReports)
        if (candidate) {
          activeReportId.value = candidate.id
          activeDetailTab.value = 'logs'
          pendingManualReportSince.value = 0
        }
      }
      if (activeReportId.value && !nextReports.some(report => report.id === activeReportId.value)) {
        activeReportId.value = null
      }
    })
  }
})

onUnmounted(() => {
  cleanupTasksChanged?.()
  cleanupReportsChanged?.()
})
</script>

<template>
  <div class="st-root">
    <header class="st-hero">
      <div class="st-hero-copy">
        <h2>{{ $t('settings.scheduledTasks.heroTitle') }}</h2>
        <p class="st-hero-summary">
          {{ $t('settings.scheduledTasks.activeTasks') }} {{ enabledTaskCount }}/{{ tasks.length }}
          <span aria-hidden="true">·</span>
          {{ $t('settings.scheduledTasks.runningTasks') }} {{ runningTaskCount }}
          <span aria-hidden="true">·</span>
          {{ $t('settings.scheduledTasks.todayRuns') }} {{ todayRunCount }}
          <template v-if="successRate !== null">
            <span aria-hidden="true">·</span>
            {{ $t('settings.scheduledTasks.successRate') }} {{ successRate }}%
          </template>
        </p>
        <div class="st-hero-meta">
          <div class="st-hero-model">
            <span class="st-hero-model-label">{{ $t('settings.scheduledTasks.executionModel') }}</span>
            <ProviderModelDropdown
              class="st-model-picker"
              :providers="schedulerProviderOptions"
              :active-provider-id="globalModel.providerId || ''"
              :selected-model="globalModel.modelId || ''"
              :title="$t('settings.scheduledTasks.followDefault')"
              @select="onExecutionModelSelect"
            />
          </div>
        </div>
      </div>
      <div class="st-hero-actions">
        <button v-if="!editing" class="st-primary-btn st-hero-create" type="button" @click="startAdd">
          <span class="st-hero-create-plus">＋</span>{{ $t('settings.scheduledTasks.createTask') }}
        </button>
      </div>
    </header>

    <div class="st-body" :class="{ 'is-editing': editing, 'has-report': reportPanelOpen }">
    <aside class="st-sidebar">
      <div class="st-sidebar-header">
        <div class="st-list-heading">
          <span class="st-list-kicker">QUEUE</span>
          <h3>{{ $t('settings.scheduledTasks.taskListTitle') }}</h3>
          <p>{{ $t('settings.scheduledTasks.taskListDescription') }}</p>
        </div>
        <span class="st-list-count">{{ filteredTasks.length }}</span>
      </div>

      <div class="st-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
          <circle cx="7" cy="7" r="4.4" />
          <path d="m10.4 10.4 3 3" stroke-linecap="round" />
        </svg>
        <input v-model="searchQuery" type="search" :placeholder="$t('settings.scheduledTasks.searchPlaceholder')" />
        <button v-if="searchQuery" class="st-search-clear" type="button" @click="searchQuery = ''">×</button>
      </div>

      <div class="st-filter-row">
        <button
          v-for="option in statusFilterOptions"
          :key="option.id"
          type="button"
          class="st-filter-chip"
          :class="{ active: statusFilter === option.id }"
          @click="statusFilter = option.id"
        >
          {{ $t(option.labelKey) }}<span>{{ option.count }}</span>
        </button>
      </div>

      <div class="st-task-list">
      <button
        v-for="task in filteredTasks"
        :key="task.id"
        type="button"
        class="st-task-card"
        :class="{ active: selectedTaskId === task.id }"
        @click="selectTask(task.id)"
      >
        <span class="st-task-rail" :class="statusClass(task.lastStatus)" aria-hidden="true"></span>
        <div class="st-task-card-top">
          <strong>{{ task.title }}</strong>
          <span class="st-task-status" :class="statusClass(task.lastStatus)">{{ statusLabel(task.lastStatus) }}</span>
        </div>
        <p class="st-task-schedule">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true">
            <circle cx="8" cy="8" r="5.4" />
            <path d="M8 4.9V8l2 1.2" />
          </svg>
          {{ scheduleSummary(task) }}
        </p>
        <div class="st-task-card-footer">
          <span class="st-task-next" :class="{ 'is-off': !task.enabled }">
            {{ task.enabled ? formatRelativeRun(taskNextRunAt(task)) : $t('settings.scheduledTasks.disabled') }}
          </span>
          <span class="st-task-origin">{{ task.createdBy === 'ai' ? 'AI' : 'MANUAL' }}</span>
        </div>
      </button>
      </div>

      <div v-if="filteredTasks.length === 0" class="st-list-empty">
        <span class="st-list-empty-mark">{{ tasks.length === 0 ? '✦' : '⌕' }}</span>
        <strong>{{ tasks.length === 0 ? $t('settings.scheduledTasks.emptyPageTitle') : $t('settings.scheduledTasks.filteredEmptyTitle') }}</strong>
        <p>{{ tasks.length === 0 ? $t('settings.scheduledTasks.emptyPageHint') : $t('settings.scheduledTasks.filteredEmptyDescription') }}</p>
        <button v-if="tasks.length === 0" class="st-primary-btn" type="button" @click="startAdd">{{ $t('settings.scheduledTasks.createTask') }}</button>
      </div>
    </aside>

    <section class="st-main">
      <div class="st-main-header">
        <div class="st-main-heading">
          <span class="st-main-kicker">{{ editing ? 'TASK BUILDER' : 'TASK DETAIL' }}</span>
          <h3>
            {{ editing
              ? (editingExistingTask ? $t('settings.scheduledTasks.editTaskHeading') : $t('settings.scheduledTasks.newTaskHeading'))
              : (selectedTask?.title || $t('settings.scheduledTasks.manageTitle')) }}
          </h3>
          <p>
            {{ editing
              ? $t('settings.scheduledTasks.editDescription')
              : (selectedTask ? scheduleSummary(selectedTask) : $t('settings.scheduledTasks.detailDescription')) }}
          </p>
        </div>

        <div v-if="editing" class="st-main-actions">
          <button class="st-ghost-btn" type="button" @click="cancelEdit">{{ $t('common.cancel') }}</button>
          <button class="st-primary-btn" type="button" @click="saveDraft" :disabled="saving">
            {{ saving ? $t('common.saving') : $t('settings.scheduledTasks.saveTask') }}
          </button>
        </div>

        <div v-else-if="selectedTask" class="st-main-actions">
          <button class="st-ghost-btn st-task-toggle-btn" type="button" @click="toggleSelectedTaskEnabled">
            {{ selectedTask.enabled ? $t('settings.scheduledTasks.disable') : $t('settings.scheduledTasks.enable') }}
          </button>
          <button class="st-primary-btn st-task-run-btn" type="button" @click="runSelectedTaskNow">▶ {{ $t('settings.scheduledTasks.runNow') }}</button>
          <button class="st-ghost-btn st-task-edit-btn" type="button" @click="startEdit">{{ $t('settings.scheduledTasks.edit') }}</button>
          <button class="st-danger-btn st-task-delete-btn" type="button" @click="deleteSelectedTask">{{ $t('common.delete') }}</button>
        </div>
      </div>

      <p v-if="statusMessage" class="st-feedback">{{ statusMessage }}</p>

      <div v-if="editing && draft" class="st-editor-layout">
        <section class="st-editor-card ai-card">
          <div class="st-section-head">
            <h4>{{ $t('settings.scheduledTasks.aiDraftSection') }}</h4>
            <span>{{ $t('settings.scheduledTasks.aiDraftSectionHint') }}</span>
          </div>
          <textarea
            v-model="aiDraftPrompt"
            rows="5"
            class="st-textarea"
            :aria-label="$t('settings.scheduledTasks.aiDraftPromptLabel')"
            :placeholder="$t('settings.scheduledTasks.aiDraftPlaceholder')"
          />
          <div class="st-editor-actions">
            <button class="st-ghost-btn" type="button" @click="aiDraftPrompt = ''">{{ $t('settings.scheduledTasks.clear') }}</button>
            <button class="st-primary-btn" type="button" @click="generateDraftWithAi" :disabled="aiGenerating">
              {{ aiGenerating ? $t('settings.scheduledTasks.generating') : $t('settings.scheduledTasks.generateDraft') }}
            </button>
          </div>
        </section>

        <section class="st-editor-card">
          <div class="st-section-head">
            <h4>{{ $t('settings.scheduledTasks.configTitle') }}</h4>
            <span>{{ $t('settings.scheduledTasks.configSubtitle') }}</span>
          </div>

          <div class="st-form-grid">
            <label class="st-field">
              <span>{{ $t('settings.scheduledTasks.taskName') }}</span>
              <input v-model="draft.title" type="text" :placeholder="$t('settings.scheduledTasks.taskNamePlaceholder')" />
            </label>

            <label class="st-field checkbox-field">
              <input v-model="draft.enabled" type="checkbox" />
              <span>{{ $t('settings.scheduledTasks.enableAfterSave') }}</span>
            </label>

            <label class="st-field full-span">
              <span>{{ $t('settings.scheduledTasks.prompt') }}</span>
              <textarea v-model="draft.prompt" rows="7" class="st-textarea" :placeholder="$t('settings.scheduledTasks.promptPlaceholder')" />
              <small class="st-field-hint">{{ $t('settings.scheduledTasks.contentSectionHint') }}</small>
            </label>

            <div class="st-schedule-block full-span">
              <span class="st-field-label">{{ $t('settings.scheduledTasks.scheduleMode') }}</span>
              <div class="st-mode-grid">
                <button
                  v-for="mode in scheduleModeOptions"
                  :key="mode.id"
                  type="button"
                  class="st-mode-option"
                  :class="{ active: draft.scheduleKind === mode.id }"
                  @click="draft.scheduleKind = mode.id"
                >
                  <span class="st-mode-icon" v-html="scheduleModeIcons[mode.id]"></span>
                  <strong>{{ $t(mode.labelKey) }}</strong>
                  <span>{{ $t(mode.detailKey) }}</span>
                </button>
              </div>

              <div class="st-schedule-panel" :class="{ 'is-interval': draft.scheduleKind === 'interval' }">
                <template v-if="draft.scheduleKind === 'daily'">
                  <label class="st-field">
                    <span>{{ $t('settings.scheduledTasks.dailyTime') }}</span>
                    <input v-model="draft.timeOfDayInput" type="time" />
                  </label>
                </template>

                <template v-else-if="draft.scheduleKind === 'weekly'">
                  <div class="st-field full-span">
                    <span>{{ $t('settings.scheduledTasks.weekday') }}</span>
                    <div class="st-weekday-grid">
                      <button
                        v-for="weekday in weekdayOptions"
                        :key="weekday.value"
                        type="button"
                        class="st-weekday-chip"
                        :class="{ active: draft.weekdays.includes(weekday.value) }"
                        @click="toggleWeekday(weekday.value)"
                      >
                        {{ $t(weekday.labelKey) }}
                      </button>
                    </div>
                  </div>
                  <label class="st-field">
                    <span>{{ $t('settings.scheduledTasks.runTime') }}</span>
                    <input v-model="draft.timeOfDayInput" type="time" />
                  </label>
                </template>

                <template v-else-if="draft.scheduleKind === 'interval'">
                  <div class="st-interval-fields full-span">
                    <div class="st-interval-row" :class="{ 'has-custom': draft.intervalPreset === 'custom' }">
                      <label class="st-field">
                        <span>{{ $t('settings.scheduledTasks.intervalTime') }}</span>
                        <select v-model="draft.intervalPreset" @change="applyIntervalPreset">
                          <option v-for="option in intervalPresetOptions" :key="option.value" :value="option.value">
                            {{ $t(option.labelKey) }}
                          </option>
                        </select>
                      </label>
                      <label v-if="draft.intervalPreset === 'custom'" class="st-field">
                        <span>{{ $t('settings.scheduledTasks.minutes') }}</span>
                        <input v-model.number="draft.everyMinutes" type="number" min="1" step="1" @input="markIntervalCustom" />
                      </label>
                    </div>
                    <label class="st-field">
                      <span>{{ $t('settings.scheduledTasks.startTime') }}</span>
                      <input v-model="draft.startAtInput" type="datetime-local" />
                    </label>
                  </div>
                </template>

                <template v-else-if="draft.scheduleKind === 'once'">
                  <label class="st-field">
                    <span>{{ $t('settings.scheduledTasks.runTime') }}</span>
                    <input v-model="draft.runAtInput" type="datetime-local" />
                  </label>
                </template>

                <template v-else>
                  <div class="st-field full-span">
                    <span>{{ $t('settings.scheduledTasks.specificDates') }}</span>
                    <div class="st-date-row">
                      <input v-model="draft.nextDateInput" type="datetime-local" />
                      <button class="st-ghost-btn" type="button" @click="addDateInput">{{ $t('settings.scheduledTasks.addDate') }}</button>
                    </div>
                    <div v-if="draft.dateInputs.length > 0" class="st-tag-list compact">
                      <button
                        v-for="dateInput in draft.dateInputs"
                        :key="dateInput"
                        type="button"
                        class="st-tag removable"
                        @click="removeDateInput(dateInput)"
                      >
                        {{ dateInput.replace('T', ' ') }} ×
                      </button>
                    </div>
                  </div>
                </template>
              </div>
            </div>

            <div class="st-retry-block full-span">
              <span class="st-field-label">{{ $t('settings.scheduledTasks.retryTitle') }}</span>
              <div class="st-retry-fields">
                <label class="st-field">
                  <span>{{ $t('settings.scheduledTasks.retryCount') }}</span>
                  <input v-model.number="draft.maxRetries" type="number" min="0" step="1" />
                </label>
                <label class="st-field">
                  <span>{{ $t('settings.scheduledTasks.retryDelay') }}</span>
                  <input v-model.number="draft.retryDelayMinutes" type="number" min="1" step="1" />
                </label>
              </div>
            </div>

            <div class="st-retry-block full-span">
              <span class="st-field-label">{{ $t('settings.scheduledTasks.taskModelTitle') }}</span>
              <div class="st-retry-fields">
                <label class="st-field">
                  <span>{{ $t('settings.scheduledTasks.taskProvider') }}</span>
                  <select v-model="draft.providerId" @change="draft.modelId = ''">
                    <option value="">{{ $t('settings.scheduledTasks.followExecutionModel') }}</option>
                    <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
                  </select>
                </label>
                <label class="st-field">
                  <span>{{ $t('settings.scheduledTasks.taskModel') }}</span>
                  <select v-model="draft.modelId" :disabled="!draft.providerId">
                    <option value="">{{ $t('settings.scheduledTasks.followProviderDefault') }}</option>
                    <option v-for="model in draftModelOptions" :key="model" :value="model">{{ model }}</option>
                  </select>
                </label>
              </div>
              <small class="st-model-hint">{{ $t('settings.scheduledTasks.taskModelHint') }}</small>
            </div>

            <div class="st-retry-block full-span">
              <span class="st-field-label">{{ $t('settings.scheduledTasks.toolPolicy') }}</span>
              <div class="st-tool-policy-options">
                <label
                  v-for="option in toolPolicyOptions"
                  :key="option.value"
                  class="st-check-item"
                  :class="{ active: draft.toolPolicy === option.value }"
                >
                  <input v-model="draft.toolPolicy" type="radio" :value="option.value" />
                  <span>
                    <strong>{{ $t(option.labelKey) }}</strong>
                    <small>{{ $t(option.detailKey) }}</small>
                  </span>
                </label>
              </div>
            </div>
          </div>

          <div class="st-scope-grid">
            <section class="st-scope-card">
              <div class="st-section-head">
                <h4>{{ $t('settings.scheduledTasks.allowedSkills') }}</h4>
                <span>{{ $t('settings.scheduledTasks.itemCount', { count: draft.selectedSkillIds.length }) }}</span>
              </div>
              <div v-if="skills.length === 0" class="st-empty-inline">{{ $t('settings.scheduledTasks.noSkills') }}</div>
              <label v-for="skill in skills" :key="skill.id" class="st-check-item">
                <input v-model="draft.selectedSkillIds" type="checkbox" :value="skill.id" />
                <span>
                  <strong>{{ skill.name }}</strong>
                  <small>{{ skill.description || skill.id }}</small>
                </span>
              </label>
            </section>

            <section class="st-scope-card">
              <div class="st-section-head">
                <h4>{{ $t('settings.scheduledTasks.allowedMcp') }}</h4>
                <span>{{ $t('settings.scheduledTasks.itemCount', { count: draft.selectedMcpServerIds.length }) }}</span>
              </div>
              <div v-if="mcpServers.length === 0" class="st-empty-inline">{{ $t('settings.scheduledTasks.noMcp') }}</div>
              <label v-for="server in mcpServers" :key="server.id" class="st-check-item">
                <input v-model="draft.selectedMcpServerIds" type="checkbox" :value="server.id" />
                <span>
                  <strong>{{ server.name }}</strong>
                  <small>{{ server.id }} · {{ server.enabled ? $t('settings.scheduledTasks.enabled') : $t('settings.scheduledTasks.disabled') }}</small>
                </span>
              </label>
            </section>
          </div>

          <div class="st-editor-actions">
            <button class="st-ghost-btn" type="button" @click="cancelEdit">{{ $t('common.cancel') }}</button>
            <button class="st-primary-btn" type="button" @click="saveDraft" :disabled="saving">
              {{ saving ? $t('common.saving') : $t('settings.scheduledTasks.saveTask') }}
            </button>
          </div>
        </section>
      </div>

      <div v-else-if="selectedTask" class="st-detail">
        <div class="st-detail-tabs">
          <button
            type="button"
            class="st-detail-tab"
            :class="{ active: activeDetailTab === 'details' }"
            @click="activeDetailTab = 'details'"
          >
            {{ $t('settings.scheduledTasks.detailsTab') }}
          </button>
          <button
            type="button"
            class="st-detail-tab"
            :class="{ active: activeDetailTab === 'logs' }"
            @click="activeDetailTab = 'logs'"
          >
            {{ $t('settings.scheduledTasks.logsTab') }}<span v-if="selectedTaskReports.length > 0" class="st-detail-tab-count">{{ selectedTaskReports.length }}</span>
          </button>
        </div>

        <section v-show="activeDetailTab === 'details'" class="st-summary-card">
          <div class="st-detail-runway" :class="statusClass(selectedTask.lastStatus)">
            <div class="st-detail-runway-copy">
              <span>{{ $t('settings.scheduledTasks.nextRunTitle') }}</span>
              <strong>{{ formatRelativeRun(selectedTask.retryScheduledAt || selectedTask.nextRunAt) }}</strong>
              <small>{{ formatTimestamp(selectedTask.retryScheduledAt || selectedTask.nextRunAt) }}</small>
            </div>
            <span class="st-status-pill" :class="statusClass(selectedTask.lastStatus)">{{ statusLabel(selectedTask.lastStatus) }}</span>
          </div>
          <div class="st-section-head">
            <h4>{{ $t('settings.scheduledTasks.overview') }}</h4>
            <span>{{ selectedTask.createdBy === 'ai' ? $t('settings.scheduledTasks.createdByAi') : $t('settings.scheduledTasks.createdByManual') }}</span>
          </div>
          <div class="st-metrics-grid">
            <div class="st-metric">
              <span>{{ $t('settings.scheduledTasks.lastRunLabel') }}</span>
              <strong>{{ formatTimestamp(selectedTask.lastRunAt) }}</strong>
            </div>
            <div class="st-metric">
              <span>{{ $t('settings.scheduledTasks.retryPolicy') }}</span>
              <strong>{{ $t('settings.scheduledTasks.retryPolicyValue', { retries: selectedTask.retryPolicy.maxRetries, minutes: selectedTask.retryPolicy.retryDelayMinutes }) }}</strong>
            </div>
            <div class="st-metric">
              <span>{{ $t('settings.scheduledTasks.taskModelTitle') }}</span>
              <strong>{{ taskModelLabel(selectedTask) }}</strong>
            </div>
          </div>
          <div class="st-summary-block">
            <strong>{{ $t('settings.scheduledTasks.taskPromptTitle') }}</strong>
            <div class="st-prompt-md markdown-body" v-html="renderMarkdown(selectedTask.prompt)"></div>
          </div>
          <div class="st-section-head st-resources-head">
            <h4>{{ $t('settings.scheduledTasks.resourcesTitle') }}</h4>
            <span>{{ selectedTask.selectedSkillIds.length }} Skill · {{ selectedTask.selectedMcpServerIds.length }} MCP</span>
          </div>
          <div class="st-scope-summary-grid">
            <div class="st-summary-block">
              <strong>{{ $t('settings.scheduledTasks.skillLimit') }}</strong>
              <div class="st-tag-list">
                <span v-for="skillId in selectedTask.selectedSkillIds" :key="skillId" class="st-tag">{{ skillNameMap.get(skillId) || skillId }}</span>
                <span v-if="selectedTask.selectedSkillIds.length === 0" class="st-empty-inline">{{ $t('settings.scheduledTasks.unlimited') }}</span>
              </div>
            </div>
            <div class="st-summary-block">
              <strong>{{ $t('settings.scheduledTasks.mcpLimit') }}</strong>
              <div class="st-tag-list">
                <span v-for="serverId in selectedTask.selectedMcpServerIds" :key="serverId" class="st-tag">{{ mcpNameMap.get(serverId) || serverId }}</span>
                <span v-if="selectedTask.selectedMcpServerIds.length === 0" class="st-empty-inline">{{ $t('settings.scheduledTasks.unlimited') }}</span>
              </div>
            </div>
            <div class="st-summary-block">
              <strong>{{ $t('settings.scheduledTasks.toolPolicy') }}</strong>
              <p>{{ selectedTask.toolPolicy === 'autoApprove' ? $t('settings.scheduledTasks.toolPolicySummaryAutoApprove') : $t('settings.scheduledTasks.toolPolicySummaryStandard') }}</p>
            </div>
          </div>
        </section>

        <section v-show="activeDetailTab === 'logs'" class="st-report-card">
          <div class="st-section-head">
            <h4>{{ $t('settings.scheduledTasks.logsTab') }}</h4>
            <span>{{ $t('settings.scheduledTasks.recordCount', { count: selectedTaskReports.length }) }}</span>
          </div>
          <div class="st-report-scroll">
            <div v-if="selectedTaskReports.length === 0" class="st-report-empty">
              <span>◷</span>
              <strong>{{ $t('settings.scheduledTasks.noReports') }}</strong>
              <p>{{ $t('settings.scheduledTasks.runHistoryEmpty') }}</p>
            </div>
            <button
              v-for="report in selectedTaskReports"
              :key="report.id"
              type="button"
              class="st-report-item"
              :class="[reportStatusClass(report.status), { 'is-selected': activeReportId === report.id }]"
              :aria-pressed="activeReportId === report.id"
              @click="openReport(report.id)"
            >
              <div class="st-report-item-top">
                <strong>{{ runStatusLabel(report.status) }}</strong>
                <span>{{ formatTimestamp(report.startedAt) }}</span>
              </div>
              <p>{{ report.summary }}</p>
              <div class="st-report-item-meta">
                <span>{{ report.trigger === 'manual' ? $t('settings.scheduledTasks.manualTrigger') : $t('settings.scheduledTasks.scheduledTrigger') }}</span>
                <span>{{ $t('settings.scheduledTasks.attemptCount', { count: report.attempt }) }}</span>
                <span class="st-report-open">{{ $t('settings.scheduledTasks.viewReport') }} →</span>
              </div>
            </button>
          </div>
        </section>
      </div>

      <div v-else class="st-onboarding">
        <div class="st-onboarding-art" aria-hidden="true">
          <span class="st-onboarding-ring ring-one"></span>
          <span class="st-onboarding-ring ring-two"></span>
          <span class="st-onboarding-core">
            <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="15" cy="16" r="8.5" />
              <path d="M15 10.5V16l3.6 2.2" />
              <path d="m25.2 4.2.8 2.3 2.3.8-2.3.8-.8 2.3-.8-2.3-2.3-.8 2.3-.8.8-2.3Z" fill="currentColor" stroke="none" />
            </svg>
          </span>
        </div>
        <span class="st-onboarding-kicker">{{ $t('settings.scheduledTasks.heroEyebrow') }}</span>
        <h3>{{ tasks.length === 0 ? $t('settings.scheduledTasks.emptyPageTitle') : $t('settings.scheduledTasks.emptySelectionTitle') }}</h3>
        <p>{{ tasks.length === 0 ? $t('settings.scheduledTasks.emptyPageDescription') : $t('settings.scheduledTasks.emptySelectionDescription') }}</p>
        <div class="st-onboarding-points">
          <span>{{ $t('settings.scheduledTasks.modeDaily') }}</span>
          <span>{{ $t('settings.scheduledTasks.retryTitle') }}</span>
          <span>{{ $t('settings.scheduledTasks.logsTab') }}</span>
        </div>
        <button v-if="tasks.length === 0" class="st-primary-btn st-onboarding-cta" type="button" @click="startAdd">
          ＋ {{ $t('settings.scheduledTasks.createTask') }}
        </button>
        <small v-if="tasks.length === 0">{{ $t('settings.scheduledTasks.emptyPageHint') }}</small>
      </div>
    </section>

    <ScheduledTaskReportPanel
      v-if="activeReport"
      :key="activeReport.id"
      :report="activeReport"
      @close="closeReportPanel"
    />
    </div>
  </div>
</template>

<style scoped>
.st-root {
  display: grid;
  grid-template-columns: minmax(248px, 284px) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--app-main-surface);
}

.st-root * {
  box-sizing: border-box;
  min-width: 0;
}

.st-sidebar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-right: 1px solid var(--app-border);
  overflow-y: auto;
}

.st-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  overflow-y: auto;
  container-type: inline-size;
}

.st-sidebar-header,
.st-main-header,
.st-section-head,
.st-task-card-top,
.st-report-item-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.st-main-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 7px;
}

.st-sidebar-header .st-primary-btn {
  flex: 0 0 auto;
}

.st-sidebar-header h3,
.st-main-header h3,
.st-section-head h4,
.st-task-card strong,
.st-metric strong {
  margin: 0;
  color: var(--app-text);
}

/* 分类头：accent 竖条锚点 + 标题/说明基线对齐 */
.st-section-head {
  align-items: center;
}

.st-section-head h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.92rem;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.st-section-head h4::before {
  content: '';
  flex: 0 0 auto;
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: linear-gradient(180deg, #0284c7, #38bdf8);
}

.st-sidebar-header p,
.st-main-header p,
.st-task-card p,
.st-empty-list,
.st-empty-main,
.st-empty-inline,
.st-check-item small,
.st-report-item p,
.st-task-card-meta,
.st-report-item-meta,
.st-metric span,
.st-summary-block p {
  margin: 0;
  color: var(--app-text-soft);
  font-size: 0.82rem;
  line-height: 1.55;
}

.st-primary-btn,
.st-ghost-btn,
.st-danger-btn,
.st-task-card,
.st-report-item,
.st-tag.removable {
  border-radius: 8px;
  border: 1px solid var(--app-border);
  transition: border-color 0.12s ease, background 0.12s ease, color 0.12s ease;
}

.st-primary-btn,
.st-ghost-btn,
.st-danger-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 7px 11px;
  font-size: 0.82rem;
  line-height: 1.2;
  cursor: pointer;
  white-space: nowrap;
}

.st-primary-btn {
  color: #f8fbff;
  background: linear-gradient(135deg, #0284c7, #0ea5e9);
  border-color: transparent;
}

.st-ghost-btn {
  color: var(--app-text);
  background: rgba(255, 255, 255, 0.04);
}

.st-danger-btn {
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.08);
}

.st-primary-btn:hover,
.st-ghost-btn:hover,
.st-danger-btn:hover,
.st-task-card:hover,
.st-report-item:hover,
.st-tag.removable:hover {
  border-color: rgba(14, 165, 233, 0.35);
}

.st-feedback,
.st-empty-main,
.st-empty-list,
.st-editor-card,
.st-summary-card,
.st-report-card {
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(10px);
}

.st-feedback,
.st-empty-main,
.st-empty-list {
  padding: 12px 14px;
}

.st-feedback {
  margin: 0;
  color: #075985;
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(14, 165, 233, 0.24);
}

.st-task-card,
.st-report-item {
  width: 100%;
  padding: 11px 12px;
  background: rgba(255, 255, 255, 0.03);
  text-align: left;
  cursor: pointer;
}

.st-task-card.active {
  border-color: rgba(14, 165, 233, 0.45);
  background: rgba(14, 165, 233, 0.1);
}

.st-status-pill,
.st-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.04);
  font-size: 0.76rem;
}

.st-status-pill.is-completed {
  color: #166534;
  background: rgba(34, 197, 94, 0.12);
}

.st-status-pill.is-failed {
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.12);
}

.st-status-pill.is-retrying {
  color: #92400e;
  background: rgba(250, 204, 21, 0.16);
}

.st-status-pill.is-running {
  color: #155e75;
  background: rgba(45, 212, 191, 0.15);
}

.st-status-pill.is-idle {
  color: var(--app-text-soft);
}

.st-task-card-meta,
.st-report-item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
}

.st-task-card-meta.muted {
  margin-top: 8px;
}

.st-editor-layout,
.st-scope-grid,
.st-scope-summary-grid,
.st-metrics-grid,
.st-form-grid {
  display: grid;
  gap: 12px;
}

.st-editor-layout {
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
}

.st-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.st-detail-tabs {
  display: flex;
  gap: 6px;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.03);
}

.st-detail-tab {
  position: relative;
  flex: 1 1 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 7px 12px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--app-text-soft);
  font-size: 0.84rem;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease, color 0.12s ease;
}

.st-detail-tab:hover {
  color: var(--app-text);
  background: rgba(255, 255, 255, 0.04);
}

.st-detail-tab.active {
  color: #f8fbff;
  background: linear-gradient(135deg, #0284c7, #0ea5e9);
  border-color: transparent;
}

.st-detail-tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  font-size: 0.72rem;
  line-height: 1;
}

.st-form-grid,
.st-metrics-grid {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.st-scope-grid,
.st-scope-summary-grid {
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.st-editor-card,
.st-summary-card,
.st-report-card,
.st-scope-card {
  padding: 14px;
}

.st-editor-card,
.st-summary-card,
.st-report-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.st-editor-card.ai-card {
  position: static;
}

.st-section-head span {
  color: var(--app-text-faint);
  font-size: 0.76rem;
  line-height: 1.4;
  text-align: right;
}

.full-span {
  grid-column: 1 / -1;
}

.st-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 0.84rem;
  color: var(--app-text);
}

.st-field-label {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--app-text);
}

.st-field-label::before {
  content: '';
  flex: 0 0 auto;
  width: 3px;
  height: 12px;
  border-radius: 2px;
  background: linear-gradient(180deg, #0284c7, #38bdf8);
}

.st-field.checkbox-field {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  align-self: end;
}

.st-field.checkbox-field input,
.st-check-item input {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-top: 2px;
}

.st-field input,
.st-field select,
.st-textarea {
  width: 100%;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--app-text);
  padding: 10px 12px;
  font: inherit;
  box-sizing: border-box;
}

.st-textarea {
  resize: vertical;
}

.st-date-row,
.st-editor-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.st-date-row {
  margin-top: 8px;
}

.st-date-row input {
  flex: 1 1 220px;
}

.st-schedule-block {
  min-width: 0;
}

.st-interval-fields,
.st-retry-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
}

.st-interval-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  align-items: end;
}

.st-interval-row.has-custom {
  grid-template-columns: minmax(0, 1fr) minmax(96px, 132px);
}

.st-retry-block {
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.025);
}

.st-model-bar {
  display: flex;
  gap: 6px;
  align-items: center;
}

.st-model-bar .st-model-picker {
  flex: 1 1 auto;
  min-width: 0;
}

/* 触发器占满剩余宽度，与上下任务卡片对齐；高度与新建按钮一致。 */
.st-model-bar :deep(.provider-model-trigger) {
  width: 100%;
  max-width: none;
  height: 30px;
  padding: 0 10px;
}

.st-add-btn {
  flex: 0 0 auto;
  padding: 5px 10px;
  font-size: 0.8rem;
  white-space: nowrap;
}

.st-model-hint {
  display: block;
  font-size: 12px;
  opacity: 0.65;
  line-height: 1.5;
}

.st-mode-grid,
.st-schedule-panel,
.st-weekday-grid {
  display: grid;
  gap: 10px;
}

.st-mode-grid {
  grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
}

.st-mode-option,
.st-weekday-chip {
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.03);
  color: var(--app-text);
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease, color 0.12s ease;
}

.st-mode-option {
  min-height: 56px;
  padding: 9px 10px;
  text-align: left;
}

.st-mode-option strong,
.st-mode-option span {
  display: block;
}

.st-mode-option strong {
  margin-bottom: 4px;
  font-size: 0.86rem;
}

.st-mode-option span {
  color: var(--app-text-faint);
  font-size: 0.74rem;
  line-height: 1.35;
}

.st-mode-option.active,
.st-weekday-chip.active {
  border-color: rgba(14, 165, 233, 0.55);
  background: rgba(14, 165, 233, 0.12);
  color: var(--app-accent);
}

.st-schedule-panel {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  align-items: end;
  margin-top: 10px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.025);
}

.st-schedule-panel.is-interval {
  grid-template-columns: minmax(0, 1fr);
}

.st-weekday-grid {
  grid-template-columns: repeat(auto-fit, minmax(64px, 1fr));
}

.st-weekday-chip {
  min-height: 34px;
  padding: 7px 8px;
  font: inherit;
  font-size: 0.8rem;
}

.st-check-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--app-border);
}

.st-tool-policy-options {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.st-tool-policy-options .st-check-item {
  padding: 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
}

.st-tool-policy-options .st-check-item.active {
  border-color: rgba(14, 165, 233, 0.55);
  background: rgba(14, 165, 233, 0.08);
}

.st-check-item:last-child {
  border-bottom: none;
}

.st-check-item span {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-wrap: anywhere;
}

.st-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.st-tag.removable {
  cursor: pointer;
  background: rgba(255, 255, 255, 0.04);
}

.st-summary-block,
.st-metric,
.st-scope-card {
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.03);
}

.st-scope-card {
  max-height: 260px;
  overflow-y: auto;
}

.st-summary-block,
.st-metric {
  padding: 12px;
}

.st-summary-block pre {
  margin: 10px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--app-text);
  font-size: 0.82rem;
  line-height: 1.6;
}

.st-prompt-md {
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.025);
  color: var(--app-text);
  font-size: 0.82rem;
  line-height: 1.6;
  overflow-x: auto;
}

.st-report-item + .st-report-item {
  margin-top: 0;
}

@container (min-width: 1080px) {
  .st-editor-layout {
    grid-template-columns: minmax(0, 0.9fr) minmax(480px, 1fr);
  }
}

@media (max-width: 880px) {
  .st-root {
    grid-template-columns: 1fr;
  }

  .st-sidebar {
    border-right: none;
    border-bottom: 1px solid var(--app-border);
    max-height: 240px;
  }

  .st-form-grid,
  .st-metrics-grid,
  .st-scope-grid,
  .st-scope-summary-grid,
  .st-interval-row {
    grid-template-columns: 1fr;
  }
}
</style>

<style scoped>
/* Final cascade: keep the compact workspace authoritative. */
.st-root .st-hero {
  align-items: center;
  gap: 14px;
  padding: 10px 18px;
  background: var(--app-panel);
}

.st-root .st-hero-copy {
  flex: 1;
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  max-width: none;
}

.st-root .st-hero h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.st-root .st-hero-copy > p {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  max-width: none;
  margin: 0;
  color: var(--app-text-faint);
  font-size: 0.66rem;
  line-height: 1.3;
}

.st-root .st-hero-meta {
  gap: 7px;
  margin: 0 0 0 auto;
  flex-wrap: nowrap;
}

.st-root .st-hero-model {
  height: 31px;
  padding: 2px 3px 2px 9px;
}

.st-root .st-hero-actions {
  padding: 0;
}

.st-root .st-hero-create {
  min-height: 32px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 0.73rem;
}

.st-root .st-body {
  grid-template-columns: minmax(300px, 340px) minmax(0, 1fr);
  gap: 0;
  padding: 0;
}

.st-root .st-sidebar {
  gap: 8px;
  padding: 10px 12px;
  border: 0;
  border-right: 1px solid var(--app-border);
  border-radius: 0;
  background: var(--app-panel);
  box-shadow: none;
}

.st-root .st-sidebar-header {
  align-items: center;
  padding: 2px 2px 4px;
}

.st-root .st-sidebar-header h3 {
  margin: 0;
  font-size: 0.87rem;
}

.st-root .st-sidebar-header p {
  display: none;
}

.st-root .st-search {
  height: 31px;
}

.st-root .st-filter-row {
  gap: 2px;
  padding: 0;
  border: 0;
  background: transparent;
}

.st-root .st-filter-chip {
  min-height: 24px;
  padding: 2px 5px;
  font-size: 0.63rem;
}

.st-root .st-task-list {
  gap: 1px;
  margin: 0 -4px;
  padding: 0 4px 4px;
}

.st-root .st-task-card {
  padding: 9px 9px 8px 13px;
  border-radius: 9px;
}

.st-root .st-task-card strong {
  font-size: 0.81rem;
}

.st-root .st-task-schedule {
  margin-top: 4px;
  font-size: 0.69rem;
}

.st-root .st-main {
  padding: 13px 18px;
  border: 0;
  border-radius: 0;
  background: var(--app-main-surface);
}

.st-root .st-main-header {
  gap: 12px;
  padding-bottom: 9px;
}

.st-root .st-main-header h3 {
  margin-top: 0;
  font-size: 1.04rem;
  font-weight: 650;
  line-height: 1.25;
}

.st-root .st-main-header p {
  margin-top: 2px;
  font-size: 0.68rem;
  line-height: 1.4;
}

.st-root .st-main-actions {
  gap: 5px;
}

.st-root .st-main-actions .st-primary-btn,
.st-root .st-main-actions .st-ghost-btn,
.st-root .st-main-actions .st-danger-btn {
  min-height: 30px;
  padding: 5px 10px;
  font-size: 0.69rem;
}

.st-root .st-detail {
  gap: 8px;
}

.st-root .st-detail-tabs {
  padding: 2px;
  border-radius: 8px;
}

.st-root .st-detail-tab {
  min-height: 24px;
  padding: 3px 10px;
  font-size: 0.66rem;
}

.st-root .st-summary-card,
.st-root .st-report-card {
  gap: 9px;
  padding: 12px;
  border-radius: 11px;
}

.st-root .st-detail-runway {
  padding: 9px 12px;
  border-radius: 9px;
}

.st-root .st-detail-runway-copy {
  flex-direction: row;
  align-items: baseline;
  gap: 8px;
}

.st-root .st-detail-runway-copy span {
  font-size: 0.62rem;
}

.st-root .st-detail-runway-copy strong {
  font-size: 0.93rem;
  letter-spacing: -0.01em;
}

.st-root .st-detail-runway-copy small {
  font-size: 0.6rem;
}

.st-root .st-status-pill {
  padding: 3px 8px;
  font-size: 0.6rem;
}

.st-root .st-metrics-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: 9px;
}

.st-root .st-metric {
  gap: 2px;
  padding: 7px 9px;
  border: 0;
  border-right: 1px solid var(--app-border);
  border-radius: 0;
  background: transparent;
}

.st-root .st-metric:last-child {
  border-right: 0;
}

.st-root .st-section-head h4 {
  font-size: 0.78rem;
}

.st-root .st-section-head > span {
  font-size: 0.61rem;
}

.st-root .st-summary-block {
  padding: 8px 10px;
  border-radius: 8px;
}

.st-root .st-summary-block > strong {
  margin-bottom: 3px;
  font-size: 0.64rem;
}

.st-root .st-prompt-md {
  padding: 8px 10px;
  font-size: 0.71rem;
  line-height: 1.55;
}

.st-root .st-scope-summary-grid {
  gap: 6px;
}

.st-root .st-editor-layout {
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
}

.st-root .st-editor-card {
  gap: 11px;
  padding: 13px;
  border-radius: 11px;
}

.st-root .st-form-grid {
  gap: 10px;
}

.st-root .st-mode-option {
  min-height: 62px;
  padding: 8px;
}

.st-root .st-schedule-panel,
.st-root .st-retry-block {
  padding: 9px;
}

.st-root .st-scope-card {
  max-height: 196px;
  padding: 9px;
}

.st-root .st-editor-card.ai-card .st-textarea {
  min-height: 72px;
}

.st-root .st-body.is-editing {
  display: block;
}

.st-root .st-body.is-editing .st-sidebar {
  display: none;
}

.st-root .st-body.is-editing .st-main {
  height: 100%;
}

.st-root .st-body.is-editing .st-editor-layout {
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  max-width: 1240px;
  margin: 0 auto;
}

.st-root .st-body.is-editing .st-editor-layout > .st-editor-card.ai-card {
  position: static;
  order: -1;
}

@media (max-width: 1080px) {
  .st-root .st-hero-meta {
    flex-wrap: wrap;
    margin-left: 0;
  }

  .st-root .st-hero-copy {
    flex-direction: column;
    align-items: flex-start;
  }

  .st-root .st-hero {
    align-items: flex-start;
  }
}

@media (max-width: 980px) {
  .st-root .st-body {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }

  .st-root .st-sidebar {
    max-height: 250px;
    border-right: 0;
    border-bottom: 1px solid var(--app-border);
  }

  .st-root .st-main {
    min-height: 420px;
  }

  .st-root .st-metrics-grid {
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  }
}

@media (max-width: 760px) {
  .st-root .st-hero {
    padding: 9px 12px;
  }

  .st-root .st-main {
    padding: 11px 12px;
  }

  .st-root .st-form-grid,
  .st-root .st-scope-grid,
  .st-root .st-interval-fields,
  .st-root .st-retry-fields,
  .st-root .st-mode-grid {
    grid-template-columns: 1fr;
  }
}
</style>

<style scoped>
/* ── Compact workspace pass (ZCode-like density) ────────────────────── */
.st-root .st-hero {
  align-items: center;
  gap: 14px;
  padding: 10px 18px;
  background: var(--app-panel);
}

.st-root .st-hero::after,
.st-root .st-hero-orb,
.st-root .st-hero-kicker {
  display: none;
}

.st-root .st-hero-copy {
  flex: 1;
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  max-width: none;
}

.st-root .st-hero h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.st-root .st-hero-copy > p {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  max-width: none;
  margin: 0;
  color: var(--app-text-faint);
  font-size: 0.66rem;
  line-height: 1.3;
}

.st-hero-copy > p span {
  opacity: 0.5;
}

.st-root .st-hero-meta {
  gap: 7px;
  margin: 0 0 0 auto;
  flex-wrap: nowrap;
}

.st-root .st-hero-model {
  height: 31px;
  padding: 2px 3px 2px 9px;
}

.st-root .st-hero-model-label {
  font-size: 0.61rem;
}

.st-root .st-hero-model :deep(.provider-model-trigger) {
  height: 23px;
  font-size: 0.67rem;
}

.st-root .st-hero-next {
  min-height: 27px;
  padding: 0 10px;
  font-size: 0.65rem;
  white-space: nowrap;
}

.st-root .st-hero-actions {
  padding: 0;
}

.st-root .st-hero-create {
  min-height: 32px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 0.73rem;
}

.st-root .st-stats {
  display: none;
}

.st-root .st-body {
  grid-template-columns: minmax(300px, 340px) minmax(0, 1fr);
  gap: 0;
  padding: 0;
}

.st-root .st-sidebar {
  gap: 8px;
  padding: 10px 12px;
  border: 0;
  border-right: 1px solid var(--app-border);
  border-radius: 0;
  background: var(--app-panel);
  box-shadow: none;
}

.st-root .st-sidebar-header {
  align-items: center;
  padding: 2px 2px 4px;
}

.st-root .st-list-kicker {
  display: none;
}

.st-root .st-sidebar-header h3 {
  margin: 0;
  font-size: 0.87rem;
}

.st-root .st-sidebar-header p {
  display: none;
}

.st-root .st-search {
  height: 31px;
}

.st-root .st-filter-row {
  gap: 2px;
  padding: 0;
  border: 0;
  background: transparent;
}

.st-root .st-filter-chip {
  min-height: 24px;
  padding: 2px 5px;
  font-size: 0.63rem;
}

.st-root .st-filter-chip span {
  background: transparent;
}

.st-root .st-task-list {
  gap: 1px;
  margin: 0 -4px;
  padding: 0 4px 4px;
}

.st-root .st-task-card {
  padding: 9px 9px 8px 13px;
  border-radius: 9px;
}

.st-root .st-task-card strong {
  font-size: 0.81rem;
}

.st-root .st-task-schedule {
  margin-top: 4px;
  font-size: 0.69rem;
}

.st-task-card-footer {
  margin-top: 5px;
}

.st-root .st-main {
  padding: 13px 18px;
  border: 0;
  border-radius: 0;
  background: var(--app-main-surface);
}

.st-root .st-main-header {
  gap: 12px;
  padding-bottom: 9px;
}

.st-root .st-main-kicker {
  display: none;
}

.st-root .st-main-header h3 {
  margin-top: 0;
  font-size: 1.04rem;
  font-weight: 650;
  line-height: 1.25;
}

.st-root .st-main-header p {
  margin-top: 2px;
  font-size: 0.68rem;
  line-height: 1.4;
}

.st-root .st-main-actions {
  gap: 5px;
}

.st-root .st-main-actions .st-primary-btn,
.st-root .st-main-actions .st-ghost-btn,
.st-root .st-main-actions .st-danger-btn {
  min-height: 30px;
  padding: 5px 10px;
  font-size: 0.69rem;
}

.st-root .st-detail {
  gap: 8px;
}

.st-root .st-detail-tabs {
  padding: 2px;
  border-radius: 8px;
}

.st-root .st-detail-tab {
  min-height: 24px;
  padding: 3px 10px;
  font-size: 0.66rem;
}

.st-root .st-summary-card,
.st-root .st-report-card {
  gap: 9px;
  padding: 12px;
  border-radius: 11px;
}

.st-root .st-detail-runway {
  padding: 9px 12px;
  border-radius: 9px;
}

.st-detail-runway-copy {
  flex-direction: row;
  align-items: baseline;
  gap: 8px;
}

.st-detail-runway-copy span {
  font-size: 0.62rem;
}

.st-detail-runway-copy strong {
  font-size: 0.93rem;
  letter-spacing: -0.01em;
}

.st-detail-runway-copy small {
  font-size: 0.6rem;
}

.st-root .st-status-pill {
  padding: 3px 8px;
  font-size: 0.6rem;
}

.st-root .st-metrics-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: 9px;
}

.st-root .st-metric {
  gap: 2px;
  padding: 7px 9px;
  border: 0;
  border-right: 1px solid var(--app-border);
  border-radius: 0;
  background: transparent;
}

.st-root .st-metric:last-child {
  border-right: 0;
}

.st-root .st-metric span {
  font-size: 0.57rem;
}

.st-root .st-metric strong {
  font-size: 0.67rem;
}

.st-root .st-section-head h4 {
  font-size: 0.78rem;
}

.st-root .st-section-head > span {
  font-size: 0.61rem;
}

.st-root .st-summary-block {
  padding: 8px 10px;
  border-radius: 8px;
}

.st-root .st-summary-block > strong {
  margin-bottom: 3px;
  font-size: 0.64rem;
}

.st-root .st-prompt-md {
  padding: 8px 10px;
  font-size: 0.71rem;
  line-height: 1.55;
}

.st-root .st-scope-summary-grid {
  gap: 6px;
}

.st-root .st-resources-head {
  margin-top: 0;
}

.st-root .st-resources-head h4 {
  font-size: 0.7rem;
}

.st-root .st-editor-layout {
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
}

.st-body.is-editing {
  display: block;
}

.st-root .st-body.is-editing .st-sidebar {
  display: none;
}

.st-root .st-body.is-editing .st-main {
  height: 100%;
}

.st-root .st-body.is-editing .st-main-header {
  width: 100%;
  max-width: 1240px;
  margin: 0 auto;
}

.st-root .st-body.is-editing .st-editor-layout {
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  max-width: 1240px;
  margin: 0 auto;
}

.st-root .st-body.is-editing .st-editor-layout > .st-editor-card.ai-card {
  position: static;
  order: -1;
}

.st-root .st-editor-card {
  gap: 11px;
  padding: 13px;
  border-radius: 11px;
}

.st-root .st-editor-card.ai-card .st-textarea {
  min-height: 72px;
}

.st-root .st-form-grid {
  gap: 10px;
}

.st-root .st-mode-option {
  min-height: 62px;
  padding: 8px;
}

.st-root .st-schedule-panel,
.st-root .st-retry-block {
  padding: 9px;
}

.st-root .st-scope-card {
  max-height: 196px;
  padding: 9px;
}

@media (max-width: 1080px) {
  .st-root .st-hero-meta {
    flex-wrap: wrap;
    margin-left: 0;
  }

  .st-root .st-hero-copy {
    flex-direction: column;
    align-items: flex-start;
  }

  .st-root .st-hero {
    align-items: flex-start;
  }
}

@media (max-width: 980px) {
  .st-root .st-body {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }

  .st-root .st-sidebar {
    max-height: 250px;
    border-right: 0;
    border-bottom: 1px solid var(--app-border);
  }

  .st-root .st-main {
    min-height: 420px;
  }

  .st-root .st-metrics-grid {
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  }
}

@media (max-width: 760px) {
  .st-root .st-hero {
    padding: 9px 12px;
  }

  .st-root .st-hero-actions {
    width: auto;
  }

  .st-root .st-hero-create {
    width: auto;
  }

  .st-root .st-main {
    padding: 11px 12px;
  }

  .st-root .st-form-grid,
  .st-root .st-scope-grid,
  .st-root .st-interval-fields,
  .st-root .st-retry-fields,
  .st-root .st-mode-grid {
    grid-template-columns: 1fr;
  }
}
</style>

<style scoped>
/* ── Automation workbench ───────────────────────────────────────────── */
.st-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  color: var(--app-text);
  background:
    radial-gradient(95% 62% at 100% 0%, color-mix(in srgb, var(--app-accent) 10%, transparent), transparent 62%),
    var(--app-main-surface);
}

.st-root button,
.st-root input,
.st-root textarea,
.st-root select {
  font-family: inherit;
}

.st-root :focus-visible {
  outline: 2px solid color-mix(in srgb, var(--app-accent) 72%, transparent);
  outline-offset: 2px;
}

.st-root .st-hero {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 22px 26px 34px;
  overflow: hidden;
  border-bottom: 1px solid var(--app-border);
  background:
    linear-gradient(118deg, color-mix(in srgb, var(--app-accent) 11%, transparent), transparent 42%),
    linear-gradient(180deg, var(--app-panel-strong), var(--app-panel));
}

.st-hero::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(color-mix(in srgb, var(--app-border) 66%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--app-border) 66%, transparent) 1px, transparent 1px);
  background-size: 30px 30px;
  mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.55), transparent 86%);
}

.st-hero-orb {
  position: absolute;
  top: -170px;
  right: 4%;
  width: 390px;
  height: 390px;
  border-radius: 50%;
  pointer-events: none;
  background: radial-gradient(circle, var(--app-accent-glow), transparent 66%);
  filter: blur(8px);
}

.st-hero-copy {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 760px;
}

.st-hero-kicker {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--app-accent-strong);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.17em;
}

.st-hero-spark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 6px;
  color: var(--app-text-strong);
  background: var(--app-sig);
  box-shadow: 0 0 18px var(--app-accent-glow);
  font-size: 0.66rem;
}

.st-hero h2 {
  margin: 9px 0 0;
  color: var(--app-text-strong);
  font-size: clamp(1.55rem, 2.4vw, 2rem);
  font-weight: 650;
  letter-spacing: -0.025em;
  line-height: 1.1;
}

.st-hero-copy > p {
  max-width: 640px;
  margin: 8px 0 0;
  color: var(--app-text-muted);
  font-size: 0.84rem;
  line-height: 1.6;
}

.st-hero-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.st-hero-model {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 5px 4px 10px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-panel-strong) 72%, transparent);
  backdrop-filter: blur(14px);
}

.st-hero-model-label {
  color: var(--app-text-faint);
  font-size: 0.66rem;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.st-hero-model :deep(.provider-model-trigger) {
  height: 26px;
  max-width: 250px;
  padding: 0 9px;
  border: 0;
  border-radius: 999px;
  color: var(--app-text-soft);
  background: var(--app-panel-muted);
  font-size: 0.72rem;
}

.st-hero-next {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--app-success) 24%, var(--app-border));
  border-radius: 999px;
  color: var(--app-text-soft);
  background: color-mix(in srgb, var(--app-success-soft) 58%, transparent);
  font-size: 0.72rem;
}

.st-hero-next.is-muted {
  color: var(--app-text-faint);
  border-color: var(--app-border);
  background: var(--app-panel-muted);
}

.st-hero-next-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--app-success);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--app-success) 12%, transparent);
}

.st-hero-actions {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  padding-top: 4px;
}

.st-root .st-primary-btn,
.st-root .st-ghost-btn,
.st-root .st-danger-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 36px;
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 0.8rem;
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  transition: transform 0.14s ease, border-color 0.14s ease, background 0.14s ease, color 0.14s ease, box-shadow 0.14s ease;
}

.st-root .st-primary-btn {
  color: #fff;
  border: 1px solid color-mix(in srgb, var(--app-accent-strong) 55%, transparent);
  background: linear-gradient(135deg, var(--app-accent), var(--app-accent-strong));
  box-shadow: 0 8px 22px var(--app-accent-glow);
}

.st-root .st-primary-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 11px 26px var(--app-accent-glow);
}

.st-root .st-primary-btn:disabled {
  cursor: default;
  opacity: 0.55;
  box-shadow: none;
}

.st-root .st-ghost-btn {
  color: var(--app-text-soft);
  border: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.st-root .st-ghost-btn:hover {
  color: var(--app-text-strong);
  border-color: var(--app-border-strong);
  background: var(--app-panel-subtle);
}

.st-root .st-danger-btn {
  color: var(--app-danger);
  border: 1px solid color-mix(in srgb, var(--app-danger) 24%, var(--app-border));
  background: var(--app-danger-soft);
}

.st-root .st-danger-btn:hover {
  color: var(--app-text-strong);
  border-color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 22%, transparent);
}

.st-root .st-hero-create {
  min-height: 40px;
  padding: 10px 17px;
  border-radius: 11px;
  font-size: 0.82rem;
}

.st-hero-create-plus {
  font-size: 1rem;
  font-weight: 400;
  line-height: 1;
}

.st-root .st-stats {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: -17px 24px 0;
}

.st-root .st-stat-card {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  min-height: 86px;
  padding: 14px 15px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-panel-strong) 82%, transparent);
  box-shadow: var(--shadow-1);
  backdrop-filter: blur(18px);
}

.st-stat-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 33px;
  height: 33px;
  border-radius: 10px;
  color: var(--app-accent-strong);
  background: var(--app-accent-soft);
}

.st-stat-icon :deep(svg) {
  width: 18px;
  height: 18px;
}

.st-stat-icon.is-running {
  color: #2dd4bf;
  background: rgba(45, 212, 191, 0.12);
}

.st-stat-icon.is-today {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.12);
}

.st-stat-icon.is-success {
  color: var(--app-success);
  background: var(--app-success-soft);
}

.st-stat-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.st-stat-label {
  color: var(--app-text-muted);
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.035em;
}

.st-stat-value {
  display: flex;
  align-items: baseline;
  gap: 3px;
  margin-top: 3px;
  color: var(--app-text-strong);
  font-size: 1.32rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.st-stat-value small {
  color: var(--app-text-faint);
  font-size: 0.66rem;
  font-weight: 500;
}

.st-stat-note {
  margin-top: 3px;
  color: var(--app-text-faint);
  font-size: 0.64rem;
}

.st-stat-track {
  display: block;
  width: 100%;
  height: 3px;
  margin-top: 7px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--app-border);
}

.st-stat-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--app-sig);
  transition: width 0.35s ease;
}

.st-root .st-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(286px, 330px) minmax(0, 1fr);
  gap: 14px;
  padding: 14px 24px 22px;
  overflow: hidden;
}

.st-root .st-sidebar {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-height: 0;
  padding: 14px;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: var(--app-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
}

.st-root .st-sidebar-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 1px 2px 4px;
}

.st-list-heading {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.st-list-kicker {
  color: var(--app-text-faint);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.56rem;
  font-weight: 700;
  letter-spacing: 0.16em;
}

.st-root .st-sidebar-header h3 {
  margin-top: 4px;
  color: var(--app-text-strong);
  font-size: 0.98rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.st-root .st-sidebar-header p {
  display: -webkit-box;
  margin-top: 3px;
  overflow: hidden;
  color: var(--app-text-faint);
  font-size: 0.68rem;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.st-list-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 23px;
  height: 23px;
  padding: 0 7px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  color: var(--app-text-muted);
  background: var(--app-panel-muted);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.62rem;
}

.st-root .st-search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 9px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-muted);
  transition: border-color 0.14s ease, background 0.14s ease;
}

.st-root .st-search:focus-within {
  border-color: color-mix(in srgb, var(--app-accent) 52%, var(--app-border));
  background: var(--app-panel-subtle);
}

.st-search > svg {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--app-text-faint);
}

.st-root .st-search input {
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  outline: 0;
  color: var(--app-text);
  background: transparent;
  font-size: 0.76rem;
}

.st-search input::placeholder {
  color: var(--app-text-faint);
}

.st-search input::-webkit-search-cancel-button {
  display: none;
}

.st-search-clear {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: var(--app-text-faint);
  background: transparent;
  font-size: 0.9rem;
  line-height: 1;
  cursor: pointer;
}

.st-search-clear:hover {
  color: var(--app-text);
  background: var(--app-panel-muted);
}

.st-root .st-filter-row {
  display: flex;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-subtle);
}

.st-filter-chip {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 26px;
  padding: 3px 6px;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--app-text-muted);
  background: transparent;
  font-size: 0.66rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.13s ease, color 0.13s ease, border-color 0.13s ease;
}

.st-filter-chip span {
  min-width: 15px;
  padding: 0 4px;
  border-radius: 999px;
  color: var(--app-text-faint);
  background: var(--app-panel-muted);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.57rem;
  line-height: 15px;
  text-align: center;
}

.st-filter-chip:hover {
  color: var(--app-text);
  background: var(--app-panel-muted);
}

.st-filter-chip.active {
  color: var(--app-accent-strong);
  border-color: color-mix(in srgb, var(--app-accent) 26%, transparent);
  background: var(--app-accent-soft);
}

.st-filter-chip.active span {
  color: var(--app-accent-strong);
  background: color-mix(in srgb, var(--app-accent) 14%, transparent);
}

.st-root .st-task-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0 -5px;
  padding: 3px 5px 6px;
  overflow-y: auto;
}

.st-root .st-task-card {
  position: relative;
  display: block;
  width: 100%;
  padding: 10px 10px 9px 14px;
  border: 1px solid transparent;
  border-radius: 11px;
  color: var(--app-text);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, transform 0.14s ease;
}

.st-root .st-task-card:hover {
  border-color: var(--app-border);
  background: var(--app-panel-muted);
}

.st-root .st-task-card.active {
  border-color: color-mix(in srgb, var(--app-accent) 25%, var(--app-border));
  background:
    linear-gradient(110deg, color-mix(in srgb, var(--app-accent) 11%, transparent), transparent 72%),
    var(--app-panel-subtle);
}

.st-task-rail {
  position: absolute;
  top: 11px;
  bottom: 11px;
  left: 3px;
  width: 2px;
  border-radius: 3px;
  background: transparent;
}

.st-task-rail.is-running,
.st-task-rail.is-retrying {
  background: #2dd4bf;
  box-shadow: 0 0 8px rgba(45, 212, 191, 0.4);
}

.st-task-rail.is-completed {
  background: var(--app-success);
}

.st-task-rail.is-failed {
  background: var(--app-danger);
}

.st-root .st-task-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: nowrap;
}

.st-root .st-task-card strong {
  overflow: hidden;
  color: var(--app-text-strong);
  font-size: 0.8rem;
  font-weight: 600;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-task-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  color: var(--app-text-faint);
  font-size: 0.59rem;
  font-weight: 600;
}

.st-task-status::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.st-task-status.is-running,
.st-task-status.is-retrying {
  color: #2dd4bf;
}

.st-task-status.is-completed {
  color: var(--app-success);
}

.st-task-status.is-failed {
  color: var(--app-danger);
}

.st-root .st-task-schedule {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
  overflow: hidden;
  color: var(--app-text-muted);
  font-size: 0.68rem;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-task-schedule svg {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  color: var(--app-text-faint);
}

.st-task-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 7px;
}

.st-task-next {
  color: var(--app-text-faint);
  font-size: 0.63rem;
}

.st-task-next.is-off {
  opacity: 0.65;
}

.st-task-origin {
  padding: 1px 4px;
  border: 1px solid var(--app-border);
  border-radius: 4px;
  color: var(--app-text-faint);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.5rem;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.st-list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  padding: 20px 12px;
  border: 1px dashed var(--app-border-strong);
  border-radius: 12px;
  text-align: center;
}

.st-list-empty-mark {
  color: var(--app-accent-strong);
  font-size: 1.15rem;
}

.st-list-empty strong {
  color: var(--app-text);
  font-size: 0.76rem;
}

.st-list-empty p {
  margin: 0;
  color: var(--app-text-faint);
  font-size: 0.67rem;
  line-height: 1.5;
}

.st-list-empty .st-primary-btn {
  margin-top: 6px;
  min-height: 30px;
  padding: 6px 10px;
  font-size: 0.7rem;
}

.st-root .st-main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 18px 20px;
  overflow-y: auto;
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-strong));
  container-type: inline-size;
}

.st-root .st-main-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding-bottom: 13px;
  border-bottom: 1px solid var(--app-border);
}

.st-main-heading {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.st-main-kicker {
  color: var(--app-text-faint);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.56rem;
  font-weight: 700;
  letter-spacing: 0.16em;
}

.st-root .st-main-header h3 {
  margin-top: 4px;
  color: var(--app-text-strong);
  font-size: 1.22rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.25;
}

.st-root .st-main-header p {
  max-width: 620px;
  margin-top: 4px;
  color: var(--app-text-muted);
  font-size: 0.75rem;
  line-height: 1.55;
}

.st-root .st-main-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.st-root .st-main-actions .st-primary-btn,
.st-root .st-main-actions .st-ghost-btn,
.st-root .st-main-actions .st-danger-btn {
  min-height: 33px;
  padding: 6px 11px;
  font-size: 0.73rem;
}

.st-root .st-feedback {
  align-self: flex-start;
  margin: 0;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 24%, var(--app-border));
  border-radius: 9px;
  color: var(--app-text-soft);
  background: var(--app-accent-soft);
  font-size: 0.73rem;
  line-height: 1.45;
}

.st-root .st-editor-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 322px;
  gap: 12px;
  align-items: start;
}

.st-root .st-editor-layout > .st-editor-card {
  order: 1;
}

.st-root .st-editor-layout > .st-editor-card.ai-card {
  order: 2;
  position: sticky;
  top: 0;
}

.st-root .st-editor-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 17px;
  border: 1px solid var(--app-border);
  border-radius: 15px;
  background: var(--app-panel-subtle);
  backdrop-filter: blur(10px);
}

.st-root .st-editor-card.ai-card {
  border-color: color-mix(in srgb, var(--app-accent) 24%, var(--app-border));
  background:
    radial-gradient(100% 100% at 100% 0%, color-mix(in srgb, var(--app-accent) 15%, transparent), transparent 66%),
    var(--app-panel-subtle);
}

.st-root .st-section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.st-root .st-section-head h4 {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--app-text-strong);
  font-size: 0.84rem;
  font-weight: 650;
  letter-spacing: 0;
}

.st-root .st-section-head h4::before {
  width: 2px;
  height: 12px;
  background: var(--app-sig);
}

.st-root .st-section-head > span {
  max-width: 56%;
  color: var(--app-text-faint);
  font-size: 0.66rem;
  line-height: 1.4;
  text-align: right;
}

.st-root .st-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.st-root .st-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--app-text-soft);
  font-size: 0.72rem;
  font-weight: 500;
}

.st-root .st-field-full,
.st-root .full-span {
  grid-column: 1 / -1;
}

.st-root .st-field input,
.st-root .st-field select,
.st-root .st-field textarea,
.st-root .st-textarea {
  width: 100%;
  min-height: 35px;
  padding: 8px 10px;
  border: 1px solid var(--app-border);
  border-radius: 9px;
  outline: 0;
  color: var(--app-text);
  background: var(--app-input-bg);
  font: inherit;
  font-size: 0.76rem;
  transition: border-color 0.14s ease, box-shadow 0.14s ease, background 0.14s ease;
}

.st-root .st-field input:focus,
.st-root .st-field select:focus,
.st-root .st-field textarea:focus,
.st-root .st-textarea:focus {
  border-color: color-mix(in srgb, var(--app-accent) 52%, var(--app-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 10%, transparent);
}

.st-root .st-field textarea,
.st-root .st-textarea {
  min-height: 88px;
  resize: vertical;
  line-height: 1.6;
}

.st-field-hint {
  color: var(--app-text-faint);
  font-size: 0.62rem;
  font-weight: 400;
  line-height: 1.45;
}

.st-root .st-editor-card.ai-card .st-textarea {
  min-height: 148px;
  border-color: color-mix(in srgb, var(--app-accent) 18%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-strong) 58%, transparent);
}

.st-root .st-field.checkbox-field {
  flex-direction: row;
  align-items: center;
  align-self: stretch;
  gap: 8px;
  min-height: 35px;
  margin-top: 19px;
  padding: 7px 10px;
  border: 1px solid var(--app-border);
  border-radius: 9px;
  color: var(--app-text-soft);
  background: var(--app-panel-subtle);
  font-size: 0.7rem;
  cursor: pointer;
}

.st-root .st-field.checkbox-field input,
.st-root .st-check-item input {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  margin: 0;
  accent-color: var(--app-accent);
}

.st-root .st-field-label {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 8px;
  color: var(--app-text-soft);
  font-size: 0.72rem;
  font-weight: 600;
}

.st-root .st-field-label::before {
  width: 2px;
  height: 11px;
  background: var(--app-sig);
}

.st-root .st-mode-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 7px;
}

.st-root .st-mode-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-height: 74px;
  padding: 9px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  color: var(--app-text-soft);
  background: var(--app-panel-subtle);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease, color 0.14s ease;
}

.st-root .st-mode-option:hover {
  border-color: var(--app-border-strong);
  background: var(--app-panel-muted);
}

.st-root .st-mode-option.active {
  border-color: color-mix(in srgb, var(--app-accent) 54%, var(--app-border));
  color: var(--app-accent-strong);
  background: var(--app-accent-soft);
}

.st-root .st-mode-option .st-mode-icon {
  display: inline-flex;
  width: 16px;
  height: 16px;
  margin-bottom: 3px;
  color: var(--app-text-muted);
}

.st-root .st-mode-option.active .st-mode-icon {
  color: var(--app-accent-strong);
}

.st-mode-icon :deep(svg) {
  width: 100%;
  height: 100%;
}

.st-root .st-mode-option strong {
  display: block;
  margin: 0;
  color: inherit;
  font-size: 0.73rem;
  font-weight: 600;
}

.st-root .st-mode-option > span:not(.st-mode-icon) {
  display: block;
  overflow: hidden;
  color: var(--app-text-faint);
  font-size: 0.59rem;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-root .st-schedule-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  align-items: end;
  gap: 10px;
  margin-top: 9px;
  padding: 11px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-panel-strong) 42%, transparent);
}

.st-root .st-schedule-panel.is-interval {
  grid-template-columns: minmax(0, 1fr);
}

.st-root .st-weekday-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 5px;
}

.st-root .st-weekday-chip {
  min-height: 31px;
  padding: 5px 4px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  color: var(--app-text-muted);
  background: var(--app-panel-subtle);
  font: inherit;
  font-size: 0.67rem;
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease, color 0.14s ease;
}

.st-root .st-weekday-chip.active {
  border-color: color-mix(in srgb, var(--app-accent) 48%, var(--app-border));
  color: var(--app-accent-strong);
  background: var(--app-accent-soft);
}

.st-root .st-interval-fields,
.st-root .st-retry-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.st-root .st-interval-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 9px;
  align-items: end;
}

.st-root .st-interval-row.has-custom {
  grid-template-columns: minmax(0, 1fr) minmax(90px, 120px);
}

.st-root .st-retry-block {
  padding: 11px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-subtle);
}

.st-root .st-scope-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.st-root .st-scope-card {
  max-height: 238px;
  padding: 12px;
  overflow-y: auto;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-subtle);
}

.st-root .st-check-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 8px 0;
  border-bottom: 1px solid var(--app-border);
  cursor: pointer;
}

.st-root .st-check-item span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.st-root .st-check-item strong {
  color: var(--app-text-soft);
  font-size: 0.7rem;
  font-weight: 600;
}

.st-root .st-check-item small {
  color: var(--app-text-faint);
  font-size: 0.62rem;
  line-height: 1.45;
}

.st-root .st-tool-policy-options {
  display: grid;
  gap: 7px;
}

.st-root .st-tool-policy-options .st-check-item {
  padding: 9px 10px;
  border: 1px solid var(--app-border);
  border-radius: 9px;
  background: var(--app-panel-subtle);
}

.st-root .st-tool-policy-options .st-check-item.active {
  border-color: color-mix(in srgb, var(--app-accent) 48%, var(--app-border));
  background: var(--app-accent-soft);
}

.st-root .st-model-hint {
  color: var(--app-text-faint);
  font-size: 0.62rem;
  line-height: 1.5;
}

.st-root .st-date-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.st-root .st-date-row input {
  flex: 1;
}

.st-root .st-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 7px;
  flex-wrap: wrap;
  padding-top: 2px;
}

.st-root .st-editor-card.ai-card .st-editor-actions {
  justify-content: space-between;
}

.st-root .st-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
}

.st-root .st-tag {
  padding: 3px 8px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  color: var(--app-text-soft);
  background: var(--app-panel-muted);
  font-size: 0.63rem;
}

.st-root .st-detail {
  display: flex;
  flex-direction: column;
  gap: 11px;
  min-height: 0;
}

.st-root .st-detail-tabs {
  display: inline-flex;
  align-self: flex-start;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-muted);
}

.st-root .st-detail-tab {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 28px;
  padding: 5px 12px;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--app-text-muted);
  background: transparent;
  font-size: 0.71rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}

.st-root .st-detail-tab:hover {
  color: var(--app-text);
  background: var(--app-panel-subtle);
}

.st-root .st-detail-tab.active {
  color: var(--app-text-strong);
  border-color: var(--app-border);
  background: var(--app-panel-strong);
  box-shadow: var(--shadow-1);
}

.st-root .st-detail-tab-count {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  color: var(--app-accent-strong);
  background: var(--app-accent-soft);
  font-size: 0.57rem;
  line-height: 16px;
}

.st-root .st-summary-card,
.st-root .st-report-card {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 16px;
  border: 1px solid var(--app-border);
  border-radius: 15px;
  background: var(--app-panel-subtle);
  backdrop-filter: blur(10px);
}

.st-root .st-detail-runway {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  overflow: hidden;
  padding: 17px 18px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 25%, var(--app-border));
  border-radius: 13px;
  background:
    radial-gradient(110% 160% at 100% 0%, var(--app-accent-soft), transparent 58%),
    linear-gradient(120deg, color-mix(in srgb, var(--app-accent) 9%, transparent), transparent 52%),
    var(--app-panel-strong);
}

.st-detail-runway::after {
  content: '';
  position: absolute;
  right: -40px;
  bottom: -75px;
  width: 200px;
  height: 200px;
  border-radius: 50%;
  pointer-events: none;
  background: radial-gradient(circle, var(--app-accent-glow), transparent 66%);
}

.st-detail-runway-copy {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.st-detail-runway-copy span {
  color: var(--app-text-muted);
  font-size: 0.66rem;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.st-detail-runway-copy strong {
  color: var(--app-text-strong);
  font-size: 1.33rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.st-detail-runway-copy small {
  color: var(--app-text-faint);
  font-size: 0.66rem;
}

.st-root .st-status-pill {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  color: var(--app-text-muted);
  background: var(--app-panel-muted);
  font-size: 0.64rem;
  font-weight: 600;
}

.st-root .st-status-pill::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.st-root .st-status-pill.is-completed {
  color: var(--app-success);
  border-color: color-mix(in srgb, var(--app-success) 24%, var(--app-border));
  background: var(--app-success-soft);
}

.st-root .st-status-pill.is-failed {
  color: var(--app-danger);
  border-color: color-mix(in srgb, var(--app-danger) 24%, var(--app-border));
  background: var(--app-danger-soft);
}

.st-root .st-status-pill.is-retrying {
  color: var(--app-warning);
  border-color: color-mix(in srgb, var(--app-warning) 24%, var(--app-border));
  background: var(--app-warning-soft);
}

.st-root .st-status-pill.is-running {
  color: #2dd4bf;
  border-color: rgba(45, 212, 191, 0.26);
  background: rgba(45, 212, 191, 0.12);
}

.st-root .st-metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(138px, 1fr));
  gap: 8px;
}

.st-root .st-metric {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 11px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-strong);
}

.st-root .st-metric span {
  color: var(--app-text-faint);
  font-size: 0.62rem;
  line-height: 1.35;
}

.st-root .st-metric strong {
  overflow: hidden;
  color: var(--app-text-strong);
  font-size: 0.73rem;
  font-weight: 600;
  line-height: 1.4;
  text-overflow: ellipsis;
}

.st-root .st-summary-block {
  padding: 11px 12px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-strong);
}

.st-root .st-summary-block > strong {
  display: block;
  margin-bottom: 5px;
  color: var(--app-text-soft);
  font-size: 0.68rem;
  font-weight: 600;
}

.st-root .st-summary-block p {
  margin: 0;
  color: var(--app-text-muted);
  font-size: 0.71rem;
  line-height: 1.55;
}

.st-root .st-prompt-md {
  margin-top: 2px;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 9px;
  color: var(--app-text);
  background: var(--app-panel-subtle);
  font-size: 0.75rem;
  line-height: 1.65;
  overflow-x: auto;
}

.st-root .st-prompt-md :deep(> :first-child) {
  margin-top: 0;
}

.st-root .st-prompt-md :deep(> :last-child) {
  margin-bottom: 0;
}

.st-root .st-scope-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.st-root .st-resources-head {
  margin-top: 2px;
}

.st-root .st-resources-head h4 {
  font-size: 0.74rem;
}

.st-root .st-report-card {
  gap: 9px;
}

.st-root .st-report-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 11px 12px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  color: var(--app-text);
  background: var(--app-panel-strong);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease, transform 0.14s ease;
}

.st-root .st-report-item:hover {
  border-color: var(--app-border-strong);
  background: var(--app-panel-muted);
  transform: translateY(-1px);
}

.st-root .st-report-item.is-completed {
  border-left-color: color-mix(in srgb, var(--app-success) 58%, var(--app-border));
}

.st-root .st-report-item.is-failed {
  border-left-color: color-mix(in srgb, var(--app-danger) 58%, var(--app-border));
}

.st-root .st-report-item.is-running,
.st-root .st-report-item.is-retrying {
  border-left-color: rgba(45, 212, 191, 0.58);
}

.st-root .st-report-item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.st-root .st-report-item-top strong {
  color: var(--app-text-strong);
  font-size: 0.73rem;
  font-weight: 600;
}

.st-root .st-report-item-top span {
  color: var(--app-text-faint);
  font-size: 0.64rem;
}

.st-root .st-report-item p {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--app-text-muted);
  font-size: 0.7rem;
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.st-root .st-report-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--app-text-faint);
  font-size: 0.62rem;
}

.st-report-open {
  margin-left: auto;
  color: var(--app-accent-strong);
}

.st-report-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 22px 16px;
  border: 1px dashed var(--app-border-strong);
  border-radius: 12px;
  text-align: center;
}

.st-report-empty span {
  color: var(--app-accent-strong);
  font-size: 1.25rem;
}

.st-report-empty strong {
  color: var(--app-text);
  font-size: 0.75rem;
  font-weight: 600;
}

.st-report-empty p {
  margin: 0;
  color: var(--app-text-faint);
  font-size: 0.66rem;
}

.st-root .st-onboarding {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 380px;
  padding: 34px 24px;
  overflow: hidden;
  border: 1px dashed var(--app-border-strong);
  border-radius: 15px;
  background:
    radial-gradient(60% 70% at 50% 30%, color-mix(in srgb, var(--app-accent) 8%, transparent), transparent 72%),
    var(--app-panel-subtle);
  text-align: center;
}

.st-onboarding-art {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 118px;
  height: 118px;
  margin-bottom: 5px;
}

.st-onboarding-ring {
  position: absolute;
  border: 1px solid color-mix(in srgb, var(--app-accent) 22%, transparent);
  border-radius: 50%;
}

.ring-one {
  inset: 4px;
  animation: st-orbit 9s linear infinite;
}

.ring-two {
  inset: 20px;
  border-style: dashed;
  border-color: color-mix(in srgb, var(--app-accent) 32%, transparent);
  animation: st-orbit-reverse 14s linear infinite;
}

@keyframes st-orbit {
  to { transform: rotate(360deg); }
}

@keyframes st-orbit-reverse {
  to { transform: rotate(-360deg); }
}

.st-onboarding-core {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 58px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
  border-radius: 18px;
  color: var(--app-accent-strong);
  background: color-mix(in srgb, var(--app-panel-strong) 74%, transparent);
  box-shadow: 0 14px 32px var(--app-accent-glow);
  backdrop-filter: blur(12px);
}

.st-onboarding-core svg {
  width: 30px;
  height: 30px;
}

.st-onboarding-kicker {
  color: var(--app-text-faint);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.56rem;
  font-weight: 700;
  letter-spacing: 0.16em;
}

.st-root .st-onboarding h3 {
  margin: 4px 0 0;
  color: var(--app-text-strong);
  font-size: 1.18rem;
  font-weight: 650;
  letter-spacing: -0.015em;
}

.st-root .st-onboarding p {
  max-width: 460px;
  margin: 2px 0 0;
  color: var(--app-text-muted);
  font-size: 0.75rem;
  line-height: 1.6;
}

.st-onboarding-points {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 5px;
  margin-top: 8px;
}

.st-onboarding-points span {
  padding: 3px 9px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  color: var(--app-text-muted);
  background: var(--app-panel-muted);
  font-size: 0.62rem;
}

.st-root .st-onboarding-cta {
  min-height: 36px;
  margin-top: 9px;
  padding: 8px 14px;
}

.st-onboarding small {
  margin-top: 1px;
  color: var(--app-text-faint);
  font-size: 0.64rem;
}

.st-root .st-task-list::-webkit-scrollbar,
.st-root .st-main::-webkit-scrollbar,
.st-root .st-scope-card::-webkit-scrollbar {
  width: 7px;
}

.st-root .st-task-list::-webkit-scrollbar-thumb,
.st-root .st-main::-webkit-scrollbar-thumb,
.st-root .st-scope-card::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: var(--app-scrollbar);
}

@media (max-width: 1220px) {
  .st-root .st-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .st-root .st-editor-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .st-root .st-editor-layout > .st-editor-card.ai-card {
    position: static;
    order: -1;
  }

  .st-root .st-mode-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 980px) {
  .st-root .st-hero {
    padding: 18px 20px 30px;
  }

  .st-root .st-stats {
    margin-right: 20px;
    margin-left: 20px;
  }

  .st-root .st-body {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto;
    align-content: start;
    padding: 12px 20px 18px;
    overflow-y: auto;
  }

  .st-root .st-sidebar {
    max-height: 290px;
    border-bottom: 1px solid var(--app-border);
  }

  .st-root .st-main {
    min-height: 440px;
  }

  .st-root .st-metrics-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .st-root .st-scope-summary-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .st-root .st-hero {
    flex-direction: column;
    gap: 14px;
    padding: 18px 18px 28px;
  }

  .st-root .st-hero-actions {
    width: 100%;
  }

  .st-root .st-hero-create {
    width: 100%;
  }

  .st-root .st-stats,
  .st-root .st-body {
    margin-right: 14px;
    margin-left: 14px;
  }

  .st-root .st-body {
    padding: 12px 0 14px;
  }

  .st-root .st-main {
    padding: 14px;
  }

  .st-root .st-main-header {
    flex-direction: column;
  }

  .st-root .st-main-actions {
    justify-content: flex-start;
  }

  .st-root .st-form-grid,
  .st-root .st-scope-grid,
  .st-root .st-interval-fields,
  .st-root .st-retry-fields,
  .st-root .st-mode-grid {
    grid-template-columns: 1fr;
  }

  .st-root .st-field.checkbox-field {
    margin-top: 0;
  }

  .st-root .st-weekday-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .st-root .st-metrics-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-height: 760px) {
  .st-root .st-hero {
    padding-top: 16px;
    padding-bottom: 27px;
  }

  .st-root .st-stat-card {
    min-height: 76px;
    padding: 11px 13px;
  }

  .st-root .st-body {
    padding-top: 11px;
  }
}
</style>

<style scoped>
/* Authoritative compact layout. Keep this block last. */
.st-root .st-detail-runway-copy {
  flex-direction: row;
  align-items: baseline;
  gap: 8px;
}

.st-root .st-detail-runway-copy span {
  font-size: 0.62rem;
}

.st-root .st-detail-runway-copy strong {
  font-size: 0.93rem;
  letter-spacing: -0.01em;
}

.st-root .st-detail-runway-copy small {
  font-size: 0.6rem;
}

.st-root .st-status-pill {
  padding: 3px 8px;
  font-size: 0.6rem;
}

.st-root .st-section-head h4 {
  font-size: 0.78rem;
}

.st-root .st-section-head > span {
  font-size: 0.61rem;
}

.st-root .st-summary-block {
  padding: 8px 10px;
  border-radius: 8px;
}

.st-root .st-summary-block > strong {
  margin-bottom: 3px;
  font-size: 0.64rem;
}

.st-root .st-prompt-md {
  padding: 8px 10px;
  font-size: 0.71rem;
  line-height: 1.55;
}

.st-root .st-scope-summary-grid {
  gap: 6px;
}

.st-root .st-form-grid {
  gap: 10px;
}

.st-root .st-mode-option {
  min-height: 62px;
  padding: 8px;
}

.st-root .st-schedule-panel,
.st-root .st-retry-block {
  padding: 9px;
}

.st-root .st-scope-card {
  max-height: 196px;
  padding: 9px;
}

.st-root .st-hero {
  align-items: center;
  gap: 14px;
  padding: 10px 18px;
  background: var(--app-panel);
}

.st-root .st-hero-copy {
  flex: 1;
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  max-width: none;
}

.st-root .st-hero h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.st-root .st-hero-copy > p {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  max-width: none;
  margin: 0;
  color: var(--app-text-faint);
  font-size: 0.66rem;
  line-height: 1.3;
}

.st-root .st-hero-meta {
  gap: 7px;
  margin: 0 0 0 auto;
  flex-wrap: nowrap;
}

.st-root .st-hero-model {
  height: 31px;
  padding: 2px 3px 2px 9px;
}

.st-root .st-hero-actions {
  padding: 0;
}

.st-root .st-hero-create {
  min-height: 32px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 0.73rem;
}

.st-root .st-body {
  display: grid;
  grid-template-columns: minmax(300px, 340px) minmax(0, 1fr);
  gap: 0;
  padding: 0;
}

.st-root .st-sidebar {
  gap: 8px;
  padding: 10px 12px;
  border: 0;
  border-right: 1px solid var(--app-border);
  border-radius: 0;
  background: var(--app-panel);
  box-shadow: none;
}

.st-root .st-sidebar-header {
  align-items: center;
  padding: 2px 2px 4px;
}

.st-root .st-sidebar-header h3 {
  margin: 0;
  font-size: 0.87rem;
}

.st-root .st-sidebar-header p {
  display: none;
}

.st-root .st-search {
  height: 31px;
}

.st-root .st-filter-row {
  gap: 2px;
  padding: 0;
  border: 0;
  background: transparent;
}

.st-root .st-filter-chip {
  min-height: 24px;
  padding: 2px 5px;
  font-size: 0.63rem;
}

.st-root .st-task-list {
  gap: 1px;
  margin: 0 -4px;
  padding: 0 4px 4px;
}

.st-root .st-task-card {
  padding: 9px 9px 8px 13px;
  border-radius: 9px;
}

.st-root .st-task-card strong {
  font-size: 0.81rem;
}

.st-root .st-task-schedule {
  margin-top: 4px;
  font-size: 0.69rem;
}

.st-root .st-main {
  padding: 13px 18px;
  border: 0;
  border-radius: 0;
  background: var(--app-main-surface);
}

.st-root .st-main-header {
  gap: 12px;
  padding-bottom: 9px;
}

.st-root .st-main-header h3 {
  margin-top: 0;
  font-size: 1.04rem;
  font-weight: 650;
  line-height: 1.25;
}

.st-root .st-main-header p {
  margin-top: 2px;
  font-size: 0.68rem;
  line-height: 1.4;
}

.st-root .st-main-actions {
  gap: 5px;
}

.st-root .st-main-actions .st-primary-btn,
.st-root .st-main-actions .st-ghost-btn,
.st-root .st-main-actions .st-danger-btn {
  min-height: 30px;
  padding: 5px 10px;
  font-size: 0.69rem;
}

.st-root .st-detail {
  gap: 8px;
}

.st-root .st-detail-tabs {
  padding: 2px;
  border-radius: 8px;
}

.st-root .st-detail-tab {
  min-height: 24px;
  padding: 3px 10px;
  font-size: 0.66rem;
}

.st-root .st-summary-card,
.st-root .st-report-card {
  gap: 9px;
  padding: 12px;
  border-radius: 11px;
}

.st-root .st-detail-runway {
  padding: 9px 12px;
  border-radius: 9px;
}

.st-root .st-metrics-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: 9px;
}

.st-root .st-metric {
  gap: 2px;
  padding: 7px 9px;
  border: 0;
  border-right: 1px solid var(--app-border);
  border-radius: 0;
  background: transparent;
}

.st-root .st-metric:last-child {
  border-right: 0;
}

.st-root .st-editor-layout {
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
}

.st-root .st-editor-card {
  gap: 11px;
  padding: 13px;
  border-radius: 11px;
}

.st-root .st-editor-card.ai-card .st-textarea {
  min-height: 72px;
}

.st-root .st-body.is-editing {
  display: block;
}

.st-root .st-body.is-editing .st-sidebar {
  display: none;
}

.st-root .st-body.is-editing .st-main {
  height: 100%;
}

.st-root .st-body.is-editing .st-editor-layout {
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  max-width: 1240px;
  margin: 0 auto;
}

.st-root .st-body.is-editing .st-editor-layout > .st-editor-card.ai-card {
  position: static;
  order: -1;
}

@media (max-width: 1080px) {
  .st-root .st-hero-meta {
    flex-wrap: wrap;
    margin-left: 0;
  }

  .st-root .st-hero-copy {
    flex-direction: column;
    align-items: flex-start;
  }

  .st-root .st-hero {
    align-items: flex-start;
  }
}

@media (max-width: 980px) {
  .st-root .st-body {
    grid-template-columns: 1fr;
    overflow-y: auto;
    padding: 0;
  }

  .st-root .st-sidebar {
    max-height: 250px;
    border-right: 0;
    border-bottom: 1px solid var(--app-border);
  }

  .st-root .st-main {
    min-height: 420px;
  }

  .st-root .st-metrics-grid {
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  }
}

@media (max-width: 760px) {
  .st-root .st-hero {
    padding: 9px 12px;
  }

  .st-root .st-main {
    padding: 11px 12px;
  }

  .st-root .st-form-grid,
  .st-root .st-scope-grid,
  .st-root .st-interval-fields,
  .st-root .st-retry-fields,
  .st-root .st-mode-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-height: 760px) {
  .st-root .st-hero {
    padding: 10px 18px;
  }

  .st-root .st-body {
    padding: 0;
  }
}
</style>

<style scoped>
/* Report panel opens as a third column: the task list and run history stay
   visible, so switching between runs never drops the user into a modal. */
.st-root .st-body.has-report {
  --st-pane-head-height: 64px;
  grid-template-columns: minmax(220px, 250px) minmax(390px, 0.9fr) minmax(400px, 1.1fr);
}

.st-root .st-body.has-report .st-main-header {
  min-height: var(--st-pane-head-height);
}

.st-root .st-body.has-report .st-main-heading {
  flex: 1 1 auto;
  min-width: 0;
}

.st-root .st-body.has-report .st-main-header h3 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-root .st-body.has-report .st-main-header p {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-root .st-body.has-report .st-main-actions {
  flex: 0 0 auto;
  flex-wrap: nowrap;
  justify-content: flex-end;
}

/* Keep the pane header and tab strip fixed. Only the selected tab's body
   scrolls, matching the report panel's fixed header + scrolling body. */
.st-root .st-main {
  overflow: hidden;
}

.st-root .st-detail {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.st-root .st-detail-tabs {
  flex: 0 0 auto;
}

.st-root .st-detail > .st-summary-card {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.st-root .st-detail > .st-report-card {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.st-root .st-report-scroll {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-right: -3px;
  padding-right: 3px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.st-root .st-onboarding {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.st-root .st-body.has-report .task-report-panel {
  min-width: 0;
  min-height: 0;
}

.st-root .st-body.has-report .st-report-card {
  padding: 10px;
}

.st-root .st-body.has-report .st-report-item {
  padding: 9px 10px;
}

.st-root .st-body.has-report .st-report-item p {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.st-root .st-body.has-report .st-report-item-meta {
  gap: 7px;
  margin-top: 6px;
}

.st-root .st-report-item.is-selected {
  border-color: color-mix(in srgb, var(--app-accent) 46%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent) 9%, var(--app-panel));
  box-shadow: inset 2px 0 0 var(--app-accent);
}

.st-root .st-report-item.is-selected .st-report-open {
  color: var(--app-accent-strong);
}

/* While editing, the report may still be requested from a notification. Keep
   the unsaved draft mounted and show the report beside it rather than throwing
   the draft away for a modal. */
.st-root .st-body.is-editing .st-main {
  overflow-y: auto;
}

.st-root .st-body.is-editing.has-report {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(440px, 0.92fr);
  gap: 0;
  overflow: hidden;
}

.st-root .st-body.is-editing.has-report .st-main {
  height: auto;
  min-height: 0;
  padding: 13px 18px;
  overflow-y: auto;
  border-right: 1px solid var(--app-border);
}

.st-root .st-body.is-editing.has-report .st-editor-layout {
  max-width: none;
}

@media (min-width: 981px) and (max-width: 1240px) {
  .st-root .st-body.has-report:not(.is-editing) {
    grid-template-columns: minmax(176px, 200px) minmax(360px, 0.9fr) minmax(380px, 1.1fr);
  }

  .st-root .st-body.has-report .st-sidebar {
    gap: 6px;
    padding: 8px 9px;
  }

  .st-root .st-body.has-report .st-search {
    height: 28px;
  }

  .st-root .st-body.has-report .st-filter-row {
    display: none;
  }

  .st-root .st-body.has-report .st-task-schedule,
  .st-root .st-body.has-report .st-task-card-footer {
    display: none;
  }

  .st-root .st-body.has-report .st-task-card {
    padding: 8px 8px 8px 11px;
  }

  .st-root .st-body.has-report .st-task-card strong {
    font-size: 0.75rem;
    line-height: 1.35;
  }

  .st-root .st-body.has-report .st-task-status {
    padding: 2px 6px;
    font-size: 0.56rem;
  }

  .st-root .st-body.has-report .st-main-header p {
    display: none;
  }

  .st-root .st-body.has-report .st-main-actions {
    gap: 4px;
  }

  .st-root .st-body.has-report .st-main-actions .st-primary-btn,
  .st-root .st-body.has-report .st-main-actions .st-ghost-btn,
  .st-root .st-body.has-report .st-main-actions .st-danger-btn {
    min-height: 28px;
    padding: 4px 8px;
    font-size: 0.66rem;
  }
}

@media (max-width: 980px) {
  .st-root .st-body.has-report {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(176px, 210px) minmax(360px, auto) minmax(460px, auto);
    overflow-y: auto;
  }

  .st-root .st-body.is-editing.has-report {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(360px, auto) minmax(460px, auto);
    overflow-y: auto;
  }

  .st-root .st-body.has-report .st-sidebar {
    display: flex;
    max-height: 210px;
    border-right: 0;
    border-bottom: 1px solid var(--app-border);
  }

  .st-root .st-body.has-report .st-main {
    min-height: 360px;
    border-right: 0;
    border-bottom: 1px solid var(--app-border);
  }

  .st-root .st-body.has-report .task-report-panel {
    min-height: 460px;
    border-left: 0;
  }
}

@media (max-width: 760px) {
  .st-root .st-body.has-report {
    grid-template-rows: minmax(164px, 196px) minmax(320px, auto) minmax(440px, auto);
  }

  .st-root .st-body.is-editing.has-report {
    grid-template-rows: minmax(320px, auto) minmax(440px, auto);
  }

  .st-root .st-body.has-report .task-report-panel {
    min-height: 440px;
  }
}
</style>
