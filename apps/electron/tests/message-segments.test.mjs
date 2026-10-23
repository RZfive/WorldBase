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

function errorBlock (id, message = 'boom') {
  return { id, kind: 'error', message }
}

function todo (id, titles = ['任务']) {
  return {
    id,
    kind: 'todo',
    items: titles.map((title, index) => ({ id: index + 1, title, status: 'completed' }))
  }
}

function imageContent (id, url = 'https://example.com/a.png') {
  return { id, kind: 'content', content: [{ type: 'image_url', image_url: { url } }] }
}

function idsOf (segment) {
  return segment.groupEntries.map(entry => entry.block.id)
}

function shapeOf (segments) {
  return segments.map(segment => segment.type === 'group'
    ? { type: 'group', ids: idsOf(segment) }
    : { type: 'single', id: segment.block.id })
}

test('narration between tool calls folds into the same work group', () => {
  const blocks = [
    content('我来创建配置文件', 'n1'),
    tool('t1'),
    tool('t2'),
    content('接下来修改样式', 'n2'),
    tool('t3'),
    content('全部完成了', 'final')
  ]

  const segments = buildRenderSegments(blocks)

  assert.deepEqual(shapeOf(segments), [
    { type: 'group', ids: ['n1', 't1', 't2', 'n2', 't3'] },
    { type: 'single', id: 'final' }
  ])
  assert.equal(segments[0].key, 'group-n1')
  assert.equal(segments[0].blockIndex, 0)
  assert.deepEqual(segments[0].groupEntries.map(entry => entry.blockIndex), [0, 1, 2, 3, 4])
  // The trailing answer keeps its original index so image/annotation anchors resolve.
  assert.deepEqual(segments.map(segment => segment.blockIndex), [0, 5])
})

test('trailing answer with no work after stays outside the group', () => {
  const blocks = [tool('t1'), content('这是最终回答', 'final')]
  const segments = buildRenderSegments(blocks)

  assert.deepEqual(shapeOf(segments), [
    { type: 'group', ids: ['t1'] },
    { type: 'single', id: 'final' }
  ])
})

test('text before work folds into the group', () => {
  const segments = buildRenderSegments([content('正在写入文件', 'n1'), tool('t1')])

  assert.deepEqual(shapeOf(segments), [
    { type: 'group', ids: ['n1', 't1'] }
  ])
  assert.equal(segments[0].key, 'group-n1')
})

test('completed plain text message is never grouped', () => {
  assert.deepEqual(shapeOf(buildRenderSegments([content('你好', 'u1')])), [
    { type: 'single', id: 'u1' }
  ])
  assert.deepEqual(shapeOf(buildRenderSegments([content('第一段', 'c1'), content('第二段', 'c2')])), [
    { type: 'single', id: 'c1' },
    { type: 'single', id: 'c2' }
  ])
})

test('while streaming, pending trailing content folds into a group; once settled it renders outside', () => {
  const blocks = [tool('t1'), content('正在输出', 'pending')]

  assert.deepEqual(shapeOf(buildRenderSegments(blocks, { streaming: true })), [
    { type: 'group', ids: ['t1', 'pending'] }
  ])
  assert.deepEqual(shapeOf(buildRenderSegments(blocks, { streaming: false })), [
    { type: 'group', ids: ['t1'] },
    { type: 'single', id: 'pending' }
  ])
})

test('while streaming, content-only output creates a group; completed content-only output is a single', () => {
  const blocks = [content('实时回答', 'c1')]

  const streamingSegments = buildRenderSegments(blocks, { streaming: true })
  assert.deepEqual(shapeOf(streamingSegments), [
    { type: 'group', ids: ['c1'] }
  ])
  assert.equal(streamingSegments[0].key, 'group-c1')

  assert.deepEqual(shapeOf(buildRenderSegments(blocks, { streaming: false })), [
    { type: 'single', id: 'c1' }
  ])
})

test('empty thinking blocks are dropped from groups', () => {
  const segments = buildRenderSegments([thinking('', 'th-empty'), tool('t1')])

  assert.deepEqual(shapeOf(segments), [
    { type: 'group', ids: ['t1'] }
  ])
})

test('web search and fetch runs keep grouping alongside tools and narration', () => {
  const blocks = [
    { id: 'w1', kind: 'web_search', query: 'q', engine: 'bing', results: [] },
    content('根据搜索结果', 'n1'),
    { id: 'f1', kind: 'web_fetch', result: { ok: true, url: 'https://example.com', content: 'x', truncated: false, fetched_at: 'now', access: 'allowed' } },
    tool('t1', { name: 'write_project_file' }),
    content('完成', 'final')
  ]

  const segments = buildRenderSegments(blocks)

  assert.deepEqual(shapeOf(segments), [
    { type: 'group', ids: ['w1', 'n1', 'f1', 't1'] },
    { type: 'single', id: 'final' }
  ])
})

test('group segments keep stable keys derived from the first run member', () => {
  const blocks = [thinking('', 'th-empty'), content('n1', 'n1'), tool('t1'), tool('t2')]

  const first = buildRenderSegments(blocks)
  const second = buildRenderSegments(blocks)

  // The empty thinking pill is dropped from the visible entries, but its block
  // still anchors the group key so the group does not remount as text arrives.
  assert.equal(first[0].key, 'group-th-empty')
  assert.equal(second[0].key, 'group-th-empty')
  assert.deepEqual(first[0].groupEntries.map(entry => entry.blockIndex), [1, 2, 3])
})

test('streaming content that starts empty keeps a stable key when work follows', () => {
  const blocksFor = text => [content(text, 'c1'), tool('t1')]

  const empty = buildRenderSegments(blocksFor(''), { streaming: true })
  const partial = buildRenderSegments(blocksFor('你'), { streaming: true })
  const grown = buildRenderSegments(blocksFor('你好，世界'), { streaming: true })

  assert.deepEqual(shapeOf(empty), [{ type: 'group', ids: ['t1'] }])
  assert.deepEqual(shapeOf(partial), [{ type: 'group', ids: ['c1', 't1'] }])
  assert.deepEqual(shapeOf(grown), [{ type: 'group', ids: ['c1', 't1'] }])
  assert.equal(empty[0].key, 'group-c1')
  assert.equal(partial[0].key, 'group-c1')
  assert.equal(grown[0].key, 'group-c1')
})

test('settled narration before a splitter stays grouped when work follows the splitter', () => {
  const blocks = [
    content('先说明一下', 'n1'),
    todo('td1'),
    tool('t1'),
    content('最终回答', 'final')
  ]
  const segments = buildRenderSegments(blocks)

  assert.deepEqual(shapeOf(segments), [
    { type: 'group', ids: ['n1'] },
    { type: 'single', id: 'td1' },
    { type: 'group', ids: ['t1'] },
    { type: 'single', id: 'final' }
  ])
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

  assert.deepEqual(shapeOf(segments), [
    { type: 'group', ids: ['n1', 't1', 'p1', 't2', 'p2'] },
    { type: 'single', id: 'final' }
  ])
})

test('active file-preview row stays visible while the file is being written', () => {
  const segments = buildRenderSegments([tool('t1'), preview('p1', { active: true })])

  assert.equal(segments.length, 2)
  assert.equal(segments[0].type, 'group')
  assert.deepEqual(idsOf(segments[0]), ['t1'])
  assert.equal(segments[1].type, 'single')
  assert.equal(segments[1].block.id, 'p1')
})

test('settled content before a non-work block with no work anywhere stays outside', () => {
  const blocks = [content('只是说明', 'c1'), errorBlock('e1')]
  const segments = buildRenderSegments(blocks)

  assert.deepEqual(shapeOf(segments), [
    { type: 'single', id: 'c1' },
    { type: 'single', id: 'e1' }
  ])
  assert.deepEqual(segments.map(segment => segment.blockIndex), [0, 1])
})

test('settled content followed only by thinking stays outside the summary', () => {
  const blocks = [content('先说明一下', 'c1'), thinking('正在推理', 'th1')]
  const segments = buildRenderSegments(blocks)

  assert.deepEqual(shapeOf(segments), [
    { type: 'single', id: 'c1' },
    { type: 'single', id: 'th1' }
  ])
  assert.deepEqual(segments.map(segment => segment.blockIndex), [0, 1])
})

test('multiple groups split by non-groupable blocks keep order and original indexes', () => {
  const blocks = [
    content('第一段说明', 'n1'),
    tool('t1'),
    errorBlock('e1'),
    content('第二段说明', 'n2'),
    tool('t2'),
    todo('td1'),
    tool('t3'),
    content('最终回答', 'final')
  ]
  const segments = buildRenderSegments(blocks)

  assert.deepEqual(shapeOf(segments), [
    { type: 'group', ids: ['n1', 't1'] },
    { type: 'single', id: 'e1' },
    { type: 'group', ids: ['n2', 't2'] },
    { type: 'single', id: 'td1' },
    { type: 'group', ids: ['t3'] },
    { type: 'single', id: 'final' }
  ])
  assert.deepEqual(segments.map(segment => segment.blockIndex), [0, 2, 3, 5, 6, 7])
  assert.deepEqual(segments[0].groupEntries.map(entry => entry.blockIndex), [0, 1])
  assert.deepEqual(segments[2].groupEntries.map(entry => entry.blockIndex), [3, 4])
})

test('streaming content beside an active preview keeps the preview single and preserves order', () => {
  const blocks = [
    content('实时输出', 'c1'),
    preview('p1', { active: true }),
    tool('t1'),
    content('继续输出', 'c2')
  ]
  const segments = buildRenderSegments(blocks, { streaming: true })

  assert.deepEqual(shapeOf(segments), [
    { type: 'group', ids: ['c1'] },
    { type: 'single', id: 'p1' },
    { type: 'group', ids: ['t1', 'c2'] }
  ])
  assert.deepEqual(segments.map(segment => segment.blockIndex), [0, 1, 2])
  assert.equal(segments[1].block.kind, 'file_preview')
})

test('streaming content that grows from empty keeps a stable group key', () => {
  const blocksFor = text => [tool('t1'), content(text, 'c1')]

  const empty = buildRenderSegments(blocksFor(''), { streaming: true })
  const partial = buildRenderSegments(blocksFor('你'), { streaming: true })
  const grown = buildRenderSegments(blocksFor('你好，世界'), { streaming: true })

  assert.deepEqual(shapeOf(empty), [{ type: 'group', ids: ['t1'] }])
  assert.deepEqual(shapeOf(partial), [{ type: 'group', ids: ['t1', 'c1'] }])
  assert.deepEqual(shapeOf(grown), [{ type: 'group', ids: ['t1', 'c1'] }])
  assert.equal(empty[0].key, 'group-t1')
  assert.equal(partial[0].key, 'group-t1')
  assert.equal(grown[0].key, 'group-t1')
  assert.deepEqual(grown[0].groupEntries.map(entry => entry.blockIndex), [0, 1])
})

test('grouped content entries keep their original blockIndex when earlier entries are dropped', () => {
  const blocks = [
    content('第一段', 'n1'),
    thinking('', 'th-empty'),
    content('第二段', 'n2'),
    tool('t1')
  ]
  const segments = buildRenderSegments(blocks)

  assert.deepEqual(shapeOf(segments), [
    { type: 'group', ids: ['n1', 'n2', 't1'] }
  ])
  assert.deepEqual(segments[0].groupEntries.map(entry => entry.block.id), ['n1', 'n2', 't1'])
  assert.deepEqual(segments[0].groupEntries.map(entry => entry.blockIndex), [0, 2, 3])
  assert.equal(segments[0].blockIndex, 0)
})

test('image-only content participates like text while empty content never forms an empty group', () => {
  const blocks = [
    content('', 'empty-text'),
    { id: 'empty-parts', kind: 'content', content: [] },
    imageContent('img1'),
    tool('t1')
  ]
  const segments = buildRenderSegments(blocks)

  assert.deepEqual(shapeOf(segments), [
    { type: 'group', ids: ['img1', 't1'] }
  ])
  assert.deepEqual(segments[0].groupEntries.map(entry => entry.blockIndex), [2, 3])

  const trailing = buildRenderSegments([tool('t2'), imageContent('img2')])
  assert.deepEqual(shapeOf(trailing), [
    { type: 'group', ids: ['t2'] },
    { type: 'single', id: 'img2' }
  ])

  assert.deepEqual(buildRenderSegments([content('', 'solo-empty')], { streaming: true }), [])
})
