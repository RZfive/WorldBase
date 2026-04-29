import { toPng } from 'html-to-image'
import { getContentParts } from './message-utils'
import type { MessageContent } from './types'

const EXPORT_ACTIVE_CLASS = 'the-world-chat-export-active'

// Injected into <head> during export to switch the captured element to light-theme
// and fix code-block overflow so the full content is visible.
const EXPORT_HEAD_CSS = `
.${EXPORT_ACTIVE_CLASS} {
  --app-text: #1e293b;
  --app-text-strong: #0f172a;
  --app-text-soft: #334155;
  --app-text-muted: #64748b;
  --app-text-faint: #94a3b8;
  --app-accent: #0284c7;
  --app-accent-strong: #0369a1;
  --app-accent-soft: rgba(2, 132, 199, 0.12);
  --app-accent-glow: rgba(2, 132, 199, 0.2);
  --app-panel: #ffffff;
  --app-panel-strong: #f8fafc;
  --app-panel-muted: rgba(15, 23, 42, 0.04);
  --app-panel-subtle: rgba(15, 23, 42, 0.03);
  --app-border: rgba(15, 23, 42, 0.08);
  --app-border-strong: rgba(15, 23, 42, 0.14);
  background: #ffffff !important;
  transition: none !important;
}

.${EXPORT_ACTIVE_CLASS} * {
  transition: none !important;
}

.${EXPORT_ACTIVE_CLASS} [data-export-ignore='true'] {
  display: none !important;
}

.${EXPORT_ACTIVE_CLASS} pre,
.${EXPORT_ACTIVE_CLASS} .markdown-code-block pre,
.${EXPORT_ACTIVE_CLASS} .hljs {
  overflow: visible !important;
  white-space: pre-wrap !important;
  word-break: break-word !important;
  overflow-wrap: anywhere !important;
}

.${EXPORT_ACTIVE_CLASS} .markdown-body p,
.${EXPORT_ACTIVE_CLASS} .markdown-body li,
.${EXPORT_ACTIVE_CLASS} .markdown-body td,
.${EXPORT_ACTIVE_CLASS} .markdown-body th {
  overflow-wrap: anywhere;
  word-break: break-word;
}

.${EXPORT_ACTIVE_CLASS} .markdown-body table {
  table-layout: fixed;
}

.${EXPORT_ACTIVE_CLASS} .mermaid-diagram-canvas {
  overflow: visible !important;
}

.${EXPORT_ACTIVE_CLASS} .mermaid-diagram-svg {
  min-width: 0 !important;
  width: 100% !important;
}

.${EXPORT_ACTIVE_CLASS} .mermaid-diagram.inline .mermaid-diagram-svg svg,
.${EXPORT_ACTIVE_CLASS} .mermaid-diagram.preview .mermaid-diagram-svg svg {
  display: block !important;
  width: 100% !important;
  max-width: 100% !important;
  height: auto !important;
}
`

function padTimePart (value: number): string {
  return String(value).padStart(2, '0')
}

function triggerDownload (href: string, fileName: string): void {
  const link = document.createElement('a')
  link.href = href
  link.download = fileName
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export function buildAssistantExportBaseName (date = new Date()): string {
  const stamp = [
    date.getFullYear(),
    padTimePart(date.getMonth() + 1),
    padTimePart(date.getDate())
  ].join('') + '-' + [
    padTimePart(date.getHours()),
    padTimePart(date.getMinutes()),
    padTimePart(date.getSeconds())
  ].join('')

  return `the-world-ai-response-${stamp}`
}

export function messageContentToMarkdown (content: MessageContent): string {
  if (typeof content === 'string') {
    return content
  }

  return getContentParts(content)
    .map(part => {
      if (part.type === 'text') {
        return part.text ?? ''
      }
      if (part.type === 'image_url' && part.image_url?.url) {
        return `![](${part.image_url.url})`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function waitForAnimationFrame (): Promise<void> {
  return new Promise(resolve => window.requestAnimationFrame(() => resolve()))
}

async function waitForImagesReady (root: ParentNode): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'))
  await Promise.all(images.map(async image => {
    if (image.complete && image.naturalWidth > 0) return

    if (typeof image.decode === 'function') {
      try {
        await image.decode()
        return
      } catch {
        // Fall back to load/error events below.
      }
    }

    await new Promise<void>(resolve => {
      const handleDone = () => {
        image.removeEventListener('load', handleDone)
        image.removeEventListener('error', handleDone)
        resolve()
      }
      image.addEventListener('load', handleDone, { once: true })
      image.addEventListener('error', handleDone, { once: true })
    })
  }))
}

async function waitForMermaidReady (root: ParentNode, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (root.querySelector('.mermaid-diagram-placeholder') && Date.now() < deadline) {
    await waitForAnimationFrame()
  }
}

export async function renderElementToPngDataUrl (element: HTMLElement): Promise<string> {
  if ('fonts' in document) {
    await document.fonts.ready
  }

  await waitForMermaidReady(element)
  await waitForImagesReady(element)

  // Inject light-theme overrides directly into <head> so html-to-image reads the
  // correct computed styles from the live element without any offscreen cloning.
  const exportStyle = document.createElement('style')
  exportStyle.textContent = EXPORT_HEAD_CSS
  document.head.appendChild(exportStyle)
  element.classList.add(EXPORT_ACTIVE_CLASS)

  // Allow one frame for styles and layout to settle.
  await waitForAnimationFrame()

  const bounds = element.getBoundingClientRect()
  const captureHeight = Math.max(element.scrollHeight, Math.ceil(bounds.height))

  try {
    return await toPng(element, {
      backgroundColor: '#ffffff',
      cacheBust: true,
      pixelRatio: Math.max(2, Math.min(window.devicePixelRatio || 1, 3)),
      width: Math.ceil(bounds.width),
      height: captureHeight
    })
  } finally {
    element.classList.remove(EXPORT_ACTIVE_CLASS)
    exportStyle.remove()
  }
}

export function downloadMarkdownFile (content: string, fileName: string): void {
  const file = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const objectUrl = URL.createObjectURL(file)

  triggerDownload(objectUrl, fileName)
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

export function downloadDataUrlFile (dataUrl: string, fileName: string): void {
  triggerDownload(dataUrl, fileName)
}