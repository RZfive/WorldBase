import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { flush, loadSetupComponent, rendererFixture } from './helpers/renderer-fixture.mjs'

const AskUserPanel = await loadSetupComponent(new URL('../src/renderer/components/chat/layout/AskUserPanel.vue', import.meta.url))
const PinnedTodoPanel = await loadSetupComponent(new URL('../src/renderer/components/chat/layout/PinnedTodoPanel.vue', import.meta.url))

function cssRule (source, selector) {
  const start = source.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `missing CSS rule ${selector}`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++
    if (source[index] === '}') {
      depth--
      if (depth === 0) return source.slice(bodyStart + 1, index)
    }
  }
  throw new Error(`unterminated CSS rule ${selector}`)
}

test('attention cards expand while their scroll belongs to the card body', async () => {
  const [chatPanel, askPanel, todoPanel, authPanel, sudoPanel] = await Promise.all([
    readFile(new URL('../src/renderer/components/chat/panel/ChatPanelContainer.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/components/chat/layout/AskUserPanel.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/components/chat/layout/PinnedTodoPanel.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/components/chat/layout/AuthPermissionPanel.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/components/chat/layout/SudoPasswordPanel.vue', import.meta.url), 'utf8')
  ])

  const attentionZone = cssRule(chatPanel, '.chat-attention-zone')
  assert.match(attentionZone, /overflow:\s*visible/)
  assert.doesNotMatch(attentionZone, /overflow-y:\s*auto/)
  assert.doesNotMatch(attentionZone, /max-height:/)

  assert.match(cssRule(askPanel, '.ask-scroll'), /overflow-y:\s*auto/)
  assert.match(cssRule(todoPanel, '.todo-scroll'), /overflow-y:\s*auto/)
  assert.match(cssRule(authPanel, '.auth-detail-body'), /overflow-y:\s*auto/)
  assert.match(cssRule(sudoPanel, '.sudo-detail-body'), /overflow-y:\s*auto/)
})

test('ask user and todo panels honor controlled expansion', async t => {
  const fixture = rendererFixture(t)
  const ask = fixture.mount(AskUserPanel, {
    expanded: true,
    request: {
      requestId: 'ask-1',
      questions: [
        { id: 'q1', question: 'First?', options: ['Yes', 'No'] },
        { id: 'q2', question: 'Second?', options: ['A', 'B'] }
      ]
    }
  })
  const todo = fixture.mount(PinnedTodoPanel, {
    expanded: true,
    isLoading: false,
    items: [
      { id: 1, title: 'First task', status: 'completed' },
      { id: 2, title: 'Second task', status: 'in-progress' }
    ]
  })
  await flush()

  assert.equal(ask.state.collapsed, false)
  assert.equal(todo.state.collapsed, false)
})
