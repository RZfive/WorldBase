import type { LocalAgentKind, LocalAgentSessionSummary } from '../../shared/local-agent-types.js'
import { localAgentId } from './registry.js'

function records (value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const container = value as Record<string, unknown>
    for (const key of ['sessions', 'agents', 'items', 'data']) {
      if (Array.isArray(container[key])) return records(container[key])
    }
  }
  return []
}

function stringValue (value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function timestampValue (value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 100_000_000_000 ? value * 1000 : value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  const text = stringValue(value)
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : undefined
}

/** Keep platform payload parsing separate from subprocess and group policy. */
export function parseLocalAgentSessions (kind: LocalAgentKind, raw: string): LocalAgentSessionSummary[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const agentId = localAgentId(kind)
  return records(parsed).flatMap(item => {
    const sessionId = kind === 'codex'
      ? stringValue(item.id)
      : stringValue(item.session_id) || stringValue(item.sessionId) || stringValue(item.conversation_id) || stringValue(item.conversationId) || stringValue(item.id)
    if (!sessionId) return []
    if (kind === 'opencode' && stringValue(item.id)?.startsWith('ses_') === false) return []
    if (item.ephemeral === true || item.parentThreadId) return []
    const status = typeof item.status === 'object' && item.status !== null ? (item.status as { type?: unknown }).type : item.status
    const title = stringValue(item.title) || stringValue(item.name) || stringValue(item.summary)
      || stringValue(item.description) || stringValue(item.preview) || sessionId
    return [{
      agentId,
      sessionId,
      title: title.slice(0, 180),
      cwd: stringValue(item.cwd) || stringValue(item.cwd_path) || stringValue(item.directory) || stringValue(item.projectPath),
      updatedAt: timestampValue(item.updated_at) || timestampValue(item.updatedAt) || timestampValue(item.updated),
      status: stringValue(status)
    }]
  })
}
