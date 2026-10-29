import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMessageBlocks, deriveWorkGroupStatus } from '../src/renderer/components/chat/message-utils.ts'
import { appendFinalContentBlock } from '../src/renderer/components/chat/panel/message-blocks.ts'

const idlePreview = { active: false, filePath: '', lineCount: 0, added: 0, removed: 0 }

function createImagePart (marker = 'AAA') {
  return { type: 'image_url', image_url: { url: `data:image/png;base64,${marker}` } }
}

function contentPartsOf (content) {
  return Array.isArray(content) ? content : [{ type: 'text', text: content }]
}

function build (message, index = 0) {
  return buildMessageBlocks(message, index, idlePreview, -1, false)
}

test('legacy edited image message gets its text back at render time', () => {
  const image = createImagePart()
  const message = {
    role: 'user',
    id: 'legacy-edit',
    content: [{ type: 'text', text: '把图里的标题改成中文' }, image],
    // Persisted by the old in-place edit path: one block whose content lost the text.
    blocks: [{ id: 'b-content', kind: 'content', content: [image] }]
  }

  const blocks = build(message)
  const contentBlocks = blocks.filter(block => block.kind === 'content')

  assert.equal(contentBlocks.length, 2)
  assert.equal(contentBlocks[0].content, '把图里的标题改成中文')
  assert.deepEqual(contentPartsOf(contentBlocks[1].content), [image])
})

test('legacy edit with several text parts keeps them together', () => {
  const image = createImagePart('BBB')
  const message = {
    role: 'user',
    id: 'legacy-edit-multi',
    content: [{ type: 'text', text: '第一段' }, image, { type: 'text', text: '第二段' }],
    blocks: [{ id: 'b-content', kind: 'content', content: [image] }]
  }

  const contentBlocks = build(message).filter(block => block.kind === 'content')

  assert.equal(contentBlocks.length, 2)
  assert.equal(contentBlocks[0].content, '第一段\n\n第二段')
})

test('healthy image message keeps its text block without duplication', () => {
  const image = createImagePart()
  const message = {
    role: 'user',
    id: 'healthy',
    content: [{ type: 'text', text: '描述这张图' }, image],
    blocks: [
      { id: 'b-text', kind: 'content', content: '描述这张图' },
      { id: 'b-image', kind: 'content', content: [image] }
    ]
  }

  const blocks = build(message)

  assert.equal(blocks, message.blocks)
  assert.equal(blocks.filter(block => block.kind === 'content').length, 2)
})

test('quoted resend text is not duplicated next to the image', () => {
  const image = createImagePart()
  const normalized = '看图说话'
  const combined = `> 之前的回答\n\n${normalized}`
  const message = {
    role: 'user',
    id: 'quoted',
    content: [{ type: 'text', text: combined }, image],
    blocks: [
      { id: 'b-text', kind: 'content', content: normalized },
      { id: 'b-image', kind: 'content', content: [image] }
    ]
  }

  const blocks = build(message)

  assert.equal(blocks, message.blocks)
  assert.equal(blocks.filter(block => block.kind === 'content').length, 2)
})

test('image-only user message stays untouched', () => {
  const image = createImagePart()
  const message = {
    role: 'user',
    id: 'image-only',
    content: [image],
    blocks: [{ id: 'b-image', kind: 'content', content: [image] }]
  }

  assert.equal(build(message), message.blocks)
})

test('assistant blocks are never rewritten', () => {
  const message = {
    role: 'assistant',
    id: 'assistant',
    content: '回答正文',
    blocks: [{ id: 'b-content', kind: 'content', content: '' }]
  }

  assert.equal(build(message), message.blocks)
})

test('final answer after pre-tool narration gets its own trailing block', () => {
  const message = {
    role: 'assistant',
    id: 'final-after-work',
    content: '最终回答',
    blocks: [
      { id: 'n1', kind: 'content', content: '我先检查一下。' },
      { id: 't1', kind: 'tool', toolRun: { id: 't1', name: 'read_file', status: 'completed', progress: [] } }
    ]
  }

  appendFinalContentBlock(message, '最终回答')

  assert.equal(message.blocks.length, 3)
  assert.equal(message.blocks[0].content, '我先检查一下。')
  assert.equal(message.blocks[2].kind, 'content')
  assert.equal(message.blocks[2].content, '最终回答')
})

test('final answer merges into a trailing content block when no work follows it', () => {
  const message = {
    role: 'assistant',
    id: 'final-trailing',
    content: '最终回答',
    blocks: [{ id: 'c1', kind: 'content', content: '正在输出' }]
  }

  appendFinalContentBlock(message, '最终回答')

  assert.equal(message.blocks.length, 1)
  assert.equal(message.blocks[0].content, '最终回答')
})

test('final answer after several pre-tool narration blocks stays outside the summary', () => {
  const message = {
    role: 'assistant',
    id: 'final-multi-narration',
    content: '最终回答',
    blocks: [
      { id: 'n1', kind: 'content', content: '第一段说明。' },
      { id: 't1', kind: 'tool', toolRun: { id: 't1', name: 'read_file', status: 'completed', progress: [] } },
      { id: 'n2', kind: 'content', content: '第二段说明。' },
      { id: 't2', kind: 'tool', toolRun: { id: 't2', name: 'write_file', status: 'completed', progress: [] } }
    ]
  }

  appendFinalContentBlock(message, '最终回答')

  assert.equal(message.blocks.length, 5)
  assert.equal(message.blocks[0].content, '第一段说明。')
  assert.equal(message.blocks[2].content, '第二段说明。')
  assert.equal(message.blocks[4].kind, 'content')
  assert.equal(message.blocks[4].content, '最终回答')
})

test('work group status follows the tool mix rather than any single failure', () => {
  // One turn folds all tool calls into one group: 54 successes + 5 failures
  // must not paint the whole trace red.
  assert.equal(deriveWorkGroupStatus({ running: 0, completed: 54, failed: 5 }), 'completed')
  assert.equal(deriveWorkGroupStatus({ running: 1, completed: 54, failed: 5 }), 'running')
  assert.equal(deriveWorkGroupStatus({ running: 0, completed: 0, failed: 5 }), 'failed')
  assert.equal(deriveWorkGroupStatus({ running: 0, completed: 3, failed: 0 }), 'completed')
  // A group without tool runs (thinking/web only) reads as completed.
  assert.equal(deriveWorkGroupStatus({ running: 0, completed: 0, failed: 0 }), 'completed')
})
