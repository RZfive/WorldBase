import assert from 'node:assert/strict'
import test from 'node:test'

import './register-ts-hooks.mjs'
import { buildRenderSegments } from '../src/renderer/components/chat/message-segments.ts'

function content (text, id) {
  return { id, kind: 'content', content: text }
}

function tool (id, { status = 'completed', name = 'write_project_file' } = {}) {
  return {
    id,
    kind: 'tool',
    toolRun: { id, name, status, progress: [], startedAt: 1000, endedAt: 2000 }
  }
}

function thinking (text, id) {
  return { id, kind: 'thinking', text, startedAt: 1000, endedAt: 2000 }
}

function preview (id, { active = false, path = '/tmp/a.md' } = {}) {
  return { id, kind: 'file_preview', filePath: path, lineCount: 0, added: 0, removed: 0, active }
}

function idsOf (segment) {
  return segment.groupEntries.map(entry => entry.block.id)
}

test('narration between file-write tool calls folds into the work summary group', () => {
  const blocks = [
    content('我来创建配置文件', 'n1'),
    tool('t1'),
    tool('t2'),
    content('接下来修改样式', 'n2'),
    tool('t3'),
    content('全部完成了', 'final')
  ]

  const segments = buildRenderSegments(blocks)

  assert.equal(segments.length, 2)
  const [group, answer] = segments
  assert.equal(group.type, 'group')
  assert.deepEqual(idsOf(group), ['n1', 't1', 't2', 'n2', 't3'])
  // Narration keeps its original position so image/annotation anchors still resolve.
  assert.deepEqual(group.groupEntries.map(entry => entry.blockIndex), [0, 1, 2, 3, 4])
  assert.equal(answer.type, 'single')
  assert.equal(answer.block.id, 'final')
})

test('trailing answer content always stays outside the group', () => {
  const blocks = [tool('t1'), content('这是最终回答', 'final')]
  const segments = buildRenderSegments(blocks)

  assert.equal(segments.length, 2)
  assert.equal(segments[0].type, 'group')
  assert.deepEqual(idsOf(segments[0]), ['t1'])
  assert.equal(segments[1].type, 'single')
  assert.equal(segments[1].block.id, 'final')
})

test('mid-work narration collapses once any work block follows it', () => {
  const segments = buildRenderSegments([content('正在写入文件', 'n1'), tool('t1')])

  assert.equal(segments.length, 1)
  assert.equal(segments[0].type, 'group')
  assert.deepEqual(idsOf(segments[0]), ['n1', 't1'])
})

test('plain text message is never grouped', () => {
  const segments = buildRenderSegments([content('你好', 'u1')])

  assert.equal(segments.length, 1)
  assert.equal(segments[0].type, 'single')
  assert.equal(segments[0].block.kind, 'content')
})

test('lone thinking stays a standalone pill', () => {
  const segments = buildRenderSegments([thinking('让我想想', 'th1')])

  assert.equal(segments.length, 1)
  assert.equal(segments[0].type, 'single')
  assert.equal(segments[0].block.kind, 'thinking')
})

test('empty thinking blocks are dropped from groups', () => {
  const segments = buildRenderSegments([thinking('', 'th-empty'), tool('t1')])

  assert.equal(segments.length, 1)
  assert.equal(segments[0].type, 'group')
  assert.deepEqual(idsOf(segments[0]), ['t1'])
})

test('web search and fetch runs keep grouping alongside tools', () => {
  const blocks = [
    { id: 'w1', kind: 'web_search', query: 'q', engine: 'bing', results: [] },
    content('根据搜索结果', 'n1'),
    { id: 'f1', kind: 'web_fetch', result: { ok: true, url: 'https://example.com', content: 'x', truncated: false, fetched_at: 'now', access: 'allowed' } },
    tool('t1', { name: 'write_project_file' }),
    content('完成', 'final')
  ]

  const segments = buildRenderSegments(blocks)

  assert.equal(segments.length, 2)
  assert.equal(segments[0].type, 'group')
  assert.deepEqual(idsOf(segments[0]), ['w1', 'n1', 'f1', 't1'])
  assert.equal(segments[1].block.id, 'final')
})

test('group segments keep stable keys derived from the first member', () => {
  const segments = buildRenderSegments([content('n', 'n1'), tool('t1'), content('done', 'final')])

  assert.equal(segments[0].key, 'group-n1')
})

test('settled written-file rows fold into the work summary between tool bars', () => {
  const blocks = [
    content('先写配置文件', 'n1'),
    tool('t1'),
    preview('p1'),
    tool('t2'),
    preview('p2'),
    content('全部完成', 'final')
  ]

  const segments = buildRenderSegments(blocks)

  assert.equal(segments.length, 2)
  assert.equal(segments[0].type, 'group')
  assert.deepEqual(idsOf(segments[0]), ['n1', 't1', 'p1', 't2', 'p2'])
  assert.equal(segments[1].type, 'single')
  assert.equal(segments[1].block.id, 'final')
})

test('active file-preview row stays visible while the file is being written', () => {
  const segments = buildRenderSegments([tool('t1'), preview('p1', { active: true })])

  assert.equal(segments.length, 2)
  assert.equal(segments[0].type, 'group')
  assert.deepEqual(idsOf(segments[0]), ['t1'])
  assert.equal(segments[1].type, 'single')
  assert.equal(segments[1].block.id, 'p1')
})
