import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { ScheduledTaskService } from '../src/main/scheduler/scheduled-task-service.ts'
import { ScheduledTaskStore } from '../src/main/settings/scheduled-task-store.ts'

async function createService () {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-report-'))
  const store = new ScheduledTaskStore(dir)
  const service = new ScheduledTaskService({ store, aiEngine: {}, shouldNotifyReport: () => false })
  return { dir, service }
}

test('ingestRustReport persists the full assistant output alongside the finish summary', async () => {
  const { dir, service } = await createService()

  // A live running report is created by the progress bridge, then finalized
  // by the report — the same lifecycle as a Rust-scheduled execution.
  service.ingestRustProgress({ scheduleId: 'task-1', stage: 'tool_start', toolName: 'local_run_command' })
  service.ingestRustReport({
    scheduleId: 'task-1',
    taskName: '每日工作日报',
    resultText: '## 任务小结\n\n已完成。',
    outputText: '日报正文\n\n## 任务小结\n\n已完成。',
    trigger: 'schedule'
  })

  const [report] = service.listAllReports()
  assert.equal(report.status, 'completed')
  assert.equal(report.resultText, '## 任务小结\n\n已完成。')
  assert.equal(report.outputText, '日报正文\n\n## 任务小结\n\n已完成。')

  // The field survives a disk round-trip through the store's normalizer.
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'scheduled-tasks.json'), 'utf8'))
  assert.equal(raw.reports[0].outputText, '日报正文\n\n## 任务小结\n\n已完成。')
  const reloaded = new ScheduledTaskStore(dir)
  assert.equal(reloaded.getReports()[0].outputText, '日报正文\n\n## 任务小结\n\n已完成。')

  await fs.rm(dir, { recursive: true, force: true })
})

test('ingestRustReport keeps outputText optional for legacy payloads', async () => {
  const { service } = await createService()
  service.ingestRustReport({ scheduleId: 'task-2', taskName: 'legacy', resultText: 'ok', trigger: 'manual' })

  const [report] = service.listAllReports()
  assert.equal(report.status, 'completed')
  assert.equal(report.resultText, 'ok')
  assert.equal(report.outputText, undefined)
})
