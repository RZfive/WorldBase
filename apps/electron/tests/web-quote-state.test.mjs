import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addWebQuote,
  buildWebQuotesPrompt,
  extractWebQuoteRefs,
  getWebQuote,
  pruneWebQuotes,
  removeWebQuote,
  WEB_QUOTE_TAG_PATTERN
} from '../src/renderer/components/chat/panel/web-quote-state.ts'

test('addWebQuote parks the entry and returns a parseable [[web:]] tag', () => {
  const tag = addWebQuote({
    url: 'https://example.com/article',
    title: 'Example Article',
    kind: 'selection',
    text: '第一段引用内容，用于验证停靠与标签格式。'
  })

  const match = [...tag.matchAll(WEB_QUOTE_TAG_PATTERN)]
  assert.equal(match.length, 1)
  const id = match[0][1]
  assert.ok(id.startsWith('w'))
  assert.equal(match[0][2], '第一段引用内容，用于验证停靠与标签格…')

  const entry = getWebQuote(id)
  assert.equal(entry.kind, 'selection')
  assert.equal(entry.url, 'https://example.com/article')
  assert.equal(entry.title, 'Example Article')
  removeWebQuote(id)
  assert.equal(getWebQuote(id), undefined)
})

test('extractWebQuoteRefs replaces tags, dedupes ids and keeps plain text intact', () => {
  const tagA = addWebQuote({ url: 'https://a.example', title: 'A', kind: 'selection', text: '内容A' })
  const tagB = addWebQuote({ url: 'https://b.example', title: 'B', kind: 'element', text: '内容B' })
  const idA = [...tagA.matchAll(WEB_QUOTE_TAG_PATTERN)][0][1]
  const idB = [...tagB.matchAll(WEB_QUOTE_TAG_PATTERN)][0][1]

  const { quoteIds, normalizedText } = extractWebQuoteRefs(`请结合 ${tagA} ${tagB} ${tagA} 回答问题`)
  assert.deepEqual(quoteIds, [idA, idB])
  assert.ok(normalizedText.includes('网页引用「'))
  assert.ok(!normalizedText.includes('[[web:'))
  assert.ok(normalizedText.includes('回答问题'))
})

test('extractWebQuoteRefs falls back to a generic label for empty tag labels', () => {
  const { normalizedText } = extractWebQuoteRefs('前缀 [[web:w123|]] 后缀')
  assert.equal(normalizedText, '前缀 网页引用「网页引用」 后缀')
})

test('buildWebQuotesPrompt renders selection and element blocks with provenance', () => {
  const tagSel = addWebQuote({ url: 'https://s.example', title: 'Selection Page', kind: 'selection', text: '选区正文' })
  const tagEl = addWebQuote({
    url: 'https://e.example',
    title: 'Element Page',
    kind: 'element',
    text: '元素正文',
    selector: 'div.card:nth-of-type(2)',
    tag: 'div'
  })
  const idSel = [...tagSel.matchAll(WEB_QUOTE_TAG_PATTERN)][0][1]
  const idEl = [...tagEl.matchAll(WEB_QUOTE_TAG_PATTERN)][0][1]

  const prompt = buildWebQuotesPrompt([idSel, idEl, 'missing-id'])
  const blocks = prompt.split('\n\n')
  assert.equal(blocks.length, 2)

  assert.ok(blocks[0].startsWith('【网页引用：Selection Page — https://s.example】'))
  assert.ok(blocks[0].includes('选区正文'))
  assert.ok(blocks[0].endsWith('【引用结束】'))

  assert.ok(blocks[1].startsWith('【网页元素引用：Element Page — https://e.example】'))
  assert.ok(blocks[1].includes('（元素：<div> div.card:nth-of-type(2)）'))
  assert.ok(blocks[1].endsWith('【引用结束】'))
})

test('pruneWebQuotes drops only entries missing from the keep set', () => {
  const tagKeep = addWebQuote({ url: 'https://keep.example', title: 'keep', kind: 'selection', text: 'keep' })
  const tagDrop = addWebQuote({ url: 'https://drop.example', title: 'drop', kind: 'selection', text: 'drop' })
  const idKeep = [...tagKeep.matchAll(WEB_QUOTE_TAG_PATTERN)][0][1]
  const idDrop = [...tagDrop.matchAll(WEB_QUOTE_TAG_PATTERN)][0][1]

  pruneWebQuotes([idKeep])
  assert.ok(getWebQuote(idKeep))
  assert.equal(getWebQuote(idDrop), undefined)
})
