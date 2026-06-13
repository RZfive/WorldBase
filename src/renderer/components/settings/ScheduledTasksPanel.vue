<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ScheduledTaskReportDialog from './ScheduledTaskReportDialog.vue'

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

const scheduleModeOptions: Array<{ id: ScheduleKind; label: string; detail: string }> = [
  { id: 'daily', label: '每天', detail: '固定时间' },
  { id: 'weekly', label: '每周', detail: '选择星期' },
  { id: 'interval', label: '间隔', detail: '按分钟/小时' },
  { id: 'once', label: '单次', detail: '只运行一次' },
  { id: 'dates', label: '日期', detail: '多个时间点' }
]

const intervalPresetOptions = [
  { value: '15', label: '每 15 分钟' },
  { value: '30', label: '每 30 分钟' },
  { value: '60', label: '每 1 小时' },
  { value: '120', label: '每 2 小时' },
  { value: '360', label: '每 6 小时' },
  { value: '720', label: '每 12 小时' },
  { value: '1440', label: '每天' },
  { value: 'custom', label: '自定义' }
]

const weekdayOptions = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' }
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
  if (!value) return '未安排'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN')
}

function statusLabel (status?: ScheduledTaskDefinition['lastStatus']): string {
  switch (status) {
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'retrying': return '重试中'
    case 'running': return '执行中'
    default: return '空闲'
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
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'retrying': return '重试中'
    default: return '执行中'
  }
}

function formatWeekdays (weekdays: number[]): string {
  const labels = new Map(weekdayOptions.map(option => [option.value, option.label]))
  return weekdays.map(weekday => labels.get(weekday)).filter(Boolean).join('、')
}

function scheduleSummary (task: ScheduledTaskDefinition): string {
  if (task.schedule.kind === 'once') {
    return `单次执行 · ${formatTimestamp(task.schedule.runAt)}`
  }
  if (task.schedule.kind === 'daily') {
    return `每天执行 · ${task.schedule.timeOfDay}`
  }
  if (task.schedule.kind === 'weekly') {
    return `每周执行 · ${formatWeekdays(task.schedule.weekdays)} ${task.schedule.timeOfDay}`
  }
  if (task.schedule.kind === 'dates') {
    return `指定日期 · ${task.schedule.dates.length} 个时间点`
  }
  return `重复执行 · 每 ${task.schedule.everyMinutes} 分钟`
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
    setStatus('请填写要执行的提示词')
    return null
  }

  let schedule: ScheduledTaskSchedule | null = null
  if (value.scheduleKind === 'once') {
    const runAt = fromLocalDateTimeInput(value.runAtInput)
    if (!runAt) {
      setStatus('请填写单次执行时间')
      return null
    }
    schedule = { kind: 'once', runAt }
  } else if (value.scheduleKind === 'dates') {
    const dates = value.dateInputs
      .map(fromLocalDateTimeInput)
      .filter((date): date is string => Boolean(date))
      .sort((left, right) => left.localeCompare(right))
    if (dates.length === 0) {
      setStatus('请至少添加一个指定执行时间')
      return null
    }
    schedule = { kind: 'dates', dates }
  } else if (value.scheduleKind === 'daily') {
    const timeOfDay = normalizeTimeOfDayInput(value.timeOfDayInput)
    if (!timeOfDay) {
      setStatus('请选择每天执行时间')
      return null
    }
    schedule = { kind: 'daily', timeOfDay }
  } else if (value.scheduleKind === 'weekly') {
    const timeOfDay = normalizeTimeOfDayInput(value.timeOfDayInput)
    const weekdays = Array.from(new Set(value.weekdays))
      .filter(weekday => Number.isInteger(weekday) && weekday >= 1 && weekday <= 7)
      .sort((left, right) => left - right)
    if (!timeOfDay) {
      setStatus('请选择每周执行时间')
      return null
    }
    if (weekdays.length === 0) {
      setStatus('请至少选择一个星期')
      return null
    }
    schedule = { kind: 'weekly', weekdays, timeOfDay }
  } else {
    if (!Number.isFinite(Number(value.everyMinutes)) || Number(value.everyMinutes) <= 0) {
      setStatus('重复执行间隔必须大于 0')
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
    title: value.title.trim() || prompt.replace(/\s+/g, ' ').slice(0, 24) || '未命名任务',
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
    setStatus(`加载定时任务失败: ${(error as Error).message}`)
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
      .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'))
    selectedTaskId.value = savedTask.id
    editing.value = false
    draft.value = null
    setStatus('定时任务已保存')
    await loadData()
  } catch (error) {
    setStatus(`保存失败: ${(error as Error).message}`)
  } finally {
    saving.value = false
  }
}

async function deleteSelectedTask () {
  if (!selectedTask.value || !window.electronAPI?.deleteScheduledTask) return
  if (!window.confirm(`确认删除定时任务“${selectedTask.value.title}”吗？`)) return

  try {
    await window.electronAPI.deleteScheduledTask(selectedTask.value.id)
    activeReportId.value = null
    selectedTaskId.value = ''
    await loadData()
    setStatus('定时任务已删除')
  } catch (error) {
    setStatus(`删除失败: ${(error as Error).message}`)
  }
}

async function toggleSelectedTaskEnabled () {
  if (!selectedTask.value || !window.electronAPI?.saveScheduledTask) return

  try {
    const savedTask = await window.electronAPI.saveScheduledTask({
      ...selectedTask.value,
      enabled: !selectedTask.value.enabled,
      updatedAt: new Date().toISOString()
    })
    selectedTaskId.value = savedTask.id
    await loadData()
    setStatus(savedTask.enabled ? '任务已启用' : '任务已停用')
  } catch (error) {
    setStatus(`更新启用状态失败: ${(error as Error).message}`)
  }
}

async function runSelectedTaskNow () {
  if (!selectedTask.value || !window.electronAPI?.runScheduledTaskNow) return

  try {
    const report = await window.electronAPI.runScheduledTaskNow(selectedTask.value.id)
    activeReportId.value = report.id
    setStatus('任务已开始执行')
    await loadData()
  } catch (error) {
    setStatus(`立即执行失败: ${(error as Error).message}`)
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
      throw new Error('AI 返回的内容不是有效 JSON')
    }

    applyGeneratedDraft(payload)
    setStatus('AI 已生成任务草稿，可继续编辑后保存')
  } catch (error) {
    setStatus(`AI 生成失败: ${(error as Error).message}`)
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
          <h3>定时任务</h3>
          <p>让 AI 按计划自动执行提示词，支持重试、Skill 与 MCP 限定。</p>
        </div>
        <button class="st-primary-btn" type="button" @click="startAdd">新增任务</button>
      </div>

      <div v-if="tasks.length === 0" class="st-empty-list">
        还没有定时任务。你可以手动配置，也可以先让 AI 生成任务草稿。
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
          <span>{{ task.enabled ? '已启用' : '已停用' }}</span>
          <span>{{ task.createdBy === 'ai' ? 'AI 创建' : '手动创建' }}</span>
        </div>
        <div class="st-task-card-meta muted">
          <span>下次执行：{{ formatTimestamp(task.retryScheduledAt || task.nextRunAt) }}</span>
        </div>
      </button>
    </aside>

    <section class="st-main">
      <div class="st-main-header">
        <div>
          <h3>{{ editing ? '编辑任务' : (selectedTask?.title || '定时任务管理') }}</h3>
          <p>
            {{ editing
              ? '保存后任务会在后台自动执行，执行过程自动授权，并只使用你勾选的 Skill 与 MCP 服务。'
              : '查看任务状态、最近执行报告，或立即运行当前任务。' }}
          </p>
        </div>

        <div v-if="!editing && selectedTask" class="st-main-actions">
          <button class="st-ghost-btn" type="button" @click="toggleSelectedTaskEnabled">
            {{ selectedTask.enabled ? '停用' : '启用' }}
          </button>
          <button class="st-ghost-btn" type="button" @click="runSelectedTaskNow">立即执行</button>
          <button class="st-ghost-btn" type="button" @click="startEdit">编辑</button>
          <button class="st-danger-btn" type="button" @click="deleteSelectedTask">删除</button>
        </div>
      </div>

      <p v-if="statusMessage" class="st-feedback">{{ statusMessage }}</p>

      <div v-if="editing && draft" class="st-editor-layout">
        <section class="st-editor-card ai-card">
          <div class="st-section-head">
            <h4>AI 生成草稿</h4>
            <span>自然语言描述你想要的计划</span>
          </div>
          <textarea
            v-model="aiDraftPrompt"
            rows="5"
            class="st-textarea"
            placeholder="例如：每个工作日上午 9 点检查昨日构建日志，失败时 10 分钟后自动重试 2 次，并允许使用 browser MCP 与测试 Skill。"
          />
          <div class="st-editor-actions">
            <button class="st-ghost-btn" type="button" @click="aiDraftPrompt = ''">清空</button>
            <button class="st-primary-btn" type="button" @click="generateDraftWithAi" :disabled="aiGenerating">
              {{ aiGenerating ? '生成中…' : 'AI 生成草稿' }}
            </button>
          </div>
        </section>

        <section class="st-editor-card">
          <div class="st-section-head">
            <h4>任务配置</h4>
            <span>支持手动编辑或在 AI 草稿基础上微调</span>
          </div>

          <div class="st-form-grid">
            <label class="st-field">
              <span>任务名称</span>
              <input v-model="draft.title" type="text" placeholder="例如：晨间巡检报告" />
            </label>

            <label class="st-field checkbox-field">
              <input v-model="draft.enabled" type="checkbox" />
              <span>保存后立即启用</span>
            </label>

            <label class="st-field full-span">
              <span>提示词</span>
              <textarea v-model="draft.prompt" rows="7" class="st-textarea" placeholder="输入要让 AI 自动执行的提示词" />
            </label>

            <div class="st-schedule-block full-span">
              <span class="st-field-label">执行方式</span>
              <div class="st-mode-grid">
                <button
                  v-for="mode in scheduleModeOptions"
                  :key="mode.id"
                  type="button"
                  class="st-mode-option"
                  :class="{ active: draft.scheduleKind === mode.id }"
                  @click="draft.scheduleKind = mode.id"
                >
                  <strong>{{ mode.label }}</strong>
                  <span>{{ mode.detail }}</span>
                </button>
              </div>

              <div class="st-schedule-panel">
                <template v-if="draft.scheduleKind === 'daily'">
                  <label class="st-field">
                    <span>每天执行时间</span>
                    <input v-model="draft.timeOfDayInput" type="time" />
                  </label>
                </template>

                <template v-else-if="draft.scheduleKind === 'weekly'">
                  <div class="st-field full-span">
                    <span>星期</span>
                    <div class="st-weekday-grid">
                      <button
                        v-for="weekday in weekdayOptions"
                        :key="weekday.value"
                        type="button"
                        class="st-weekday-chip"
                        :class="{ active: draft.weekdays.includes(weekday.value) }"
                        @click="toggleWeekday(weekday.value)"
                      >
                        {{ weekday.label }}
                      </button>
                    </div>
                  </div>
                  <label class="st-field">
                    <span>执行时间</span>
                    <input v-model="draft.timeOfDayInput" type="time" />
                  </label>
                </template>

                <template v-else-if="draft.scheduleKind === 'interval'">
                  <label class="st-field">
                    <span>重复间隔</span>
                    <select v-model="draft.intervalPreset" @change="applyIntervalPreset">
                      <option v-for="option in intervalPresetOptions" :key="option.value" :value="option.value">
                        {{ option.label }}
                      </option>
                    </select>
                  </label>
                  <label v-if="draft.intervalPreset === 'custom'" class="st-field">
                    <span>间隔分钟</span>
                    <input v-model.number="draft.everyMinutes" type="number" min="1" step="1" @input="markIntervalCustom" />
                  </label>
                  <label class="st-field">
                    <span>首次执行时间</span>
                    <input v-model="draft.startAtInput" type="datetime-local" />
                  </label>
                </template>

                <template v-else-if="draft.scheduleKind === 'once'">
                  <label class="st-field">
                    <span>执行时间</span>
                    <input v-model="draft.runAtInput" type="datetime-local" />
                  </label>
                </template>

                <template v-else>
                  <div class="st-field full-span">
                    <span>指定日期</span>
                    <div class="st-date-row">
                      <input v-model="draft.nextDateInput" type="datetime-local" />
                      <button class="st-ghost-btn" type="button" @click="addDateInput">添加时间点</button>
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

            <label class="st-field">
              <span>失败重试次数</span>
              <input v-model.number="draft.maxRetries" type="number" min="0" step="1" />
            </label>

            <label class="st-field">
              <span>重试间隔分钟</span>
              <input v-model.number="draft.retryDelayMinutes" type="number" min="1" step="1" />
            </label>
          </div>

          <div class="st-scope-grid">
            <section class="st-scope-card">
              <div class="st-section-head">
                <h4>允许使用的 Skill</h4>
                <span>{{ draft.selectedSkillIds.length }} 项</span>
              </div>
              <div v-if="skills.length === 0" class="st-empty-inline">暂无 Skill，可留空表示不限制。</div>
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
                <h4>允许使用的 MCP 服务</h4>
                <span>{{ draft.selectedMcpServerIds.length }} 项</span>
              </div>
              <div v-if="mcpServers.length === 0" class="st-empty-inline">暂无 MCP 服务，可留空表示不限制。</div>
              <label v-for="server in mcpServers" :key="server.id" class="st-check-item">
                <input v-model="draft.selectedMcpServerIds" type="checkbox" :value="server.id" />
                <span>
                  <strong>{{ server.name }}</strong>
                  <small>{{ server.id }} · {{ server.enabled ? '已启用' : '已禁用' }}</small>
                </span>
              </label>
            </section>
          </div>

          <div class="st-editor-actions">
            <button class="st-ghost-btn" type="button" @click="cancelEdit">取消</button>
            <button class="st-primary-btn" type="button" @click="saveDraft" :disabled="saving">
              {{ saving ? '保存中…' : '保存任务' }}
            </button>
          </div>
        </section>
      </div>

      <div v-else-if="selectedTask" class="st-detail-grid">
        <section class="st-summary-card">
          <div class="st-section-head">
            <h4>任务概览</h4>
            <span>{{ selectedTask.createdBy === 'ai' ? 'AI 创建' : '手动创建' }}</span>
          </div>
          <div class="st-metrics-grid">
            <div class="st-metric">
              <span>当前状态</span>
              <strong>{{ statusLabel(selectedTask.lastStatus) }}</strong>
            </div>
            <div class="st-metric">
              <span>下次执行</span>
              <strong>{{ formatTimestamp(selectedTask.retryScheduledAt || selectedTask.nextRunAt) }}</strong>
            </div>
            <div class="st-metric">
              <span>上次执行</span>
              <strong>{{ formatTimestamp(selectedTask.lastRunAt) }}</strong>
            </div>
            <div class="st-metric">
              <span>重试策略</span>
              <strong>{{ selectedTask.retryPolicy.maxRetries }} 次 / {{ selectedTask.retryPolicy.retryDelayMinutes }} 分钟</strong>
            </div>
          </div>
          <div class="st-summary-block">
            <strong>计划方式</strong>
            <p>{{ scheduleSummary(selectedTask) }}</p>
          </div>
          <div class="st-summary-block">
            <strong>执行提示词</strong>
            <pre>{{ selectedTask.prompt }}</pre>
          </div>
          <div class="st-scope-summary-grid">
            <div class="st-summary-block">
              <strong>Skill 限定</strong>
              <div class="st-tag-list">
                <span v-for="skillId in selectedTask.selectedSkillIds" :key="skillId" class="st-tag">{{ skillNameMap.get(skillId) || skillId }}</span>
                <span v-if="selectedTask.selectedSkillIds.length === 0" class="st-empty-inline">未限制</span>
              </div>
            </div>
            <div class="st-summary-block">
              <strong>MCP 限定</strong>
              <div class="st-tag-list">
                <span v-for="serverId in selectedTask.selectedMcpServerIds" :key="serverId" class="st-tag">{{ mcpNameMap.get(serverId) || serverId }}</span>
                <span v-if="selectedTask.selectedMcpServerIds.length === 0" class="st-empty-inline">未限制</span>
              </div>
            </div>
          </div>
        </section>

        <section class="st-report-card">
          <div class="st-section-head">
            <h4>最近执行报告</h4>
            <span>{{ selectedTaskReports.length }} 条</span>
          </div>
          <div v-if="selectedTaskReports.length === 0" class="st-empty-inline">还没有执行记录。</div>
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
              <span>{{ report.trigger === 'manual' ? '手动执行' : '计划触发' }}</span>
              <span>第 {{ report.attempt }} 次尝试</span>
            </div>
          </button>
        </section>
      </div>

      <div v-else class="st-empty-main">
        选择左侧任务查看详情，或新增一个定时任务开始配置自动执行。
      </div>
    </section>

    <ScheduledTaskReportDialog :report="activeReport" @close="closeReportDialog" />
  </div>
</template>

<style scoped>
.st-root {
  display: grid;
  grid-template-columns: minmax(260px, 300px) minmax(0, 1fr);
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
  gap: 12px;
  padding: 16px;
  border-right: 1px solid var(--app-border);
  overflow-y: auto;
}

.st-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
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
  gap: 8px;
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
  min-height: 36px;
  padding: 8px 12px;
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
  padding: 12px;
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
.st-detail-grid,
.st-scope-grid,
.st-scope-summary-grid,
.st-metrics-grid,
.st-form-grid {
  display: grid;
  gap: 16px;
}

.st-editor-layout,
.st-detail-grid {
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
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
  padding: 16px;
}

.st-editor-card.ai-card {
  position: static;
}

.st-section-head span {
  color: var(--app-text-faint);
  font-size: 0.78rem;
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
  margin-bottom: 8px;
  font-size: 0.84rem;
  color: var(--app-text);
}

.st-field.full-span {
  grid-column: 1 / -1;
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
  margin-top: 12px;
  flex-wrap: wrap;
}

.st-date-row input {
  flex: 1 1 220px;
}

.st-schedule-block {
  min-width: 0;
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
  min-height: 64px;
  padding: 10px;
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
  margin-top: 12px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.025);
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
  padding: 14px;
}

.st-summary-block pre {
  margin: 10px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--app-text);
  font-size: 0.82rem;
  line-height: 1.6;
}

.st-report-item + .st-report-item {
  margin-top: 12px;
}

@container (min-width: 1080px) {
  .st-editor-layout,
  .st-detail-grid {
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
  .st-scope-summary-grid {
    grid-template-columns: 1fr;
  }
}
</style>
