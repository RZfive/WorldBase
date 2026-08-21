import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { BrowserAutomationAction, BrowserAutomationActionResult, BrowserAutomationInputField, BrowserAutomationSnapshot } from '../../../../shared/page-automation-types.js'
import type { DocumentArtifact } from './document-types.js'
import type { ToolServices } from './index.js'

interface ReadCurrentPageArgs {
  max_chars?: number
}

interface InteractCurrentPageArgs {
  action: BrowserAutomationAction['type']
  selector?: string
  text?: string
  append?: boolean
  top?: number
  left?: number
  timeout_ms?: number
  value?: string
  label?: string
  index?: number
  fields?: BrowserAutomationInputField[]
  offset?: number
  max_chars?: number
  script?: string
  key?: string
}

interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

const DEFAULT_MAX_CHARS = 8000
const MAX_TEXT_CHARS = 60000

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
      text: String(args.text || ''),
      append: Boolean(args.append)
    }
  }

  if (action === 'select') {
    return {
      type: 'select',
      selector: String(args.selector || '').trim(),
      value: typeof args.value === 'string' ? args.value : undefined,
      label: typeof args.label === 'string' ? args.label : undefined,
      index: typeof args.index === 'number' ? args.index : undefined
    }
  }

  if (action === 'batch_input') {
    const rawFields = Array.isArray(args.fields) ? args.fields : []
    const fields: BrowserAutomationInputField[] = rawFields
      .filter((field): field is Record<string, unknown> => typeof field === 'object' && field !== null)
      .map((field) => ({
        selector: String(field.selector || '').trim(),
        text: String(field.text || ''),
        append: Boolean(field.append)
      }))
      .filter((field) => field.selector)
    return { type: 'batch_input', fields }
  }

  if (action === 'extract') {
    return {
      type: 'extract',
      selector: typeof args.selector === 'string' ? args.selector.trim() : undefined,
      offset: typeof args.offset === 'number' ? Math.max(0, args.offset) : undefined,
      maxChars: typeof args.max_chars === 'number' ? args.max_chars : undefined
    }
  }

  if (action === 'evaluate') {
    return {
      type: 'evaluate',
      script: String(args.script || '')
    }
  }

  if (action === 'hover') {
    return {
      type: 'hover',
      selector: String(args.selector || '').trim()
    }
  }

  if (action === 'focus') {
    return {
      type: 'focus',
      selector: String(args.selector || '').trim()
    }
  }

  if (action === 'press_key') {
    return {
      type: 'press_key',
      selector: typeof args.selector === 'string' ? args.selector.trim() : undefined,
      key: String(args.key || '')
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

  throw new Error('Unsupported page action.')
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

function buildReadPageGuidance (fullTextAvailable: boolean): string {
  const lines = [
    'Use interact_current_page to click, type, scroll, select dropdowns, batch-fill forms, extract text by offset, run small scripts, hover, focus, or press keys.',
    'For long pages, call interact_current_page with action "extract" and offset/max_chars to paginate, or use save_current_page_as_document to persist the page as a chunked document and read it with read_document.'
  ]
  if (!fullTextAvailable) {
    lines.push('The snapshot preview was truncated; use extract or save_current_page_as_document to read the full page.')
  }
  return lines.join(' ')
}

interface SaveCurrentPageAsDocumentArgs {
  selector?: string
  file_name?: string
}

function splitTextIntoNodes (text: string): Array<{ id: string; text: string }> {
  const blocks = text.split(/\n\s*\n+/).map((block) => block.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return blocks.map((block) => ({
    id: crypto.randomUUID(),
    text: block
  }))
}

function buildPageDocumentArtifact (args: SaveCurrentPageAsDocumentArgs, fullText: string): DocumentArtifact {
  const now = new Date().toISOString()
  const fileName = (args.file_name || 'current-page').replace(/[\\/:*?"<>|]/g, '_')
  const nodes = splitTextIntoNodes(fullText)

  return {
    id: crypto.randomUUID(),
    filePath: `page://${fileName}`,
    fileName: `${fileName}.txt`,
    fileSize: fullText.length,
    fileType: 'unknown',
    plainText: fullText,
    nodes: nodes.map((node, index) => ({
      id: node.id,
      type: 'paragraph' as const,
      text: node.text,
      level: 1,
      pageIndex: index + 1
    })),
    importedAt: now,
    render: {
      kind: 'html' as const,
      source: 'fallback' as const,
      status: 'unavailable' as const,
      generatedAt: now
    }
  }
}

export function toolReadCurrentPage (services: ToolServices): Tool {
  return {
    definition: {
      name: 'read_current_page',
      description: 'Inspect the currently active in-app browser page. Returns the live page title, URL, a readable text preview, a list of likely interactive elements, and detected form fields with selectors. Use this before interacting with the page.',
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
        guidance: buildReadPageGuidance(sanitized.fullTextAvailable)
      }
    }
  }
}

export function toolInteractCurrentPage (services: ToolServices): Tool {
  return {
    definition: {
      name: 'interact_current_page',
      description: 'Interact with the currently active in-app browser page. Supports click, input, select, batch_input, extract, evaluate, hover, focus, press_key, scroll, and wait actions. Use selectors returned by read_current_page.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['click', 'input', 'select', 'batch_input', 'extract', 'evaluate', 'hover', 'focus', 'press_key', 'scroll', 'wait'],
            description: 'The type of interaction to perform on the active page.'
          },
          selector: {
            type: 'string',
            description: 'Required for click, input, select, hover, focus. CSS selector of the target element. Optional for extract (defaults to full page) and press_key (defaults to focused element).'
          },
          text: {
            type: 'string',
            description: 'Required for input. Text to type into the selected field.'
          },
          append: {
            type: 'boolean',
            description: 'For input/batch_input: if true, append text instead of replacing the current value.'
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
          },
          value: {
            type: 'string',
            description: 'For select: the option value to select.'
          },
          label: {
            type: 'string',
            description: 'For select: the visible text label of the option to select.'
          },
          index: {
            type: 'integer',
            description: 'For select: the zero-based index of the option to select.'
          },
          fields: {
            type: 'array',
            description: 'Required for batch_input. Array of {selector, text, append?} objects to fill multiple fields at once.',
            items: {
              type: 'object',
              properties: {
                selector: { type: 'string' },
                text: { type: 'string' },
                append: { type: 'boolean' }
              },
              required: ['selector', 'text']
            }
          },
          offset: {
            type: 'integer',
            description: 'For extract: zero-based character offset to start reading from. Use with max_chars to paginate.'
          },
          max_chars: {
            type: 'integer',
            description: 'For extract: maximum characters to return per page. Default 60000.'
          },
          script: {
            type: 'string',
            description: 'For evaluate: a JavaScript expression to run in the page context. Return a JSON-serializable value.'
          },
          key: {
            type: 'string',
            description: 'Required for press_key. The key to press (e.g. "Enter", "Tab", "a").'
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

export function toolFillCurrentPageForm (services: ToolServices): Tool {
  return {
    definition: {
      name: 'fill_current_page_form',
      description: 'Batch-fill form fields on the currently active in-app browser page. Provide an array of field entries with selectors from read_current_page and the text to enter. This is a convenience wrapper around interact_current_page action=batch_input.',
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            description: 'Array of {selector, text, append?} objects. Selectors come from read_current_page formFields or interactiveElements.',
            items: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'CSS selector of the input, textarea, or select element.' },
                text: { type: 'string', description: 'Text or option value to set.' },
                append: { type: 'boolean', description: 'If true, append instead of replacing.' }
              },
              required: ['selector', 'text']
            }
          }
        },
        required: ['fields']
      }
    },
    handler: async (args, onProgress) => {
      const rawFields = Array.isArray(args.fields) ? args.fields : []
      const fields: BrowserAutomationInputField[] = rawFields
        .filter((field): field is Record<string, unknown> => typeof field === 'object' && field !== null)
        .map((field) => ({
          selector: String(field.selector || '').trim(),
          text: String(field.text || ''),
          append: Boolean(field.append)
        }))
        .filter((field) => field.selector)

      if (fields.length === 0) {
        throw new Error('At least one valid field with a selector is required.')
      }

      onProgress?.('📝 Filling current page form', `${fields.length} field(s)`)
      const actionResult = await ensurePageActionResult(services, { type: 'batch_input', fields })
      const snapshot = sanitizeSnapshot(await ensurePageSnapshot(services), DEFAULT_MAX_CHARS)
      onProgress?.('✅ Form fill complete', `filled ${(actionResult as BrowserAutomationActionResult).filled ?? '?'} field(s)`)
      return {
        ok: true,
        action_result: actionResult,
        page: snapshot
      }
    }
  }
}

export function toolSaveCurrentPageAsDocument (services: ToolServices): Tool {
  return {
    definition: {
      name: 'save_current_page_as_document',
      description: 'Save the full text of the currently active in-app browser page as a document artifact. Returns an artifact_id that can be read with read_document in chunks, searched, and revisited later. Useful for long pages or when the model needs to search or repeatedly reference the page content.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'Optional CSS selector to extract only a portion of the page. Defaults to the full page body.'
          },
          file_name: {
            type: 'string',
            description: 'Optional display name for the saved document. Defaults to "current-page".'
          }
        }
      }
    },
    handler: async (args, onProgress) => {
      if (!services.documentStore) {
        throw new Error('Document store is unavailable in this session.')
      }

      const normalized: SaveCurrentPageAsDocumentArgs = {
        selector: typeof args.selector === 'string' ? args.selector.trim() : undefined,
        file_name: typeof args.file_name === 'string' ? args.file_name.trim() : undefined
      }

      onProgress?.('📄 Saving current page as document', normalized.file_name || 'current-page')
      const extractResult = await ensurePageActionResult(services, {
        type: 'extract',
        selector: normalized.selector,
        maxChars: 0
      })

      const fullText = extractResult.text
      if (typeof fullText !== 'string' || fullText.length === 0) {
        throw new Error('No text could be extracted from the current page.')
      }

      const artifact = buildPageDocumentArtifact(normalized, fullText)
      services.documentStore.addArtifact(artifact)
      onProgress?.('✅ Page saved as document', `${artifact.fileName} (${artifact.plainText.length} chars)`)
      return {
        ok: true,
        artifact_id: artifact.id,
        file_name: artifact.fileName,
        total_length: artifact.plainText.length,
        node_count: artifact.nodes.length,
        guidance: `Use read_document with artifact_id="${artifact.id}" to read the page in chunks.`
      }
    }
  }
}
