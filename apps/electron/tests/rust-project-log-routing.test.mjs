import assert from 'node:assert/strict'
import test from 'node:test'
import { forwardProjectRuntimeLog } from '../electron/main-process/project-runtime-log-routing.ts'

test('project renderer console logs stay in the Rust runtime buffer while Rust owns projects', async () => {
  const calls = []
  forwardProjectRuntimeLog({
    port: 43123,
    type: 'stderr',
    text: '[app:error] native failure (http://127.0.0.1:43123/page:42)',
    rustSelected: true,
    rust: {
      isRunning: () => true,
      append: async (port, type, text) => {
        calls.push({ port, type, text })
        return { appended: true, projectId: 'native-project' }
      }
    },
    typeScript: {
      findProjectIdByPort: () => { throw new Error('TS runtime must stay dormant') },
      appendExternalLog: () => { throw new Error('TS runtime must stay dormant') }
    }
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(calls, [{
    port: 43123,
    type: 'stderr',
    text: '[app:error] native failure (http://127.0.0.1:43123/page:42)'
  }])
})

test('project renderer logs use RuntimeManager only in explicit TypeScript mode', () => {
  const entries = []
  forwardProjectRuntimeLog({
    port: 43124,
    type: 'stderr',
    text: '[app:load-failed] connection refused (-102) (http://localhost:43124/)',
    rustSelected: false,
    rust: null,
    typeScript: {
      findProjectIdByPort: port => port === 43124 ? 'ts-project' : null,
      appendExternalLog: (...entry) => entries.push(entry)
    }
  })

  assert.deepEqual(entries, [[
    'ts-project',
    'stderr',
    '[app:load-failed] connection refused (-102) (http://localhost:43124/)'
  ]])
})

test('a selected but stopped Rust harness never revives the TypeScript runtime for logs', () => {
  forwardProjectRuntimeLog({
    port: 43125,
    type: 'stdout',
    text: '[app:info] late message',
    rustSelected: true,
    rust: { isRunning: () => false, append: async () => { throw new Error('must not call Rust') } },
    typeScript: {
      findProjectIdByPort: () => { throw new Error('must not fall back to TS') },
      appendExternalLog: () => { throw new Error('must not fall back to TS') }
    }
  })
})
