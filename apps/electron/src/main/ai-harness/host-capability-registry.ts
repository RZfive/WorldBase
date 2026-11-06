import type { OpenDialogOptions } from 'electron'
import {
  HOST_CAPABILITY_IDS,
  HOST_CAPABILITY_MAX_OUTPUT_BYTES,
  hostCapabilityErrorResponse,
  isHostCapabilityId,
  measureHostCapabilityValue,
  parseHostCapabilityInvokeRequest,
  type HostCapabilityId,
  type HostCapabilityInvokeResponse
} from './host-capability-contract.js'

export interface HostCapabilityOpenDialogOptions {
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string, extensions: string[] }>
  properties: Array<'openFile' | 'openDirectory' | 'multiSelections'>
}

export interface HostCapabilityOpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

export interface HostCapabilityNotificationOptions {
  title: string
  body: string
}

export interface HostCapabilityAdapters {
  showOpenDialog: (options: HostCapabilityOpenDialogOptions) => Promise<HostCapabilityOpenDialogResult>
  openExternal: (url: string) => Promise<void>
  showNotification: (options: HostCapabilityNotificationOptions) => void | Promise<void>
}

export interface HostCapabilityInvokeContext {
  callId: string
  deadlineMs: number
}

export type HostCapabilityHandler = (
  input: unknown,
  context: HostCapabilityInvokeContext
) => unknown | Promise<unknown>

export interface HostCapabilityRegistryOptions {
  adapters?: Partial<HostCapabilityAdapters>
  handlers?: Partial<Record<HostCapabilityId, HostCapabilityHandler>>
}

export interface HostCapabilityStateSnapshot {
  stateVersion: number
  capabilities: Array<{ id: HostCapabilityId, availability: 'available' }>
}

const MAX_REMEMBERED_RESPONSES = 512
const MAX_TEXT_LENGTH = 2000
const MAX_TITLE_LENGTH = 200
const MAX_FILTERS = 20
const MAX_FILTER_EXTENSIONS = 20

class HostCapabilityTimeoutError extends Error {}

class HostCapabilityHandlerError extends Error {
  readonly code: string

  constructor (code: string, message: string) {
    super(message)
    this.code = code
  }
}

const defaultAdapters: HostCapabilityAdapters = {
  async showOpenDialog (options) {
    const { dialog } = await import('electron')
    return await dialog.showOpenDialog(options as OpenDialogOptions)
  },
  async openExternal (url) {
    const { shell } = await import('electron')
    await shell.openExternal(url)
  },
  async showNotification (options) {
    const { Notification } = await import('electron')
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) {
      throw new Error('Notifications are not supported on this platform')
    }
    new Notification(options).show()
  }
}

function recordFromInput (input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
}

function stringField (record: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.slice(0, maxLength) : undefined
}

function sanitizeFilters (value: unknown): Array<{ name: string, extensions: string[] }> | undefined {
  if (!Array.isArray(value)) return undefined
  const filters: Array<{ name: string, extensions: string[] }> = []
  for (const entry of value.slice(0, MAX_FILTERS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const name = stringField(record, 'name', MAX_TITLE_LENGTH)
    const extensions = Array.isArray(record.extensions)
      ? record.extensions
          .filter((extension): extension is string => typeof extension === 'string' && Boolean(extension))
          .slice(0, MAX_FILTER_EXTENSIONS)
          .map(extension => extension.slice(0, 32))
      : []
    if (name && extensions.length > 0) filters.push({ name, extensions })
  }
  return filters.length > 0 ? filters : undefined
}

function pickFileHandler (adapters: HostCapabilityAdapters): HostCapabilityHandler {
  return async input => {
    const record = recordFromInput(input)
    const options: HostCapabilityOpenDialogOptions = { properties: ['openFile'] }
    const title = stringField(record, 'title', MAX_TITLE_LENGTH)
    if (title) options.title = title
    const defaultPath = stringField(record, 'defaultPath', MAX_TEXT_LENGTH)
    if (defaultPath) options.defaultPath = defaultPath
    if (record.multiSelections === true) options.properties.push('multiSelections')
    const filters = sanitizeFilters(record.filters)
    if (filters) options.filters = filters
    const result = await adapters.showOpenDialog(options)
    return {
      canceled: result.canceled === true,
      filePaths: Array.isArray(result.filePaths)
        ? result.filePaths.filter((filePath): filePath is string => typeof filePath === 'string')
        : []
    }
  }
}

function openExternalHandler (adapters: HostCapabilityAdapters): HostCapabilityHandler {
  return async input => {
    const record = recordFromInput(input)
    // The Rust manifest publishes `target`; older callers used `url`.
    const rawUrl = stringField(record, 'target', MAX_TEXT_LENGTH) ??
      stringField(record, 'url', MAX_TEXT_LENGTH)
    if (!rawUrl) throw new HostCapabilityHandlerError('invalid_input', 'open_external requires target')
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw new HostCapabilityHandlerError('invalid_input', 'open_external received an invalid url')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new HostCapabilityHandlerError('unsafe_url', 'open_external only accepts http and https urls')
    }
    await adapters.openExternal(parsed.href)
    return { opened: true, url: parsed.href }
  }
}

function notificationHandler (adapters: HostCapabilityAdapters): HostCapabilityHandler {
  return async input => {
    const record = recordFromInput(input)
    // The Rust manifest publishes `message`; `body` is the legacy alias.
    const body = stringField(record, 'message', MAX_TEXT_LENGTH) ??
      stringField(record, 'body', MAX_TEXT_LENGTH)
    if (!body) throw new HostCapabilityHandlerError('invalid_input', 'notification.show requires message')
    const title = stringField(record, 'title', MAX_TITLE_LENGTH) ?? 'WorldBase'
    await adapters.showNotification({ title, body })
    return { shown: true }
  }
}

function duplicateResponse (callId: string): HostCapabilityInvokeResponse {
  // Rust accepts only ok/error. A duplicate must not re-run the handler, but
  // the bridge still needs a well-formed failure instead of a second result.
  return hostCapabilityErrorResponse(
    'duplicate_call_id',
    `duplicate host capability callId ignored: ${callId}`
  )
}

export class HostCapabilityRegistry {
  private readonly adapters: HostCapabilityAdapters
  private readonly handlers = new Map<HostCapabilityId, HostCapabilityHandler>()
  private readonly responses = new Map<string, HostCapabilityInvokeResponse>()
  private readonly inFlight = new Set<string>()
  private stateVersion = 0

  constructor (options: HostCapabilityRegistryOptions = {}) {
    this.adapters = { ...defaultAdapters, ...(options.adapters ?? {}) }
    const defaults: Record<HostCapabilityId, HostCapabilityHandler> = {
      'host.fs.pick_file': pickFileHandler(this.adapters),
      'host.shell.open_external': openExternalHandler(this.adapters),
      'host.notification.show': notificationHandler(this.adapters)
    }
    for (const id of HOST_CAPABILITY_IDS) {
      this.register(id, options.handlers?.[id] ?? defaults[id])
    }
  }

  register (id: HostCapabilityId, handler: HostCapabilityHandler): void {
    if (!isHostCapabilityId(id)) throw new Error(`Unknown host capability: ${String(id)}`)
    this.handlers.set(id, handler)
    this.stateVersion += 1
  }

  getStateVersion (): number {
    return this.stateVersion
  }

  getStateSnapshot (): HostCapabilityStateSnapshot {
    return {
      stateVersion: this.stateVersion,
      capabilities: HOST_CAPABILITY_IDS.map(id => ({ id, availability: 'available' }))
    }
  }

  async invoke (payload: unknown): Promise<HostCapabilityInvokeResponse> {
    const parsed = parseHostCapabilityInvokeRequest(payload)
    if (!parsed.ok) return hostCapabilityErrorResponse(parsed.code, parsed.message)
    const request = parsed.request
    if (this.responses.has(request.callId) || this.inFlight.has(request.callId)) {
      return duplicateResponse(request.callId)
    }
    const handler = this.handlers.get(request.registeredHostCapabilityId)
    if (!handler) {
      return hostCapabilityErrorResponse(
        'unknown_host_capability',
        `host capability is not registered: ${request.registeredHostCapabilityId}`
      )
    }

    this.inFlight.add(request.callId)
    let timer: ReturnType<typeof setTimeout> | undefined
    let response: HostCapabilityInvokeResponse
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HostCapabilityTimeoutError('deadline exceeded')), request.deadline)
      })
      const output = await Promise.race([
        Promise.resolve(handler(request.input, {
          callId: request.callId,
          deadlineMs: request.deadline
        })),
        timeout
      ])
      const outputBytes = measureHostCapabilityValue(output)
      if (outputBytes === null) {
        response = hostCapabilityErrorResponse('invalid_output', 'host capability output must be JSON serializable')
      } else if (outputBytes > HOST_CAPABILITY_MAX_OUTPUT_BYTES) {
        response = hostCapabilityErrorResponse('output_too_large', 'host capability output exceeds the size limit')
      } else {
        response = { status: 'ok', output, warnings: [] }
      }
    } catch (error) {
      if (error instanceof HostCapabilityTimeoutError) {
        response = hostCapabilityErrorResponse('deadline_exceeded', 'host capability deadline exceeded')
      } else if (error instanceof HostCapabilityHandlerError) {
        response = hostCapabilityErrorResponse(error.code, error.message)
      } else {
        response = hostCapabilityErrorResponse(
          'host_capability_failed',
          error instanceof Error ? error.message : String(error)
        )
      }
    } finally {
      if (timer) clearTimeout(timer)
      this.inFlight.delete(request.callId)
    }
    this.remember(request.callId, response)
    return response
  }

  private remember (callId: string, response: HostCapabilityInvokeResponse): void {
    this.responses.set(callId, response)
    while (this.responses.size > MAX_REMEMBERED_RESPONSES) {
      const oldest = this.responses.keys().next().value
      if (typeof oldest !== 'string') break
      this.responses.delete(oldest)
    }
  }
}

export function createHostCapabilityRegistry (
  options: HostCapabilityRegistryOptions = {}
): HostCapabilityRegistry {
  return new HostCapabilityRegistry(options)
}
