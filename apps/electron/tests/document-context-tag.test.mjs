/**
 * Unit tests for the `[[docfile:]]` whole-document context tag helpers.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  DOCFILE_TAG_PATTERN,
  MAX_DOCFILE_CONTEXT_CHARS,
  buildDocfileTag,
  extractDocfileTagRefs,
  buildDocfileContextPrompt
} = await import('../src/shared/document-context-tag.ts')

test('buildDocfileTag embeds the optional label', () => {
  assert.equal(buildDocfileTag('abc-123'), '[[docfile:abc-123]]')
  assert.equal(buildDocfileTag('abc-123', '计划.md'), '[[docfile:abc-123|计划.md]]')
})

test('extractDocfileTagRefs collects ids, labels the visible text, and dedupes', () => {
  const text = '帮我改写 [[docfile:doc_a|计划.md]] 和 [[docfile:doc_b]]，再对比 [[docfile:doc_a|计划.md]]'
  const { artifactIds, normalizedText } = extractDocfileTagRefs(text, DOCFILE_TAG_PATTERN)
  assert.deepEqual(artifactIds, ['doc_a', 'doc_b'])
  assert.ok(normalizedText.includes('文档引用「计划.md」'), 'labeled reference visible text')
  assert.ok(normalizedText.includes('文档引用'), 'unlabeled reference visible text')
  assert.ok(!normalizedText.includes('[[docfile:'), 'tag syntax stripped from visible text')
  assert.equal(extractDocfileTagRefs('no tags here').artifactIds.length, 0)
})

test('buildDocfileContextPrompt bounds oversized text and marks the envelope', () => {
  const prompt = buildDocfileContextPrompt([
    { fileName: '计划.md', fileType: 'md', plainText: '# 标题\n\n正文内容' },
    { fileName: 'empty.txt', plainText: '   ' }
  ])
  assert.ok(prompt.includes('【文档全文：计划.md · MD】'))
  assert.ok(prompt.includes('正文内容'))
  assert.ok(prompt.includes('【文档结束】'))
  assert.ok(prompt.includes('（空文档）'))

  const long = '字'.repeat(MAX_DOCFILE_CONTEXT_CHARS + 500)
  const bounded = buildDocfileContextPrompt([{ fileName: 'big.md', plainText: long }])
  assert.ok(bounded.includes('已截断 500 字符'))
  assert.ok(bounded.length < long.length + 200, 'oversized text is bounded')
})
