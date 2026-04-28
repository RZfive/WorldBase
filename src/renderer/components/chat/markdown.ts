import hljs from 'highlight.js'
import katex from 'katex'
import { marked } from 'marked'

marked.setOptions({
  breaks: true,
  gfm: true
})

marked.use({
  extensions: [
    {
      name: 'highlight',
      level: 'inline',
      start (src) {
        return src.indexOf('==')
      },
      tokenizer (src) {
        if (!src.startsWith('==')) return undefined

        let searchIndex = 2
        while (searchIndex < src.length) {
          const closingIndex = src.indexOf('==', searchIndex)
          if (closingIndex === -1) return undefined
          if (!isEscaped(src, closingIndex)) {
            const text = src.slice(2, closingIndex)
            if (!text.trim()) return undefined

            return {
              type: 'highlight',
              raw: src.slice(0, closingIndex + 2),
              text,
              tokens: this.lexer.inlineTokens(text)
            }
          }
          searchIndex = closingIndex + 2
        }
      },
      childTokens: ['tokens'],
      renderer (token) {
        return `<mark>${this.parser.parseInline(token.tokens || [])}</mark>`
      }
    }
  ],
  renderer: {
    code ({ text, lang }) {
      const language = lang?.trim().toLowerCase()
      const hasLanguage = !!language && hljs.getLanguage(language)
      const highlighted = hasLanguage
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : escapeHtml(text)
      const languageLabel = hasLanguage
        ? `<span class="markdown-code-language">${escapeHtml(language)}</span>`
        : ''

      return [
        '<div class="markdown-code-block">',
        languageLabel,
        `<pre><code class="hljs${hasLanguage ? ` language-${escapeHtmlAttr(language)}` : ''}">${highlighted}</code></pre>`,
        '</div>'
      ].join('')
    }
  }
})

const ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'i', 'em', 'strong', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img', 'hr', 'div', 'span', 'details', 'summary', 'input',
  'section', 'article', 'header', 'main', 'aside', 'footer', 'nav', 'figure', 'figcaption',
  'abbr', 'cite', 'dfn', 'q', 'small', 'time', 'wbr'
])

const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'class', 'id', 'width', 'height',
  'colspan', 'rowspan', 'scope', 'align', 'valign',
  'open', 'datetime', 'start', 'reversed', 'type', 'checked', 'disabled', 'style'
])

const ALLOWED_STYLE_PROPS = new Set([
  'background',
  'background-color',
  'border',
  'border-color',
  'border-radius',
  'border-style',
  'border-width',
  'color',
  'display',
  'font-style',
  'font-weight',
  'height',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'text-align',
  'text-decoration',
  'width'
])

interface FootnoteDefinition {
  id: string
  content: string
}

interface RenderMarkdownOptions {
  footnotes?: Map<string, FootnoteDefinition>
  enableFootnotes?: boolean
}

interface ExtractedDisplayMath {
  text: string
  expressions: Map<string, string>
}

function canCloseFenceMarker (marker: string, fenceMarker: string): boolean {
  return (
    marker.length >= fenceMarker.length &&
    marker[0] === fenceMarker[0] &&
    /^(`+|~+)$/.test(marker)
  )
}

function sanitizeNode (node: Element): void {
  const children = Array.from(node.childNodes)
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element
      const tag = el.tagName.toLowerCase()

      if (!ALLOWED_TAGS.has(tag)) {
        const textNode = document.createTextNode(el.textContent || '')
        node.replaceChild(textNode, el)
        continue
      }

      const attrs = Array.from(el.attributes)
      for (const attr of attrs) {
        const name = attr.name.toLowerCase()
        if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) {
          el.removeAttribute(attr.name)
          continue
        }
        if (name === 'style') {
          const safeStyle = sanitizeStyleValue(el.ownerDocument, attr.value)
          if (safeStyle) el.setAttribute('style', safeStyle)
          else el.removeAttribute(attr.name)
          continue
        }
        if (name === 'href' || name === 'src') {
          const sanitizedUrl = sanitizeUrlValue(name, attr.value)
          if (sanitizedUrl) {
            el.setAttribute(attr.name, sanitizedUrl)
          } else {
            el.removeAttribute(attr.name)
          }
        }
      }

      sanitizeNode(el)
    }
  }
}

function sanitizeUrlValue (attrName: string, value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\s*(javascript|vbscript):/i.test(trimmed)) return null
  if (attrName === 'href' && /^\s*data:/i.test(trimmed)) return null
  if (attrName === 'src' && /^\s*data:/i.test(trimmed)) {
    return /^\s*data:image\/(?:png|gif|jpe?g|webp|bmp|x-icon);base64,[a-z0-9+/=]+$/i.test(trimmed)
      ? trimmed
      : null
  }
  return trimmed
}

function isEscaped (text: string, index: number): boolean {
  let backslashCount = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashCount += 1
  return backslashCount % 2 === 1
}

function findClosingToken (text: string, token: string, startIndex: number): number {
  let searchIndex = startIndex
  while (searchIndex < text.length) {
    const foundIndex = text.indexOf(token, searchIndex)
    if (foundIndex === -1) return -1
    if (!isEscaped(text, foundIndex)) return foundIndex
    searchIndex = foundIndex + 1
  }
  return -1
}

function findInlineDollarClosing (text: string, startIndex: number): number {
  let searchIndex = startIndex
  while (searchIndex < text.length) {
    const foundIndex = text.indexOf('$', searchIndex)
    if (foundIndex === -1) return -1
    if (text[foundIndex + 1] === '$') {
      searchIndex = foundIndex + 2
      continue
    }
    if (!isEscaped(text, foundIndex)) return foundIndex
    searchIndex = foundIndex + 1
  }
  return -1
}

type MathSegment =
  | { type: 'text'; value: string }
  | { type: 'math'; value: string; displayMode: boolean }

function tokenizeMath (text: string): MathSegment[] {
  const segments: MathSegment[] = []
  let cursor = 0
  let textStart = 0

  const pushText = (endIndex: number) => {
    if (endIndex > textStart) segments.push({ type: 'text', value: text.slice(textStart, endIndex) })
  }

  while (cursor < text.length) {
    let openToken = ''
    let closeToken = ''
    let displayMode = false
    let closeIndex = -1

    if (text.startsWith('$$', cursor) && !isEscaped(text, cursor)) {
      openToken = '$$'
      closeToken = '$$'
      displayMode = true
      closeIndex = findClosingToken(text, closeToken, cursor + openToken.length)
    } else if (text.startsWith('\\[', cursor) && !isEscaped(text, cursor)) {
      openToken = '\\['
      closeToken = '\\]'
      displayMode = true
      closeIndex = findClosingToken(text, closeToken, cursor + openToken.length)
    } else if (text.startsWith('\\(', cursor) && !isEscaped(text, cursor)) {
      openToken = '\\('
      closeToken = '\\)'
      closeIndex = findClosingToken(text, closeToken, cursor + openToken.length)
    } else if (text[cursor] === '$' && text[cursor + 1] !== '$' && !isEscaped(text, cursor)) {
      openToken = '$'
      closeToken = '$'
      closeIndex = findInlineDollarClosing(text, cursor + openToken.length)
    }

    if (!openToken || closeIndex === -1) {
      cursor += 1
      continue
    }

    const formula = text.slice(cursor + openToken.length, closeIndex)
    const isInlineDollar = openToken === '$'
    if (!formula.trim() || (isInlineDollar && formula.includes('\n'))) {
      cursor += openToken.length
      continue
    }

    pushText(cursor)
    segments.push({ type: 'math', value: formula, displayMode })
    cursor = closeIndex + closeToken.length
    textStart = cursor
  }

  pushText(text.length)
  return segments
}

function shouldRenderMath (text: string): boolean {
  return text.includes('$') || text.includes('\\(') || text.includes('\\[')
}

function shouldSkipMathNode (node: Node): boolean {
  let current = node.parentElement
  while (current) {
    const tag = current.tagName.toLowerCase()
    if (['code', 'pre', 'kbd', 'samp', 'var', 'script', 'style', 'textarea'].includes(tag)) return true
    if (current.classList.contains('katex')) return true
    current = current.parentElement
  }
  return false
}

function appendKatex (fragment: DocumentFragment, doc: Document, expression: string, displayMode: boolean): void {
  const template = doc.createElement('template')
  template.innerHTML = katex.renderToString(normalizeMathExpression(doc, expression, displayMode), {
    displayMode,
    output: 'htmlAndMathml',
    throwOnError: false,
    strict: 'ignore'
  })
  fragment.appendChild(template.content)
}

function sanitizeStyleValue (doc: Document, value: string): string {
  const element = doc.createElement('div')
  element.setAttribute('style', value)

  const safeDeclarations: string[] = []
  for (const property of Array.from(element.style)) {
    const normalizedProperty = property.toLowerCase()
    const propertyValue = element.style.getPropertyValue(property).trim()

    if (!ALLOWED_STYLE_PROPS.has(normalizedProperty)) continue
    if (!propertyValue) continue
    if (/(?:expression|javascript:|vbscript:|@import|url\s*\()/i.test(propertyValue)) continue
    const isStyleAllowed = typeof CSS === 'undefined' || !CSS.supports ||
      CSS.supports(normalizedProperty, propertyValue)
    if (!isStyleAllowed) continue

    safeDeclarations.push(`${normalizedProperty}: ${propertyValue}`)
  }

  return safeDeclarations.join('; ')
}

function escapeHtml (value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeHtmlAttr (value: string): string {
  return escapeHtml(value).replaceAll('`', '&#96;')
}

function trimTrailingEmptyLines (lines: string[]): string[] {
  let endIndex = lines.length
  while (endIndex > 0 && !lines[endIndex - 1].trim()) endIndex -= 1
  return lines.slice(0, endIndex)
}

function decodeHtmlEntities (doc: Document, value: string): string {
  const textarea = doc.createElement('textarea')
  textarea.innerHTML = value
  return textarea.value
}

function normalizeMathExpression (doc: Document, expression: string, displayMode: boolean): string {
  const decoded = decodeHtmlEntities(doc, expression).replace(/\r\n?/g, '\n')
  if (!displayMode) return decoded

  return decoded
    .split('\n')
    .map(line => {
      const trimmedEnd = line.replace(/\s+$/g, '')
      // Some chat outputs paste row separators as a single trailing backslash at EOL.
      // KaTeX expects "\\" for matrix/aligned line breaks, so normalize that case.
      if (trimmedEnd.endsWith('\\') && !trimmedEnd.endsWith('\\\\')) return `${trimmedEnd}\\`
      return line
    })
    .join('\n')
}

function extractDisplayMathBlocks (text: string): ExtractedDisplayMath {
  const lines = text.split(/\r?\n/)
  const keptLines: string[] = []
  const expressions = new Map<string, string>()

  let inFence = false
  let fenceMarker = ''

  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (canCloseFenceMarker(marker, fenceMarker)) {
        inFence = false
        fenceMarker = ''
      }

      keptLines.push(line)
      index += 1
      continue
    }

    if (!inFence) {
      const delimiterMatch = line.match(/^ {0,3}(\$\$|\\\[)\s*$/)
      if (delimiterMatch) {
        const delimiter = delimiterMatch[1]
        const closePattern = delimiter === '$$' ? /^ {0,3}\$\$\s*$/ : /^ {0,3}\\\]\s*$/
        const expressionLines: string[] = []
        index += 1

        while (index < lines.length && !closePattern.test(lines[index])) {
          expressionLines.push(lines[index])
          index += 1
        }

        if (index < lines.length) {
          const placeholder = `CHATMATHBLOCK${expressions.size}TOKEN`
          expressions.set(placeholder, expressionLines.join('\n'))
          keptLines.push(placeholder)
          index += 1
          continue
        }

        keptLines.push(line, ...expressionLines)
        break
      }
    }

    keptLines.push(line)
    index += 1
  }

  return {
    text: keptLines.join('\n'),
    expressions
  }
}

function extractFootnotes (text: string): { text: string, footnotes: Map<string, FootnoteDefinition> } {
  const lines = text.split(/\r?\n/)
  const keptLines: string[] = []
  const footnotes = new Map<string, FootnoteDefinition>()

  let inFence = false
  let fenceMarker = ''

  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (canCloseFenceMarker(marker, fenceMarker)) {
        inFence = false
        fenceMarker = ''
      }

      keptLines.push(line)
      index += 1
      continue
    }

    if (!inFence) {
      const definitionMatch = line.match(/^\[\^([^\]\s]+)\]:[ \t]*(.*)$/)
      if (definitionMatch) {
        const id = definitionMatch[1]
        const contentLines = [definitionMatch[2]]
        index += 1

        while (index < lines.length) {
          const continuationLine = lines[index]
          if (!continuationLine.trim()) {
            contentLines.push('')
            index += 1
            continue
          }
          if (/^(?: {4}|\t)/.test(continuationLine)) {
            contentLines.push(continuationLine.replace(/^(?: {4}|\t)/, ''))
            index += 1
            continue
          }
          break
        }

        footnotes.set(id, {
          id,
          content: trimTrailingEmptyLines(contentLines).join('\n')
        })
        continue
      }
    }

    keptLines.push(line)
    index += 1
  }

  return {
    text: keptLines.join('\n').replace(/\n{3,}/g, '\n\n'),
    footnotes
  }
}

type FootnoteTextSegment =
  | { type: 'text'; value: string }
  | { type: 'reference'; id: string }

function tokenizeFootnoteReferences (text: string, footnotes: Map<string, FootnoteDefinition>): FootnoteTextSegment[] {
  const segments: FootnoteTextSegment[] = []
  const matcher = /\[\^([^\]\s]+)\]/g
  let lastIndex = 0

  for (const match of text.matchAll(matcher)) {
    const matchIndex = match.index ?? -1
    const footnoteId = match[1]
    if (matchIndex === -1 || !footnotes.has(footnoteId) || isEscaped(text, matchIndex)) continue

    if (matchIndex > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, matchIndex) })
    segments.push({ type: 'reference', id: footnoteId })
    lastIndex = matchIndex + match[0].length
  }

  if (lastIndex === 0) return [{ type: 'text', value: text }]
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) })

  return segments
}

function shouldSkipFootnoteNode (node: Node): boolean {
  let current = node.parentElement
  while (current) {
    const tag = current.tagName.toLowerCase()
    if (['code', 'pre', 'kbd', 'samp', 'var', 'script', 'style', 'textarea'].includes(tag)) return true
    if (current.classList.contains('katex') || current.classList.contains('md-footnotes')) return true
    current = current.parentElement
  }
  return false
}

function createFootnoteSlug (id: string): string {
  const slug = id
    .trim()
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return slug || 'note'
}

function createFootnoteReference (doc: Document, id: string, number: number): HTMLElement {
  const slug = createFootnoteSlug(id)
  const sup = doc.createElement('sup')
  sup.className = 'md-footnote-ref'

  const link = doc.createElement('a')
  link.href = `#fn-${slug}`
  link.id = `fnref-${slug}`
  link.textContent = String(number)

  sup.appendChild(link)
  return sup
}

function renderInlineFootnoteReferences (root: Element, footnotes: Map<string, FootnoteDefinition>): string[] {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []

  let currentNode = walker.nextNode()
  while (currentNode) {
    if (!shouldSkipFootnoteNode(currentNode)) {
      const value = currentNode.nodeValue || ''
      if (value.includes('[^')) textNodes.push(currentNode as Text)
    }
    currentNode = walker.nextNode()
  }

  const order: string[] = []
  const numbers = new Map<string, number>()

  for (const textNode of textNodes) {
    const parent = textNode.parentNode
    if (!parent) continue

    const segments = tokenizeFootnoteReferences(textNode.nodeValue || '', footnotes)
    if (!segments.some(segment => segment.type === 'reference')) continue

    const fragment = doc.createDocumentFragment()
    for (const segment of segments) {
      if (segment.type === 'text') {
        if (segment.value) fragment.appendChild(doc.createTextNode(segment.value))
        continue
      }

      if (!numbers.has(segment.id)) {
        numbers.set(segment.id, order.length + 1)
        order.push(segment.id)
      }

      fragment.appendChild(createFootnoteReference(doc, segment.id, numbers.get(segment.id)!))
    }

    parent.replaceChild(fragment, textNode)
  }

  return order
}

function appendFootnotesSection (root: Element, orderedIds: string[], footnotes: Map<string, FootnoteDefinition>): void {
  if (!orderedIds.length) return

  const doc = root.ownerDocument
  const section = doc.createElement('section')
  section.className = 'md-footnotes'

  const separator = doc.createElement('hr')
  section.appendChild(separator)

  const list = doc.createElement('ol')
  section.appendChild(list)

  for (const [index, id] of orderedIds.entries()) {
    const definition = footnotes.get(id)
    if (!definition) continue

    const slug = createFootnoteSlug(id)
    const item = doc.createElement('li')
    item.id = `fn-${slug}`
    item.innerHTML = renderMarkdownInternal(definition.content, {
      footnotes,
      enableFootnotes: false
    })

    const backReference = doc.createElement('a')
    backReference.className = 'md-footnote-backref'
    backReference.href = `#fnref-${slug}`
    backReference.setAttribute('aria-label', `Back to footnote reference ${index + 1}`)
    backReference.textContent = '↩'
    item.appendChild(backReference)

    list.appendChild(item)
  }

  root.appendChild(section)
}

function renderFootnotes (root: Element, footnotes: Map<string, FootnoteDefinition>): void {
  if (!footnotes.size) return
  const orderedIds = renderInlineFootnoteReferences(root, footnotes)
  appendFootnotesSection(root, orderedIds, footnotes)
}

type DisplayMathPlaceholderSegment =
  | { type: 'text'; value: string }
  | { type: 'math'; placeholder: string }

function tokenizeDisplayMathPlaceholders (text: string, expressions: Map<string, string>): DisplayMathPlaceholderSegment[] {
  const segments: DisplayMathPlaceholderSegment[] = []
  const matcher = /CHATMATHBLOCK\d+TOKEN/g
  let lastIndex = 0

  for (const match of text.matchAll(matcher)) {
    const matchIndex = match.index ?? -1
    const placeholder = match[0]
    if (matchIndex === -1 || !expressions.has(placeholder)) continue

    if (matchIndex > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, matchIndex) })
    segments.push({ type: 'math', placeholder })
    lastIndex = matchIndex + placeholder.length
  }

  if (lastIndex === 0) return [{ type: 'text', value: text }]
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) })

  return segments
}

function renderDisplayMathPlaceholders (root: Element, expressions: Map<string, string>): void {
  if (!expressions.size) return

  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []

  let currentNode = walker.nextNode()
  while (currentNode) {
    const value = currentNode.nodeValue || ''
    if (value.includes('CHATMATHBLOCK')) textNodes.push(currentNode as Text)
    currentNode = walker.nextNode()
  }

  for (const textNode of textNodes) {
    const parent = textNode.parentNode
    if (!parent) continue

    const segments = tokenizeDisplayMathPlaceholders(textNode.nodeValue || '', expressions)
    if (!segments.some(segment => segment.type === 'math')) continue

    const fragment = doc.createDocumentFragment()
    for (const segment of segments) {
      if (segment.type === 'text') {
        if (segment.value) fragment.appendChild(doc.createTextNode(segment.value))
        continue
      }

      appendKatex(fragment, doc, expressions.get(segment.placeholder) || '', true)
    }

    parent.replaceChild(fragment, textNode)
  }
}

function renderMathInNode (root: Element): void {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []

  let currentNode = walker.nextNode()
  while (currentNode) {
    if (!shouldSkipMathNode(currentNode)) {
      const value = currentNode.nodeValue || ''
      if (value.trim() && shouldRenderMath(value)) textNodes.push(currentNode as Text)
    }
    currentNode = walker.nextNode()
  }

  for (const textNode of textNodes) {
    const parent = textNode.parentNode
    if (!parent) continue

    const segments = tokenizeMath(textNode.nodeValue || '')
    if (!segments.some(segment => segment.type === 'math')) continue

    const fragment = doc.createDocumentFragment()
    for (const segment of segments) {
      if (segment.type === 'text') {
        fragment.appendChild(doc.createTextNode(segment.value))
        continue
      }
      appendKatex(fragment, doc, segment.value, segment.displayMode)
    }

    parent.replaceChild(fragment, textNode)
  }
}

function sanitizeHtmlInternal (html: string, renderMath: boolean): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''

  sanitizeNode(root)
  if (renderMath) renderMathInNode(root)
  return root.innerHTML
}

function renderMarkdownInternal (text: string, options: RenderMarkdownOptions = {}): string {
  if (!text) return ''

  const shouldExtractFootnotes = options.enableFootnotes !== false
  const extracted = shouldExtractFootnotes ? extractFootnotes(text) : { text, footnotes: options.footnotes || new Map() }
  const extractedDisplayMath = extractDisplayMathBlocks(extracted.text)
  const raw = marked.parse(extractedDisplayMath.text, { async: false }) as string

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div>${raw}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''

  sanitizeNode(root)
  renderDisplayMathPlaceholders(root, extractedDisplayMath.expressions)
  renderMathInNode(root)
  if (shouldExtractFootnotes) renderFootnotes(root, extracted.footnotes)

  return root.innerHTML
}

export function sanitizeHtml (html: string): string {
  return sanitizeHtmlInternal(html, false)
}

export function renderMarkdown (text: string): string {
  return renderMarkdownInternal(text)
}
