import katex from 'katex'
import { marked } from 'marked'

marked.setOptions({
  breaks: true,
  gfm: true
})

const ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'i', 'em', 'strong', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img', 'hr', 'div', 'span', 'details', 'summary',
  'section', 'article', 'header', 'main', 'aside', 'footer', 'nav', 'figure', 'figcaption',
  'abbr', 'cite', 'dfn', 'q', 'small', 'time', 'wbr'
])

const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'class', 'id', 'width', 'height',
  'colspan', 'rowspan', 'scope', 'align', 'valign',
  'open', 'datetime', 'start', 'reversed', 'type'
])

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
        if ((name === 'href' || name === 'src') && /^\s*(javascript|data|vbscript):/i.test(attr.value)) {
          el.removeAttribute(attr.name)
        }
      }

      sanitizeNode(el)
    }
  }
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
  template.innerHTML = katex.renderToString(expression, {
    displayMode,
    output: 'htmlAndMathml',
    throwOnError: false,
    strict: 'ignore'
  })
  fragment.appendChild(template.content)
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

export function sanitizeHtml (html: string): string {
  return sanitizeHtmlInternal(html, false)
}

export function renderMarkdown (text: string): string {
  if (!text) return ''
  const raw = marked.parse(text, { async: false }) as string
  return sanitizeHtmlInternal(raw, true)
}
