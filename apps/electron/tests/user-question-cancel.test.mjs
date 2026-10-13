import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'

// The host-side ask_user panel must never outlive its tool call: when the
// request settles without a user reply (abort / timeout), the main process
// tells the renderer to drop the pending panel, otherwise the questions stay
// above the chat input collecting answers nobody will read.

let ipcMain

async function loadUserQuestionModule () {
  const result = await build({
    entryPoints: [new URL('../src/main/ai-host/agent/tools/user-question.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    plugins: [{
      name: 'electron-stub',
      setup (build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-stub', namespace: 'stub' }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: [
            'import { EventEmitter } from "node:events"',
            `globalThis.__testIpcMain ||= new EventEmitter()`,
            'export const ipcMain = globalThis.__testIpcMain',
            'export class BrowserWindow {}',
            'export default null'
          ].join('\n'),
          loader: 'js',
          resolveDir: new URL('.', import.meta.url).pathname
        }))
      }
    }]
  })
  const source = result.outputFiles[0].text
  return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

function createFakeWindow () {
  const sent = []
  return {
    sent,
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => sent.push({ channel, payload })
    }
  }
}

test('an aborted ask_user request resolves null and cancels the renderer panel', async () => {
  ipcMain = globalThis.__testIpcMain = new EventEmitter()
  const { requestUserQuestions } = await loadUserQuestionModule()
  const win = createFakeWindow()
  const controller = new AbortController()

  const pending = requestUserQuestions(
    () => win,
    () => ({ conversationId: 'conv-1', sessionId: 'sess-1' }),
    () => controller.signal,
    [{ id: 'q_1', question: 'A or B?', options: ['A', 'B'] }]
  )

  await Promise.resolve()
  assert.equal(win.sent.filter((item) => item.channel === 'askUser:request').length, 1)
  const request = win.sent.find((item) => item.channel === 'askUser:request').payload

  controller.abort()
  assert.equal(await pending, null)
  const cancelled = win.sent.filter((item) => item.channel === 'askUser:cancelled')
  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0].payload.requestId, request.requestId)
})

test('a user reply resolves the answers and emits no cancellation', async () => {
  ipcMain = globalThis.__testIpcMain = new EventEmitter()
  const { requestUserQuestions } = await loadUserQuestionModule()
  const win = createFakeWindow()

  const pending = requestUserQuestions(
    () => win,
    () => ({ conversationId: 'conv-1', sessionId: 'sess-1' }),
    () => undefined,
    [{ id: 'q_1', question: 'A or B?', options: ['A', 'B'] }]
  )

  await Promise.resolve()
  const request = win.sent.find((item) => item.channel === 'askUser:request').payload
  ipcMain.emit('askUser:response', null, {
    requestId: request.requestId,
    answers: [{ questionId: 'q_1', selectedOption: 'A', customAnswer: null }]
  })

  const answers = await pending
  assert.deepEqual(answers, [{ questionId: 'q_1', selectedOption: 'A', customAnswer: null }])
  assert.equal(win.sent.filter((item) => item.channel === 'askUser:cancelled').length, 0)
})

test('stale responses for a settled request are ignored without side effects', async () => {
  ipcMain = globalThis.__testIpcMain = new EventEmitter()
  const { requestUserQuestions } = await loadUserQuestionModule()
  const win = createFakeWindow()
  const controller = new AbortController()

  const pending = requestUserQuestions(
    () => win,
    () => ({ conversationId: 'conv-1', sessionId: 'sess-1' }),
    () => controller.signal,
    [{ id: 'q_1', question: 'A or B?', options: ['A', 'B'] }]
  )

  await Promise.resolve()
  const request = win.sent.find((item) => item.channel === 'askUser:request').payload
  controller.abort()
  assert.equal(await pending, null)

  // A late renderer answer after cancellation must not crash or resurrect.
  assert.doesNotThrow(() => {
    ipcMain.emit('askUser:response', null, {
      requestId: request.requestId,
      answers: [{ questionId: 'q_1', selectedOption: 'B', customAnswer: null }]
    })
  })
  assert.equal(win.sent.filter((item) => item.channel === 'askUser:cancelled').length, 1)
})
