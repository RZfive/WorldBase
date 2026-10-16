import assert from 'node:assert/strict'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { restoreLostHarnessMessages } from '../src/main/settings/chat-history-reconcile.ts'

const conversation = (messages, updatedAt = '2026-10-14T12:51:00.581Z') => ({
  id: 'conv-1',
  title: '日报应用',
  messages,
  createdAt: '2026-10-14T11:27:02.887Z',
  updatedAt
})

const userMessage = text => ({ id: `u-${text}`, role: 'user', content: text })
const assistantMessage = text => ({ id: `a-${text}`, role: 'assistant', content: text })
const harnessRow = (role, content, createdAt) => ({ role, content, created_at: createdAt })

test('restores the assistant turn lost to an abnormal stream end', () => {
  const request = '给我新建日报应用让定时任务吧日报插入到日报应用里统一管理'
  const state = conversation([userMessage(request)])
  const rows = [
    // Earlier turns exist in the harness store too and must stay untouched.
    harnessRow('user', '这个任务和我要的结果变成定时任务每周工作日6点跑', '2026-10-14T11:55:19Z'),
    harnessRow('assistant', '## 任务小结\n\n## 定时日报任务 v5 创建完成', '2026-10-14T11:55:58Z'),
    // The anchored request itself.
    harnessRow('user', request, '2026-10-14T12:51:00Z'),
    // Provider tool rows carry no visible content and are skipped.
    harnessRow('assistant', '', '2026-10-14T12:51:47Z'),
    harnessRow('user', '', '2026-10-14T12:51:47Z'),
    harnessRow('assistant', '我先给出这个「日报应用」的方案，确认后再创建。', '2026-10-14T12:51:47Z'),
    harnessRow('assistant', '项目已创建（proj_618a4dadfac6db8623f1）。', '2026-10-14T12:54:59Z'),
    harnessRow('assistant', '所有文件已写完，现在构建并启动应用：', '2026-10-14T12:55:54Z')
  ]

  const { conversation: merged, restoredCount } = restoreLostHarnessMessages(state, rows)

  assert.equal(restoredCount, 3)
  assert.equal(merged.messages.length, 4)
  assert.deepEqual(merged.messages.slice(1).map(message => message.role), ['assistant', 'assistant', 'assistant'])
  assert.equal(merged.messages[3].content, '所有文件已写完，现在构建并启动应用：')
  for (const message of merged.messages) {
    assert.ok(message.id, 'restored messages carry a stable id')
  }
})

test('does nothing when the JSON already ends on an assistant reply', () => {
  const state = conversation([userMessage('给我生成日报'), assistantMessage('# 今日工作日报')])
  const rows = [harnessRow('user', '给我生成日报', '2026-10-14T12:51:00Z')]

  const { restoredCount } = restoreLostHarnessMessages(state, rows)

  assert.equal(restoredCount, 0)
})

test('does nothing when the last user message has no harness counterpart', () => {
  const state = conversation([userMessage('一条从未同步到 harness 的消息')])
  const rows = [harnessRow('user', '别的消息', '2026-10-14T12:00:00Z')]

  const { restoredCount } = restoreLostHarnessMessages(state, rows)

  assert.equal(restoredCount, 0)
})

test('never resurrects a tail removed by in-place edit & resend', () => {
  // In-place resend truncates the JSON and bumps updatedAt past the removed
  // rows; those rows still linger in the harness store until the next sync.
  const state = conversation(
    [userMessage('编辑后的提问')],
    '2026-10-14T13:00:00.000Z'
  )
  const rows = [
    harnessRow('user', '编辑后的提问', '2026-10-14T12:00:00Z'),
    harnessRow('assistant', '被截断掉的旧回复', '2026-10-14T12:30:00Z')
  ]

  const { restoredCount } = restoreLostHarnessMessages(state, rows)

  assert.equal(restoredCount, 0)
})

test('matches the anchored user message when the harness row carries appended provider context', () => {
  const request = '总结一下当前文档的结论'
  const state = conversation([userMessage(request)])
  const rows = [
    harnessRow('user', `${request}\n\n【引用的文档上下文】……`, '2026-10-14T12:51:00Z'),
    harnessRow('assistant', '文档结论是……', '2026-10-14T12:52:00Z')
  ]

  const { conversation: merged, restoredCount } = restoreLostHarnessMessages(state, rows)

  assert.equal(restoredCount, 1)
  assert.equal(merged.messages[1].content, '文档结论是……')
})

test('does nothing on an empty conversation', () => {
  const state = conversation([])
  const rows = [harnessRow('assistant', '孤儿回复', '2026-10-14T12:00:00Z')]

  const { restoredCount } = restoreLostHarnessMessages(state, rows)

  assert.equal(restoredCount, 0)
})

test('caps a single restore at 50 messages', () => {
  const state = conversation([userMessage('跑一个很长的任务')])
  const rows = [
    harnessRow('user', '跑一个很长的任务', '2026-10-14T12:51:00Z'),
    ...Array.from({ length: 80 }, (_, index) => harnessRow(
      'assistant',
      `第 ${index} 步输出`,
      `2026-10-14T12:${String(52 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}Z`
    ))
  ]

  const { restoredCount } = restoreLostHarnessMessages(state, rows)

  assert.equal(restoredCount, 50)
})
