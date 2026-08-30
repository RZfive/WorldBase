import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { AsyncTaskManager, AsyncTaskType } from './async-task-manager.js'
import type { ProgressCallback } from '../agent-core.js'

interface ToolServices {
  asyncTaskManager: AsyncTaskManager
}

interface StartAsyncTaskArgs {
  project_id: string
  task: AsyncTaskType
}

interface GetTaskStatusArgs {
  task_id: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

export function toolStartAsyncTask (services: ToolServices): Tool {
  return {
    definition: {
      name: 'start_async_task',
      description: 'Start a long-running async project task to avoid request timeouts.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          task: {
            type: 'string',
            enum: ['rebuild'],
            description: 'Async task type'
          }
        },
        required: ['project_id', 'task']
      }
    },
    handler: async (args, onProgress) => {
      const { project_id, task } = args as unknown as StartAsyncTaskArgs
      onProgress?.('🕒 正在启动异步任务...', `${task} @ ${project_id}`)
      const snapshot = services.asyncTaskManager.startTask(project_id, task)
      onProgress?.('✅ 异步任务已启动', snapshot.task_id)
      return snapshot
    }
  }
}

export function toolGetTaskStatus (services: ToolServices): Tool {
  return {
    definition: {
      name: 'get_task_status',
      description: 'Get the current status, progress, and final result of an async task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Async task ID'
          }
        },
        required: ['task_id']
      }
    },
    handler: async (args) => {
      const { task_id } = args as unknown as GetTaskStatusArgs
      const snapshot = services.asyncTaskManager.getTask(task_id)
      if (!snapshot) {
        throw new Error(`Async task not found: ${task_id}`)
      }
      return snapshot
    }
  }
}
