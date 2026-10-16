import crypto from 'node:crypto'
import type { ChatMessage, Conversation } from './chat-history.js'

/**
 * A message row as returned by the harness `conversation.messages` bridge
 * (the Rust SQLite store). Only the fields reconciliation needs are typed;
 * the row carries more (parts, tool_calls, tool_results).
 */
export interface HarnessMessageRow {
  role: string
  content: string
  created_at?: string | null
}

export interface ConversationReconcileResult {
  conversation: Conversation
  restoredCount: number
}

/** Safety bound: a single open must never flood the panel with restored rows. */
const MAX_RESTORED_MESSAGES = 50

function normalizeText (value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/**
 * Plain text of a renderer message, comparable with the harness row content.
 * The harness stores the provider-visible text, which can carry appended
 * context (document/workspace injections), so matching is prefix-based.
 */
function rendererMessageText (message: ChatMessage): string {
  const content = message.content
  const text = typeof content === 'string'
    ? content
    : content
      .filter(part => part.type === 'text')
      .map(part => part.text || '')
      .join(' ')
  return normalizeText(text)
}

function harnessRowMatchesText (row: HarnessMessageRow, text: string): boolean {
  if (normalizeText(row.content) === text) return true
  // Tolerate provider-context appended after the composed user message.
  return text.length >= 8 && normalizeText(row.content).startsWith(text)
}

/**
 * Restore assistant turns that were streamed into the harness SQLite store
 * but never persisted to the conversation JSON. A stream that ends abnormally
 * (app quit, reload, provider error) leaves the JSON holding only the last
 * user message - the harness rows after it are the lost turn.
 *
 * Guards keep the restore conservative:
 * - The JSON must end on a user message (the persisted-composer signature);
 *   otherwise the stores are considered intentionally in sync.
 * - The harness row carrying that user message must exist (scan from the end;
 *   content can repeat across turns).
 * - Only rows created after the conversation's last JSON save are eligible.
 *   In-place edit & resend legitimately truncates the tail and bumps
 *   `updatedAt`, so its removed rows (created earlier) stay deleted.
 * - Provider tool rows (empty content) stay harness-internal and are skipped.
 */
export function restoreLostHarnessMessages (conversation: Conversation, rows: HarnessMessageRow[]): ConversationReconcileResult {
  const messages = Array.isArray(conversation.messages) ? conversation.messages : []
  if (messages.length === 0 || rows.length === 0) {
    return { conversation, restoredCount: 0 }
  }

  const last = messages[messages.length - 1]
  if (last.role !== 'user') {
    return { conversation, restoredCount: 0 }
  }
  const lastText = rendererMessageText(last)
  if (!lastText) {
    return { conversation, restoredCount: 0 }
  }

  const cutoffMs = Date.parse(conversation.updatedAt)
  if (!Number.isFinite(cutoffMs)) {
    return { conversation, restoredCount: 0 }
  }

  let anchor = -1
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.role === 'user' && harnessRowMatchesText(row, lastText)) {
      anchor = index
      break
    }
  }
  if (anchor < 0) {
    return { conversation, restoredCount: 0 }
  }

  const restored: ChatMessage[] = []
  for (const row of rows.slice(anchor + 1)) {
    if (restored.length >= MAX_RESTORED_MESSAGES) break
    if (row.role !== 'assistant' && row.role !== 'user') continue
    const text = normalizeText(row.content)
    if (!text) continue
    const createdMs = row.created_at ? Date.parse(row.created_at) : Number.NaN
    if (!Number.isFinite(createdMs) || createdMs <= cutoffMs) continue
    const messageId = crypto.randomUUID()
    restored.push({
      role: row.role,
      id: messageId,
      content: row.content.trim(),
      blocks: [{ id: crypto.randomUUID(), kind: 'content', content: row.content.trim() }]
    })
  }

  if (restored.length === 0) {
    return { conversation, restoredCount: 0 }
  }

  return {
    conversation: {
      ...conversation,
      messages: [...messages, ...restored]
    },
    restoredCount: restored.length
  }
}
