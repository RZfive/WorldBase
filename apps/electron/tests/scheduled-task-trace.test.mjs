import assert from 'node:assert/strict'
import test from 'node:test'

import './register-ts-hooks.mjs'
import { buildScheduledTaskTrace } from '../src/renderer/components/settings/scheduled-task-trace.ts'

function entry (kind, at, stage, extra = {}) {
  return { at, stage, kind, ...extra }
}

test('groups interleaved tool calls and keeps progress with the right run', () => {
  const trace = buildScheduledTaskTrace([
    entry('progress', '2026-11-25T10:00:00.000Z', '理解任务'),
    entry('tool_start', '2026-11-25T10:00:01.000Z', '开始执行工具', { toolName: 'grep_search' }),
    entry('progress', '2026-11-25T10:00:02.000Z', '搜索文件', { toolName: 'grep_search', detail: 'src/**/*.ts' }),
    entry('tool_start', '2026-11-25T10:00:03.000Z', '开始执行工具', { toolName: 'read_workspace_file' }),
    entry('progress', '2026-11-25T10:00:04.000Z', '读取文件', { toolName: 'read_workspace_file', detail: 'a.ts' }),
    entry('tool_end', '2026-11-25T10:00:05.000Z', '工具执行完成', { toolName: 'grep_search' }),
    entry('progress', '2026-11-25T10:00:06.000Z', '读取文件', { toolName: 'read_workspace_file', detail: 'b.ts' }),
    entry('tool_end', '2026-11-25T10:00:07.000Z', '工具执行完成', { toolName: 'read_workspace_file' })
  ], 'completed')

  assert.equal(trace.tools.length, 2)
  assert.equal(trace.stepCount, 4)
  assert.equal(trace.tools[0].name, 'grep_search')
  assert.equal(trace.tools[0].status, 'completed')
  assert.equal(trace.tools[0].steps.length, 1)
  assert.equal(trace.tools[0].steps[0].detail, 'src/**/*.ts')
  assert.equal(trace.tools[1].name, 'read_workspace_file')
  assert.equal(trace.tools[1].steps.length, 2)
  assert.equal(trace.tools[1].steps[1].detail, 'b.ts')
  assert.deepEqual(trace.items.map(item => item.kind), ['stage', 'tool', 'tool'])
})

test('finished reports settle unfinished calls and preserve failed status', () => {
  const trace = buildScheduledTaskTrace([
    entry('tool_start', '2026-11-25T10:00:00.000Z', '开始执行工具', { toolName: 'run_workspace_command' }),
    entry('progress', '2026-11-25T10:00:02.000Z', '执行命令', { detail: 'pnpm test' })
  ], 'failed')

  assert.equal(trace.tools[0].status, 'failed')
  assert.equal(trace.tools[0].endedAt, '2026-11-25T10:00:02.000Z')
  assert.equal(trace.items[0].kind, 'tool')
})

test('adds one reasoning row only when reasoning text exists', () => {
  const withoutThinking = buildScheduledTaskTrace([
    entry('thinking', '2026-11-25T10:00:00.000Z', '记录思考过程')
  ], 'completed', false)
  const withThinking = buildScheduledTaskTrace([
    entry('thinking', '2026-11-25T10:00:00.000Z', '记录思考过程')
  ], 'completed', true)

  assert.equal(withoutThinking.items.length, 0)
  assert.deepEqual(withThinking.items, [{ kind: 'thinking', at: '2026-11-25T10:00:00.000Z' }])
})
