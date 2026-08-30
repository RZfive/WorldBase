import crypto from 'node:crypto'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { ScheduledTaskService } from '../../../scheduler/scheduled-task-service.js'
import type { ScheduledTaskDefinition, ScheduledTaskSchedule } from '../../../settings/scheduled-task-store.js'

interface ToolServices {
  scheduledTaskService?: ScheduledTaskService
}

interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

function normalizeString (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeStringArray (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

function normalizeWeekdays (value: unknown): number[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<number>()
  const weekdays: number[] = []
  for (const item of value) {
    const weekday = Number(item)
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7 || seen.has(weekday)) continue
    seen.add(weekday)
    weekdays.push(weekday)
  }

  return weekdays.sort((left, right) => left - right)
}

function normalizeTimeOfDay (value: unknown): string {
  const raw = normalizeString(value)
  const match = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return ''

  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return ''
  }

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
}

function buildTitleFromPrompt (prompt: string): string {
  const flattened = prompt.replace(/\s+/g, ' ').trim()
  if (!flattened) return 'AI 定时任务'
  return flattened.length > 24 ? `${flattened.slice(0, 24)}...` : flattened
}

function buildSchedule (args: Record<string, unknown>): ScheduledTaskSchedule {
  const kind = normalizeString(args.schedule_kind)
  if (kind === 'once') {
    return {
      kind: 'once',
      runAt: normalizeString(args.run_at)
    }
  }

  if (kind === 'dates') {
    return {
      kind: 'dates',
      dates: normalizeStringArray(args.dates)
    }
  }

  if (kind === 'daily') {
    return {
      kind: 'daily',
      timeOfDay: normalizeTimeOfDay(args.time_of_day)
    }
  }

  if (kind === 'weekly') {
    return {
      kind: 'weekly',
      weekdays: normalizeWeekdays(args.weekdays),
      timeOfDay: normalizeTimeOfDay(args.time_of_day)
    }
  }

  return {
    kind: 'interval',
    everyMinutes: Number.isFinite(Number(args.every_minutes)) && Number(args.every_minutes) > 0
      ? Math.floor(Number(args.every_minutes))
      : 60,
    startAt: normalizeString(args.start_at) || undefined
  }
}

export function toolCreateScheduledTask (services: ToolServices): Tool {
  return {
    definition: {
      name: 'create_scheduled_task',
      description: 'Create a persistent scheduled AI task. The task can run once, repeat by minute interval, repeat daily or weekly at a local time, or run on specific dates. It can be limited to selected MCP servers and Skills.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Optional task title shown in the scheduler panel and notifications.'
          },
          prompt: {
            type: 'string',
            description: 'The user prompt that the scheduled AI task will execute.'
          },
          enabled: {
            type: 'boolean',
            description: 'Whether the task should start scheduling immediately. Defaults to true.'
          },
          schedule_kind: {
            type: 'string',
            enum: ['once', 'interval', 'daily', 'weekly', 'dates'],
            description: 'Scheduling mode: run once, repeat on minute interval, repeat every day, repeat every week, or run on specific dates.'
          },
          run_at: {
            type: 'string',
            description: 'Required when schedule_kind=once. ISO datetime for the run.'
          },
          every_minutes: {
            type: 'integer',
            description: 'Required when schedule_kind=interval. Repeat interval in minutes.'
          },
          start_at: {
            type: 'string',
            description: 'Optional start time for interval tasks. If omitted, the first run starts immediately.'
          },
          time_of_day: {
            type: 'string',
            description: 'Required when schedule_kind=daily or weekly. Local time in HH:mm format, for example 09:30.'
          },
          weekdays: {
            type: 'array',
            description: 'Required when schedule_kind=weekly. ISO weekday numbers, where 1=Monday and 7=Sunday.',
            items: {
              type: 'integer',
              enum: [1, 2, 3, 4, 5, 6, 7]
            }
          },
          dates: {
            type: 'array',
            description: 'Required when schedule_kind=dates. ISO datetime array for each planned run.',
            items: { type: 'string' }
          },
          selected_skill_ids: {
            type: 'array',
            description: 'Optional Skill IDs enabled only for this task run.',
            items: { type: 'string' }
          },
          selected_mcp_server_ids: {
            type: 'array',
            description: 'Optional MCP server IDs allowed only for this task run.',
            items: { type: 'string' }
          },
          max_retries: {
            type: 'integer',
            description: 'How many automatic retries are allowed after failure. Defaults to 0.'
          },
          retry_delay_minutes: {
            type: 'integer',
            description: 'Delay in minutes between retries. Defaults to 5.'
          }
        },
        required: ['prompt', 'schedule_kind']
      }
    },
    handler: async (args, onProgress) => {
      if (!services.scheduledTaskService) {
        return { error: 'Scheduled task service is not available in this runtime.' }
      }

      const prompt = normalizeString(args.prompt)
      if (!prompt) {
        return { error: 'prompt is required to create a scheduled task.' }
      }

      const now = new Date().toISOString()
      const task: ScheduledTaskDefinition = {
        id: `task_${crypto.randomUUID()}`,
        title: normalizeString(args.title) || buildTitleFromPrompt(prompt),
        enabled: args.enabled !== false,
        createdBy: 'ai',
        prompt,
        schedule: buildSchedule(args),
        selectedSkillIds: normalizeStringArray(args.selected_skill_ids),
        selectedMcpServerIds: normalizeStringArray(args.selected_mcp_server_ids),
        retryPolicy: {
          maxRetries: Number.isFinite(Number(args.max_retries)) && Number(args.max_retries) >= 0
            ? Math.floor(Number(args.max_retries))
            : 0,
          retryDelayMinutes: Number.isFinite(Number(args.retry_delay_minutes)) && Number(args.retry_delay_minutes) > 0
            ? Math.floor(Number(args.retry_delay_minutes))
            : 5
        },
        createdAt: now,
        updatedAt: now,
        nextRunAt: null,
        retryScheduledAt: null,
        lastRunAt: null,
        lastStatus: 'idle',
        lastReportId: null
      }

      onProgress?.('🗓️ 创建定时任务', task.title)
      const savedTask = services.scheduledTaskService.saveTask(task)
      onProgress?.('✅ 定时任务已创建', savedTask.title)

      return {
        success: true,
        task: savedTask,
        message: `定时任务 ${savedTask.title} 已创建。`
      }
    }
  }
}

export function toolListScheduledTasks (services: ToolServices): Tool {
  return {
    definition: {
      name: 'list_scheduled_tasks',
      description: 'List all saved scheduled AI tasks and their next run state.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    handler: async () => {
      if (!services.scheduledTaskService) {
        return { error: 'Scheduled task service is not available in this runtime.' }
      }

      return {
        tasks: services.scheduledTaskService.listTasks()
      }
    }
  }
}
