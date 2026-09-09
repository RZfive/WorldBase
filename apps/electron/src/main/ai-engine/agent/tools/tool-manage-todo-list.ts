import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'

export type TodoStatus = 'not-started' | 'in-progress' | 'completed'

export interface TodoItem {
  id: number
  title: string
  status: TodoStatus
}

interface TodoState {
  items: TodoItem[]
}

interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

function normalizeTodoItems (value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const items: TodoItem[] = []
  for (const rawItem of value) {
    if (!rawItem || typeof rawItem !== 'object') {
      return null
    }

    const itemRecord = rawItem as Record<string, unknown>

    const idValue = itemRecord.id
    const parsedId = typeof idValue === 'number'
      ? idValue
      : (typeof idValue === 'string' && /^\d+$/.test(idValue.trim()) ? Number(idValue.trim()) : NaN)
    const titleValue = itemRecord.title
    const title = typeof titleValue === 'string'
      ? titleValue.trim()
      : ''
    const status = itemRecord.status

    if (!Number.isInteger(parsedId) || parsedId <= 0 || !title) {
      return null
    }

    if (status !== 'not-started' && status !== 'in-progress' && status !== 'completed') {
      return null
    }

    items.push({
      id: parsedId,
      title,
      status
    })
  }

  return items
}

function summarizeTodoItems (items: TodoItem[]): string {
  const completed = items.filter(item => item.status === 'completed').length
  const inProgress = items.filter(item => item.status === 'in-progress').length
  return `共 ${items.length} 项，已完成 ${completed} 项，进行中 ${inProgress} 项`
}

export function toolManageTodoList (todoState: TodoState): Tool {
  return {
    definition: {
      name: 'manage_todo_list',
      description: 'Create or update the working todo list for the current task. Provide the complete list each time. Use this for non-trivial multi-step work and keep statuses current as you progress.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'The complete todo list for the current task. Replace the full list on every update. At most one item should be in-progress.',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'integer',
                  description: 'Stable numeric identifier for the todo item. Keep it consistent across updates.'
                },
                title: {
                  type: 'string',
                  description: 'Short actionable title, ideally 3-7 words.'
                },
                status: {
                  type: 'string',
                  enum: ['not-started', 'in-progress', 'completed'],
                  description: 'Current execution state for the item.'
                }
              },
              required: ['id', 'title', 'status']
            }
          }
        },
        required: ['items']
      }
    },
    handler: async (args, onProgress) => {
      const items = normalizeTodoItems(args.items)
      if (!items) {
        return { error: 'items must be an array of { id, title, status } todo entries.' }
      }

      const seenIds = new Set<number>()
      for (const item of items) {
        if (seenIds.has(item.id)) {
          return { error: `Duplicate todo id: ${item.id}` }
        }
        seenIds.add(item.id)
      }

      const inProgressCount = items.filter(item => item.status === 'in-progress').length
      if (inProgressCount > 1) {
        return { error: 'At most one todo item can be in-progress at a time.' }
      }

      todoState.items = items.map(item => ({ ...item }))

      onProgress?.({
        type: 'todo_update',
        items: todoState.items.map(item => ({ ...item }))
      })
      onProgress?.('更新 Todo', summarizeTodoItems(todoState.items))

      return {
        success: true,
        items: todoState.items,
        summary: summarizeTodoItems(todoState.items)
      }
    }
  }
}