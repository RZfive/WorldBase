import type { LocalAgentKind } from '../../shared/local-agent-types.js'

export interface ParsedLocalCliEvent {
  sessionId?: string
  text?: string
  thinking?: string
  responseComplete?: boolean
  toolName?: string
  detail?: string
  error?: string
}

function record (value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text (value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function contentText (value: unknown): string | undefined {
  if (typeof value === 'string') return text(value)
  const item = record(value)
  if (!item) return undefined
  return text(item.text) || text(item.content)
}

function codexEvent (event: Record<string, unknown>): ParsedLocalCliEvent {
  const type = text(event.type) || ''
  const item = record(event.item)
  if (type === 'thread.started') return { sessionId: text(event.thread_id) }
  if (type === 'turn.failed') return { error: text(record(event.error)?.message) || 'Turn failed.' }
  if (item && (type === 'item.started' || type === 'item.completed')) {
    const itemType = text(item.item_type) || text(item.type)
    if (itemType === 'command_execution') {
      return { toolName: 'shell', detail: text(item.command) }
    }
    if (itemType === 'file_change') {
      return { toolName: 'file_change', detail: text(item.status) }
    }
    if (type === 'item.completed' && itemType === 'agent_message') {
      return { text: text(item.text), responseComplete: true }
    }
    if (type === 'item.completed' && itemType === 'reasoning') {
      return { thinking: text(item.text) }
    }
  }
  return {}
}

function claudeEvent (event: Record<string, unknown>): ParsedLocalCliEvent {
  const type = text(event.type) || ''
  const message = record(event.message)
  const content = Array.isArray(message?.content) ? message.content : []
  const thinking = content.map(raw => {
    const item = record(raw)
    return item?.type === 'thinking' ? text(item.thinking) : undefined
  }).filter(Boolean).join('\n\n') || undefined
  for (const raw of content) {
    const item = record(raw)
    if (!item) continue
    if (item.type === 'tool_use') {
      const input = record(item.input)
      return {
        sessionId: text(event.session_id),
        thinking,
        toolName: text(item.name),
        detail: text(input?.command) || text(input?.file_path)
      }
    }
    if (item.type === 'text' && type === 'assistant') {
      return { sessionId: text(event.session_id), thinking, text: text(item.text) }
    }
  }
  if (type === 'result') {
    if (event.is_error === true) return { error: contentText(event.result) || 'Turn failed.', sessionId: text(event.session_id) }
    return { sessionId: text(event.session_id), text: contentText(event.result), responseComplete: true }
  }
  return { sessionId: text(event.session_id), thinking }
}

function opencodeEvent (event: Record<string, unknown>): ParsedLocalCliEvent {
  const part = record(event.part)
  const sessionId = text(part?.sessionID) || text(part?.session_id) || text(event.sessionID)
  if (text(event.type) === 'error') return { sessionId, error: text(record(record(event.error)?.data)?.message) || 'Turn failed.' }
  if (text(event.type) === 'text') return { sessionId, text: contentText(part?.text) }
  if (text(event.type) === 'reasoning') return { sessionId, thinking: contentText(part?.text) }
  if (text(event.type) === 'tool_use') {
    const state = record(part?.state)
    const input = record(state?.input)
    return { sessionId, toolName: text(part?.tool), detail: text(input?.command) || text(input?.filePath) }
  }
  return { sessionId }
}

/** Parse one stdout line without exposing raw event payloads to the group. */
export function parseLocalAgentCliLine (kind: LocalAgentKind, line: string): ParsedLocalCliEvent | null {
  if (!line.trim()) return null
  try {
    const parsed = record(JSON.parse(line))
    if (!parsed) return null
    if (kind === 'codex') return codexEvent(parsed)
    if (kind === 'claude') return claudeEvent(parsed)
    return opencodeEvent(parsed)
  } catch {
    return null
  }
}
