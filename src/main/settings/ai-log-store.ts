import fs from 'node:fs'
import path from 'node:path'
import { t } from '../i18n/main-i18n.js'
import type { AIExecutionAuthMode } from './settings-store.js'

export interface AILogContentPart {
  type: string
  text?: string
  image_url?: { url: string }
}

export type AILogMessageContent = string | AILogContentPart[]

export interface AILogToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface AILogMessage {
  role: string
  content: AILogMessageContent
  tool_calls?: AILogToolCall[]
  tool_call_id?: string
  reasoning_content?: string
}

export interface AILogToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AILogProviderCall {
  id: string
  startedAt: string
  finishedAt?: string
  stream: boolean
  model: string
  baseUrl: string
  request: {
    messages: AILogMessage[]
    tools: AILogToolDefinition[]
  }
  response?: {
    message?: AILogMessage
    raw?: unknown
  }
  error?: string
}

export interface AILogToolExecution {
  id: string
  name: string
  startedAt: string
  finishedAt: string
  rawArguments: string
  parsedArguments: Record<string, unknown>
  result: unknown
  status: 'completed' | 'failed'
  error?: string
}

export interface AILogErrorEntry {
  id: string
  time: string
  scope: 'provider' | 'tool' | 'stream' | 'session'
  message: string
  detail?: unknown
}

export type AILogSessionStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface AILogSession {
  id: string
  startedAt: string
  updatedAt: string
  finishedAt?: string
  status: AILogSessionStatus
  providerId?: string
  modelId?: string
  authMode?: AIExecutionAuthMode
  targetProjectId?: string | null
  uploadedMessages: AILogMessage[]
  providerCalls: AILogProviderCall[]
  toolExecutions: AILogToolExecution[]
  errors: AILogErrorEntry[]
  finalAssistantMessage?: AILogMessage
}

export interface AILogConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  sessions: AILogSession[]
}

export interface AILogConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  sessionCount: number
  lastStatus?: AILogSessionStatus
  errorCount: number
}

export interface AILogSessionStartInput {
  conversationId: string
  title: string
  sessionId: string
  uploadedMessages: AILogMessage[]
  providerId?: string
  modelId?: string
  authMode?: AIExecutionAuthMode
  targetProjectId?: string | null
}

export interface AILogSessionLogger {
  logProviderCallStart: (payload: {
    stream: boolean
    model: string
    baseUrl: string
    messages: AILogMessage[]
    tools: AILogToolDefinition[]
  }) => string
  logProviderCallSuccess: (callId: string, payload: { message?: AILogMessage; raw?: unknown }) => void
  logProviderCallFailure: (callId: string, error: Error, detail?: unknown) => void
  logToolExecution: (payload: {
    name: string
    rawArguments: string
    parsedArguments: Record<string, unknown>
    result: unknown
    status: 'completed' | 'failed'
    error?: string
  }) => void
  logError: (scope: AILogErrorEntry['scope'], error: Error | string, detail?: unknown) => void
  finish: (status: AILogSessionStatus, finalAssistantMessage?: AILogMessage) => void
}

function sanitizeId (value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '')
}

function createLogId (): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `${Date.now().toString(36)}_${random}`
}

function cloneJson<T> (value: T): T {
  if (value === undefined || value === null) {
    return value
  }

  try {
    // Logs are stored as JSON for inspection only, so bigint values are stringified on purpose to keep writes stable.
    const serialized = JSON.stringify(value, (_key, currentValue) => {
      return typeof currentValue === 'bigint' ? currentValue.toString() : currentValue
    })
    if (serialized === undefined) {
      return value
    }
    return JSON.parse(serialized) as T
  } catch {
    return String(value) as T
  }
}

function extractMessageText (message?: AILogMessage): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content.trim()
  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text || '')
    .join(' ')
    .trim()
}

export class AILogStore {
  private dir: string

  constructor (userDataPath: string) {
    this.dir = path.join(userDataPath, 'ai-logs')
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true })
    }
  }

  private filePath (conversationId: string): string {
    return path.join(this.dir, `${sanitizeId(conversationId)}.json`)
  }

  private readConversation (conversationId: string): AILogConversation | null {
    const filePath = this.filePath(conversationId)
    if (!fs.existsSync(filePath)) return null
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AILogConversation
    } catch {
      return null
    }
  }

  private writeConversation (conversation: AILogConversation): void {
    conversation.updatedAt = new Date().toISOString()
    fs.writeFileSync(this.filePath(conversation.id), JSON.stringify(conversation, null, 2), 'utf-8')
  }

  listConversations (): AILogConversationSummary[] {
    const files = fs.readdirSync(this.dir).filter(file => file.endsWith('.json'))
    const summaries: AILogConversationSummary[] = []

    for (const file of files) {
      try {
        const conversation = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as AILogConversation
        const sessions = Array.isArray(conversation.sessions) ? conversation.sessions : []
        const lastSession = sessions[sessions.length - 1]
        const errorCount = sessions.reduce((total, session) => total + (Array.isArray(session.errors) ? session.errors.length : 0), 0)
        summaries.push({
          id: conversation.id,
          title: conversation.title,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          sessionCount: sessions.length,
          lastStatus: lastSession?.status,
          errorCount
        })
      } catch {
        // Skip corrupted log files.
      }
    }

    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  getConversation (conversationId: string): AILogConversation | null {
    return this.readConversation(conversationId)
  }

  deleteConversation (conversationId: string): boolean {
    const filePath = this.filePath(conversationId)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)
    return true
  }

  createSessionLogger (input: AILogSessionStartInput): AILogSessionLogger {
    const createdAt = new Date().toISOString()
    const uploadedMessages = cloneJson(input.uploadedMessages)
    const initialTitle = input.title || extractMessageText(uploadedMessages.find(message => message.role === 'user')) || t('mainDialog.untitledConversation')
    const conversation = this.readConversation(input.conversationId) || {
      id: input.conversationId,
      title: initialTitle,
      createdAt,
      updatedAt: createdAt,
      sessions: []
    }

    conversation.title = input.title || conversation.title || initialTitle

    const session: AILogSession = {
      id: input.sessionId,
      startedAt: createdAt,
      updatedAt: createdAt,
      status: 'running',
      providerId: input.providerId,
      modelId: input.modelId,
      authMode: input.authMode,
      targetProjectId: input.targetProjectId,
      uploadedMessages,
      providerCalls: [],
      toolExecutions: [],
      errors: []
    }

    const existingIndex = conversation.sessions.findIndex(item => item.id === input.sessionId)
    if (existingIndex >= 0) {
      conversation.sessions[existingIndex] = session
    } else {
      conversation.sessions.push(session)
    }
    this.writeConversation(conversation)

    const mutateSession = (mutator: (nextSession: AILogSession, nextConversation: AILogConversation) => void): void => {
      const nextConversation = this.readConversation(input.conversationId)
      if (!nextConversation) return
      const nextSession = nextConversation.sessions.find(item => item.id === input.sessionId)
      if (!nextSession) return
      mutator(nextSession, nextConversation)
      nextSession.updatedAt = new Date().toISOString()
      this.writeConversation(nextConversation)
    }

    return {
      logProviderCallStart: ({ stream, model, baseUrl, messages, tools }) => {
        const callId = createLogId()
        mutateSession((nextSession) => {
          nextSession.providerCalls.push({
            id: callId,
            startedAt: new Date().toISOString(),
            stream,
            model,
            baseUrl,
            request: {
              messages: cloneJson(messages),
              tools: cloneJson(tools)
            }
          })
        })
        return callId
      },
      logProviderCallSuccess: (callId, payload) => {
        mutateSession((nextSession) => {
          const call = nextSession.providerCalls.find(item => item.id === callId)
          if (!call) return
          call.finishedAt = new Date().toISOString()
          call.response = cloneJson(payload)
        })
      },
      logProviderCallFailure: (callId, error, detail) => {
        mutateSession((nextSession) => {
          const call = nextSession.providerCalls.find(item => item.id === callId)
          if (call) {
            call.finishedAt = new Date().toISOString()
            call.error = error.message
          }
          nextSession.errors.push({
            id: createLogId(),
            time: new Date().toISOString(),
            scope: 'provider',
            message: error.message,
            detail: cloneJson(detail)
          })
        })
      },
      logToolExecution: ({ name, rawArguments, parsedArguments, result, status, error }) => {
        mutateSession((nextSession) => {
          nextSession.toolExecutions.push({
            id: createLogId(),
            name,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            rawArguments,
            parsedArguments: cloneJson(parsedArguments),
            result: cloneJson(result),
            status,
            error
          })
        })
      },
      logError: (scope, error, detail) => {
        const message = typeof error === 'string' ? error : error.message
        mutateSession((nextSession) => {
          nextSession.errors.push({
            id: createLogId(),
            time: new Date().toISOString(),
            scope,
            message,
            detail: cloneJson(detail)
          })
        })
      },
      finish: (status, finalAssistantMessage) => {
        mutateSession((nextSession, nextConversation) => {
          nextSession.status = status
          nextSession.finishedAt = new Date().toISOString()
          if (finalAssistantMessage) {
            nextSession.finalAssistantMessage = cloneJson(finalAssistantMessage)
          }
          nextConversation.title = input.title || nextConversation.title || initialTitle
        })
      }
    }
  }
}
