import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import express from 'express'
import { projectsRouter } from '../src/main/lan-server/routes/projects.ts'

function request (app, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const payload = typeof body === 'undefined' ? undefined : JSON.stringify(body)
      const req = http.request({
        host: '127.0.0.1',
        port: address.port,
        path: pathname,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : undefined
      }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          server.close()
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        })
      })
      req.on('error', error => {
        server.close()
        reject(error)
      })
      if (payload) req.write(payload)
      req.end()
    })
  })
}

function tsServicesThatMustNotRun () {
  const reject = () => { throw new Error('TS project service must not be used in Rust mode') }
  return {
    projectFS: {
      listProjects: reject,
      getProjectMeta: reject,
      getFileTree: reject,
      readFile: reject,
      writeFile: reject,
      analyzeProject: reject
    },
    runtimeManager: {
      getStatus: reject,
      getLogs: reject,
      start: reject,
      stop: reject
    },
    dataAccess: {
      queryDatabase: reject,
      getDataSummary: reject,
      getTableSchema: reject,
      listTables: reject,
      readRecords: reject,
      saveRecords: reject
    }
  }
}

test('Rust-selected LAN project routes stay on the Rust control plane', async () => {
  const calls = []
  const app = express()
  app.use(express.json())
  app.use('/api/projects', projectsRouter({
    ...tsServicesThatMustNotRun(),
    resolveRustProjectControl: async () => ({
      async call (method, params = {}) {
        calls.push({ method, params })
        if (method === 'project.list') return { projects: [{ id: 'native-app', name: 'Native App' }] }
        if (method === 'project.status') return { projectId: params.projectId, status: 'running', port: 43123 }
        if (method === 'project.file.read') return { content: 'export const native = true\n' }
        if (method === 'project.file.write') return { success: true }
        if (method === 'project.data.records.query') return [{ id: 1, title: 'Rust row' }]
        if (method === 'project.data.records.save') return { table: 'tasks', count: 1, mode: 'upsert' }
        if (method === 'project.data.tables') return { tables: ['tasks'] }
        throw new Error(`Unexpected Rust method: ${method}`)
      }
    })
  }))

  const listed = await request(app, 'GET', '/api/projects/')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.projects[0].runtime.port, 43123)

  const read = await request(app, 'GET', '/api/projects/native-app/files/src/main.ts')
  assert.equal(read.status, 200)
  assert.equal(read.body.content, 'export const native = true\n')

  const write = await request(app, 'PUT', '/api/projects/native-app/files/src/main.ts', { content: 'export const updated = true\n' })
  assert.deepEqual(write.body, { success: true, path: 'src/main.ts' })

  const rows = await request(app, 'POST', '/api/projects/native-app/data/records/query', { table: 'tasks', limit: 10 })
  assert.deepEqual(rows.body.rows, [{ id: 1, title: 'Rust row' }])

  const saved = await request(app, 'POST', '/api/projects/native-app/data/records/save', { table: 'tasks', record: { id: 1, title: 'Rust row' } })
  assert.deepEqual(saved.body, { success: true, table: 'tasks', count: 1, mode: 'upsert' })

  const tables = await request(app, 'GET', '/api/projects/native-app/data/tables')
  assert.deepEqual(tables.body, { tables: ['tasks'] })

  assert.ok(calls.some(call => call.method === 'project.file.write'))
  assert.ok(calls.some(call => call.method === 'project.data.records.query'))
  assert.ok(calls.some(call => call.method === 'project.data.records.save'))
})
