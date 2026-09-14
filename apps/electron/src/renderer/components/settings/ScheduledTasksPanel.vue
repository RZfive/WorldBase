<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ScheduledTaskReportDialog from './ScheduledTaskReportDialog.vue'
import { renderMarkdown } from '../chat/markdown'

type ScheduleKind = 'once' | 'interval' | 'daily' | 'weekly' | 'dates'

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
  maxRetries: number
  retryDelayMinutes: number
}

const tasks = ref<ScheduledTaskDefinition[]>([])
const reports = ref<ScheduledTaskRunReport[]>([])
const skills = ref<SkillInfo[]>([])
const mcpServers = ref<MCPServerConfig[]>([])
const selectedTaskId = ref('')
const editing = ref(false)
const draft = ref<ScheduledTaskDraft | null>(null)
const saving = ref(false)
const aiGenerating = ref(false)
const statusMessage = ref('')
const aiDraftPrompt = ref('')
const activeReportId = ref<string | null>(null)
const activeDetailTab = ref<'details' | 'logs'>('details')
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

const weekdayOptions = [
  { value: 1, labelKey: 'settings.scheduledTasks.weekdayMon' },
  { value: 2, labelKey: 'settings.scheduledTasks.weekdayTue' },
  { value: 3, labelKey: 'settings.scheduledTasks.weekdayWed' },
  { value: 4, labelKey: 'settings.scheduledTasks.weekdayThu' },
  { value: 5, labelKey: 'settings.scheduledTasks.weekdayFri' },
  { value: 6, labelKey: 'settings.scheduledTasks.weekdaySat' },
  { value: 7, labelKey: 'settings.scheduledTasks.weekdaySun' }
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

const activeReport = computed(() => {
  if (!activeReportId.value) return null
  return reports.value.find(report => report.id === activeReportId.value) || null
})

const skillNameMap = computed(() => {
  return new Map(skills.value.map(skill => [skill.id, skill.name]))
})

const mcpNameMap = computed(() => {
  return new Map(mcpServers.value.map(server => [server.id, server.name]))
})

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
  editing.value = true
  draft.value = buildEmptyDraft()
  selectedTaskId.value = draft.value.id
}

function startEdit () {
  if (!selectedTask.value) return
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
  activeDetailTab.value = 'details'
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
    const report = await window.electronAPI.runScheduledTaskNow(selectedTask.value.id)
    activeReportId.value = report.id
    activeDetailTab.value = 'logs'
    setStatus(t('settings.scheduledTasks.started'))
    await loadData()
  } catch (error) {
    setStatus(t('settings.scheduledTasks.runNowFailed', { message: (error as Error).message }))
  }
}

function openReport (reportId: string) {
  activeReportId.value = reportId
}

function closeReportDialog () {
  activeReportId.value = null
}

async function generateDraftWithAi () {
  if (!window.electronAPI?.chat || !aiDraftPrompt.value.trim()) return

  aiGenerating.value = true
  try {
    const systemPrompt = [
      '你是一个定时任务配置生成器。',
      '根据用户描述，返回严格 JSON，不要输出 Markdown，不要解释，不要调用任何工具。',
      'JSON 字段仅允许使用：title, prompt, enabled, schedule_kind, run_at, every_minutes, start_at, time_of_day, weekdays, dates, selected_skill_ids, selected_mcp_server_ids, max_retries, retry_delay_minutes。',
      'schedule_kind 只能是 once、interval、daily、weekly、dates。',
      '每天或每周固定时间执行时优先使用 daily 或 weekly，time_of_day 用 HH:mm；weekly 的 weekdays 用 1-7 表示周一到周日。',
      'selected_skill_ids 和 selected_mcp_server_ids 必须只从提供的可用 ID 中选择。'
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
    <aside class="st-sidebar">
      <div class="st-sidebar-header">
        <div>
          <h3>{{ $t('settings.scheduledTasks.title') }}</h3>
          <p>{{ $t('settings.scheduledTasks.description') }}</p>
        </div>
        <button class="st-primary-btn" type="button" @click="startAdd">{{ $t('settings.scheduledTasks.addTask') }}</button>
      </div>

      <div v-if="tasks.length === 0" class="st-empty-list">
        {{ $t('settings.scheduledTasks.emptyList') }}
      </div>

      <button
        v-for="task in tasks"
        :key="task.id"
        type="button"
        class="st-task-card"
        :class="{ active: selectedTaskId === task.id }"
        @click="selectTask(task.id)"
      >
        <div class="st-task-card-top">
          <strong>{{ task.title }}</strong>
          <span class="st-status-pill" :class="statusClass(task.lastStatus)">{{ statusLabel(task.lastStatus) }}</span>
        </div>
        <p>{{ scheduleSummary(task) }}</p>
        <div class="st-task-card-meta">
          <span>{{ task.enabled ? $t('settings.scheduledTasks.enabled') : $t('settings.scheduledTasks.disabled') }}</span>
          <span>{{ task.createdBy === 'ai' ? $t('settings.scheduledTasks.createdByAi') : $t('settings.scheduledTasks.createdByManual') }}</span>
        </div>
        <div class="st-task-card-meta muted">
          <span>{{ $t('settings.scheduledTasks.nextRun', { time: formatTimestamp(task.retryScheduledAt || task.nextRunAt) }) }}</span>
        </div>
      </button>
    </aside>

    <section class="st-main">
      <div class="st-main-header">
        <div>
          <h3>{{ editing ? $t('settings.scheduledTasks.editTask') : (selectedTask?.title || $t('settings.scheduledTasks.manageTitle')) }}</h3>
          <p>
            {{ editing
              ? $t('settings.scheduledTasks.editDescription')
              : $t('settings.scheduledTasks.detailDescription') }}
          </p>
        </div>

        <div v-if="!editing && selectedTask" class="st-main-actions">
          <button class="st-ghost-btn" type="button" @click="toggleSelectedTaskEnabled">
            {{ selectedTask.enabled ? $t('settings.scheduledTasks.disable') : $t('settings.scheduledTasks.enable') }}
          </button>
          <button class="st-ghost-btn" type="button" @click="runSelectedTaskNow">{{ $t('settings.scheduledTasks.runNow') }}</button>
          <button class="st-ghost-btn" type="button" @click="startEdit">{{ $t('settings.scheduledTasks.edit') }}</button>
          <button class="st-danger-btn" type="button" @click="deleteSelectedTask">{{ $t('common.delete') }}</button>
        </div>
      </div>

      <p v-if="statusMessage" class="st-feedback">{{ statusMessage }}</p>

      <div v-if="editing && draft" class="st-editor-layout">
        <section class="st-editor-card ai-card">
          <div class="st-section-head">
            <h4>{{ $t('settings.scheduledTasks.aiDraftTitle') }}</h4>
            <span>{{ $t('settings.scheduledTasks.aiDraftSubtitle') }}</span>
          </div>
          <textarea
            v-model="aiDraftPrompt"
            rows="5"
            class="st-textarea"
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
          <div class="st-section-head">
            <h4>{{ $t('settings.scheduledTasks.overview') }}</h4>
            <span>{{ selectedTask.createdBy === 'ai' ? $t('settings.scheduledTasks.createdByAi') : $t('settings.scheduledTasks.createdByManual') }}</span>
          </div>
          <div class="st-metrics-grid">
            <div class="st-metric">
              <span>{{ $t('settings.scheduledTasks.currentStatus') }}</span>
              <strong>{{ statusLabel(selectedTask.lastStatus) }}</strong>
            </div>
            <div class="st-metric">
              <span>{{ $t('settings.scheduledTasks.nextRunLabel') }}</span>
              <strong>{{ formatTimestamp(selectedTask.retryScheduledAt || selectedTask.nextRunAt) }}</strong>
            </div>
            <div class="st-metric">
              <span>{{ $t('settings.scheduledTasks.lastRunLabel') }}</span>
              <strong>{{ formatTimestamp(selectedTask.lastRunAt) }}</strong>
            </div>
            <div class="st-metric">
              <span>{{ $t('settings.scheduledTasks.retryPolicy') }}</span>
              <strong>{{ $t('settings.scheduledTasks.retryPolicyValue', { retries: selectedTask.retryPolicy.maxRetries, minutes: selectedTask.retryPolicy.retryDelayMinutes }) }}</strong>
            </div>
          </div>
          <div class="st-summary-block">
            <strong>{{ $t('settings.scheduledTasks.scheduleMode') }}</strong>
            <p>{{ scheduleSummary(selectedTask) }}</p>
          </div>
          <div class="st-summary-block">
            <strong>{{ $t('settings.scheduledTasks.executionPrompt') }}</strong>
            <div class="st-prompt-md markdown-body" v-html="renderMarkdown(selectedTask.prompt)"></div>
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
          </div>
        </section>

        <section v-show="activeDetailTab === 'logs'" class="st-report-card">
          <div class="st-section-head">
            <h4>{{ $t('settings.scheduledTasks.logsTab') }}</h4>
            <span>{{ $t('settings.scheduledTasks.recordCount', { count: selectedTaskReports.length }) }}</span>
          </div>
          <div v-if="selectedTaskReports.length === 0" class="st-empty-inline">{{ $t('settings.scheduledTasks.noReports') }}</div>
          <button
            v-for="report in selectedTaskReports"
            :key="report.id"
            type="button"
            class="st-report-item"
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
            </div>
          </button>
        </section>
      </div>

      <div v-else class="st-empty-main">
        {{ $t('settings.scheduledTasks.emptyMain') }}
      </div>
    </section>

    <ScheduledTaskReportDialog :report="activeReport" @close="closeReportDialog" />
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
  font-size: 0.78rem;
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
  display: block;
  margin-bottom: 10px;
  font-size: 0.84rem;
  color: var(--app-text);
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
