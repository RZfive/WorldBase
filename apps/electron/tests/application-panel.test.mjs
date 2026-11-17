import assert from 'node:assert/strict'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { flush, loadSetupComponent, rendererFixture } from './helpers/renderer-fixture.mjs'
import { resolveProjectAiStatus } from '../src/renderer/utils/project-ai-status.ts'

const ApplicationsPanel = await loadSetupComponent(new URL('../src/renderer/components/settings/ApplicationsPanel.vue', import.meta.url))

test('project launchpad marks only legacy apps as AI upgrade candidates', () => {
  const project = { id: 'proj_legacy', name: 'Legacy app', type: 'fullstack' }
  assert.deepEqual(resolveProjectAiStatus(project, []), {
    aiReady: false,
    aiUpgradeAvailable: true
  })

  assert.deepEqual(resolveProjectAiStatus(project, [{
    appId: 'worldbase.local.proj_legacy',
    aiReady: true
  }]), {
    aiReady: true,
    aiUpgradeAvailable: false
  })

  assert.deepEqual(resolveProjectAiStatus(project, [{
    appId: 'worldbase.local.proj_legacy',
    aiReady: false
  }]), {
    aiReady: false,
    aiUpgradeAvailable: false
  })

  assert.deepEqual(resolveProjectAiStatus({ id: 'web_demo', kind: 'web' }, []), {
    aiReady: false,
    aiUpgradeAvailable: false
  })
})

test('project AI status can match a managed app by project tag', () => {
  assert.deepEqual(resolveProjectAiStatus({ id: 'proj_tagged' }, [{
    appId: 'worldbase.local.custom-id',
    tags: ['worldbase.scaffold', 'proj_tagged'],
    aiReady: true
  }]), {
    aiReady: true,
    aiUpgradeAvailable: false
  })
})

function application (overrides = {}) {
  return {
    sourceId: 'worldbase.builtin',
    appId: 'worldbase.tasks',
    name: 'Tasks',
    version: '1.2.0',
    description: 'Manage tasks',
    trustLevel: 'builtin',
    enabled: true,
    capabilities: [{
      appId: 'worldbase.tasks',
      capabilityId: 'tasks.search',
      toolName: 'app__worldbase_tasks__tasks_search',
      title: 'Search tasks',
      risk: 'read',
      dataScopes: ['selected_workspace'],
      availability: 'available'
    }],
    health: { status: 'ready' },
    aiReady: true,
    ...overrides
  }
}

function grant (overrides = {}) {
  return {
    id: 'grant-1',
    appId: 'worldbase.tasks',
    capabilityPattern: 'tasks.*',
    permissions: [],
    dataScope: ['workspace'],
    mode: 'ask',
    expiresAt: null,
    createdAt: '2026-11-05T00:00:00.000Z',
    ...overrides
  }
}

function mountPanel (t, { apps = [application()], initialGrants = [grant()], audits = [] } = {}) {
  const fixture = rendererFixture(t)
  const calls = { list: 0, refresh: 0, setEnabled: [], save: [], revoke: [], audit: [] }
  let currentApps = apps
  let currentGrants = initialGrants
  fixture.window.electronAPI = {
    applications: {
      list: async () => { calls.list++; return { apps: currentApps } },
      refresh: async () => { calls.refresh++; return { refreshed: true } },
      setEnabled: async (appId, enabled) => {
        calls.setEnabled.push({ appId, enabled })
        currentApps = currentApps.map(app => app.appId === appId ? { ...app, enabled } : app)
        return { success: true }
      },
      grants: {
        list: async () => ({ grants: currentGrants }),
        save: async (input) => {
          calls.save.push(input)
          currentGrants = [...currentGrants, { ...input, id: 'grant-2', createdAt: '2026-11-05T00:00:00.000Z' }]
          return { success: true }
        },
        revoke: async (grantId) => {
          calls.revoke.push(grantId)
          currentGrants = currentGrants.filter(item => item.id !== grantId)
          return { success: true }
        }
      },
      audit: {
        list: async (options) => { calls.audit.push(options); return { audits } }
      }
    },
    lightapps: {
      list: async () => ({ apps: [] }),
      delete: async () => ({ deleted: true })
    }
  }
  const mounted = fixture.mount(ApplicationsPanel, {})
  return { ...mounted, window: fixture.window, calls }
}

test('loads applications, grants, and the latest audit page', async t => {
  const audit = { callId: 'call-1', appId: 'worldbase.tasks', capabilityId: 'tasks.search', status: 'ok', durationMs: 12 }
  const panel = mountPanel(t, { audits: [audit] })
  await flush()
  await flush()

  assert.equal(panel.state.loading, false)
  assert.equal(panel.state.error, '')
  assert.equal(panel.state.apps.length, 1)
  assert.equal(panel.state.grants.length, 1)
  assert.equal(panel.state.audits.length, 1)
  assert.deepEqual(panel.calls.audit[0], { limit: 20 })
  assert.equal(panel.state.grantsFor('worldbase.tasks').length, 1)
  assert.equal(panel.state.appLabel('worldbase.tasks'), 'Tasks')
})

test('toggling an application calls the Rust-backed setEnabled IPC and reloads', async t => {
  const panel = mountPanel(t)
  await flush()
  await flush()

  await panel.state.toggleEnabled(panel.state.apps[0])
  assert.deepEqual(panel.calls.setEnabled, [{ appId: 'worldbase.tasks', enabled: false }])
  assert.equal(panel.state.apps[0].enabled, false)
  assert.equal(panel.state.statusMessage, '已禁用 Tasks')

  await panel.state.toggleEnabled(panel.state.apps[0])
  assert.deepEqual(panel.calls.setEnabled[1], { appId: 'worldbase.tasks', enabled: true })
  assert.equal(panel.state.apps[0].enabled, true)
})

test('saving a grant forwards the capability pattern, mode, scopes, and expiry', async t => {
  const panel = mountPanel(t)
  await flush()
  await flush()

  panel.state.openGrantDialog(panel.state.apps[0], 'tasks.search')
  panel.state.grantDialog.mode = 'allow'
  panel.state.grantDialog.dataScope = 'workspace, conversation'
  panel.state.grantDialog.expiresAt = '2030-01-02T03:04'
  await panel.state.saveGrant()

  assert.equal(panel.calls.save.length, 1)
  assert.equal(panel.calls.save[0].appId, 'worldbase.tasks')
  assert.equal(panel.calls.save[0].capabilityPattern, 'tasks.search')
  assert.equal(panel.calls.save[0].mode, 'allow')
  assert.deepEqual(panel.calls.save[0].dataScope, ['workspace', 'conversation'])
  assert.equal(panel.calls.save[0].expiresAt, new Date('2030-01-02T03:04').toISOString())
  assert.equal(panel.state.grantDialog.open, false)
  assert.equal(panel.state.grants.length, 2)
})

test('revoking a grant calls the Rust IPC and reloads the grant list', async t => {
  const panel = mountPanel(t)
  await flush()
  await flush()

  await panel.state.revokeGrant(panel.state.grants[0])
  assert.deepEqual(panel.calls.revoke, ['grant-1'])
  assert.equal(panel.state.grants.length, 0)
  assert.equal(panel.state.statusMessage, '已撤销 Tasks 的授权')
})

test('refresh invokes application.refresh and reports the result', async t => {
  const panel = mountPanel(t)
  await flush()
  await flush()

  await panel.state.refreshApplications()
  assert.equal(panel.calls.refresh, 1)
  assert.equal(panel.state.refreshing, false)
  assert.equal(panel.state.statusMessage, '应用目录已刷新')
})

test('a load failure surfaces an error state with retry', async t => {
  const panel = mountPanel(t)
  await flush()
  await flush()
  panel.window.electronAPI.applications.list = async () => { throw new Error('catalog offline') }

  await panel.state.loadApplications()
  assert.equal(panel.state.loading, false)
  assert.match(panel.state.error, /catalog offline/)
})
