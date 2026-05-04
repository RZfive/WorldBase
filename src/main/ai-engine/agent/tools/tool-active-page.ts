import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { BrowserAutomationAction, BrowserAutomationActionResult, BrowserAutomationSnapshot } from '../../../../shared/page-automation-types.js'
import type { ToolServices } from './index.js'

interface ReadCurrentPageArgs {
  max_chars?: number
}

interface InteractCurrentPageArgs {
  action: BrowserAutomationAction['type']
  selector?: string
  text?: string
  top?: number
  left?: number
  timeout_ms?: number
}

interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

const DEFAULT_MAX_CHARS = 1600
const MAX_TEXT_CHARS = 6000

function truncateText (value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`
}

function normalizeReadArgs (args: Record<string, unknown>): ReadCurrentPageArgs {
  return {
    max_chars: typeof args.max_chars === 'number' ? args.max_chars : undefined
  }
}

function normalizeInteractArgs (args: Record<string, unknown>): BrowserAutomationAction {
  const action = String(args.action || '').trim() as BrowserAutomationAction['type']

  if (action === 'click') {
    return {
      type: 'click',
      selector: String(args.selector || '').trim()
    }
  }

  if (action === 'input') {
    return {
      type: 'input',
      selector: String(args.selector || '').trim(),
      text: String(args.text || '')
    }
  }

  if (action === 'scroll') {
    return {
      type: 'scroll',
      top: Number(args.top || 0),
      left: typeof args.left === 'number' ? args.left : undefined
    }
  }

  if (action === 'wait') {
    return {
      type: 'wait',
      timeoutMs: Math.max(0, Number(args.timeout_ms || 0))
    }
  }

  throw new Error('Unsupported page action. Use click, input, scroll, or wait.')
}

function sanitizeSnapshot (snapshot: BrowserAutomationSnapshot, maxChars: number): BrowserAutomationSnapshot {
  return {
    ...snapshot,
    textPreview: truncateText(snapshot.textPreview, Math.min(Math.max(400, maxChars), MAX_TEXT_CHARS))
  }
}

async function ensurePageSnapshot (services: ToolServices): Promise<BrowserAutomationSnapshot> {
  if (!services.readActivePage) {
    throw new Error('Current page automation is unavailable in this session.')
  }

  return await services.readActivePage()
}

async function ensurePageActionResult (services: ToolServices, action: BrowserAutomationAction): Promise<BrowserAutomationActionResult> {
  if (!services.interactWithActivePage) {
    throw new Error('Current page interaction is unavailable in this session.')
  }

  return await services.interactWithActivePage(action)
}

export function toolReadCurrentPage (services: ToolServices): Tool {
  return {
    definition: {
      name: 'read_current_page',
      description: 'Inspect the currently active in-app browser page. Returns the live page title, URL, a readable text preview, and a list of likely interactive elements with selectors. Use this before interacting with the page.',
      parameters: {
        type: 'object',
        properties: {
          max_chars: {
            type: 'integer',
            description: `Maximum characters from the live page text preview to return. Default ${DEFAULT_MAX_CHARS}, maximum ${MAX_TEXT_CHARS}.`
          }
        }
      }
    },
    handler: async (args, onProgress) => {
      const normalized = normalizeReadArgs(args)
      onProgress?.('🌐 Reading current page', 'Collecting a live snapshot from the active embedded browser page')
      const snapshot = await ensurePageSnapshot(services)
      const sanitized = sanitizeSnapshot(snapshot, normalized.max_chars || DEFAULT_MAX_CHARS)
      onProgress?.('✅ Current page captured', sanitized.title || sanitized.url)
      return {
        ok: true,
        page: sanitized,
        guidance: 'Use interact_current_page with one of the returned selectors to click, type, scroll, or wait on this page.'
      }
    }
  }
}

export function toolInteractCurrentPage (services: ToolServices): Tool {
  return {
    definition: {
      name: 'interact_current_page',
      description: 'Interact with the currently active in-app browser page. Supports click, input, scroll, and wait actions against selectors from read_current_page.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['click', 'input', 'scroll', 'wait'],
            description: 'The type of interaction to perform on the active page.'
          },
          selector: {
            type: 'string',
            description: 'Required for click and input. CSS selector of the target element.'
          },
          text: {
            type: 'string',
            description: 'Required for input. Text to type into the selected field.'
          },
          top: {
            type: 'number',
            description: 'Required for scroll. Vertical scroll offset in pixels.'
          },
          left: {
            type: 'number',
            description: 'Optional horizontal scroll offset in pixels for scroll.'
          },
          timeout_ms: {
            type: 'integer',
            description: 'Required for wait. Milliseconds to wait before continuing.'
          }
        },
        required: ['action']
      }
    },
    handler: async (args, onProgress) => {
      const action = normalizeInteractArgs(args)
      onProgress?.('🖱️ Interacting with current page', `${action.type}${'selector' in action && action.selector ? `: ${action.selector}` : ''}`)
      const actionResult = await ensurePageActionResult(services, action)
      const snapshot = sanitizeSnapshot(await ensurePageSnapshot(services), DEFAULT_MAX_CHARS)
      onProgress?.('✅ Page interaction complete', action.type)
      return {
        ok: true,
        action_result: actionResult,
        page: snapshot
      }
    }
  }
}