import assert from 'node:assert/strict'
import test from 'node:test'
import { PermissionEngine } from '../src/main/ai-host/agent/permissions/permission-engine.ts'
import { toolOpenWorkspaceTab } from '../src/main/ai-host/agent/tools/tool-open-workspace-tab.ts'
import { validateAiBrowserTarget } from '../src/shared/web-target-validation.ts'

function createEngine (authMode) {
  return new PermissionEngine({
    getMainWindow: () => null,
    getSessionState: () => ({
      createdProjectId: null,
      targetProjectId: null,
      authMode,
      conversationId: 'page-security-test',
      sessionId: 'page-security-test-session'
    })
  })
}

test('page reads stay safe while page and form mutation require ask', async () => {
  for (const authMode of ['strict', 'auto']) {
    const engine = createEngine(authMode)

    const read = await engine.check('read_current_page', {})
    assert.deepEqual(read, { allowed: true, reason: 'Read-only tool', askedUser: false })

    for (const tool of ['fill_current_page_form', 'interact_current_page']) {
      const result = await engine.check(tool, {})
      assert.equal(result.askedUser, true, `${tool} must ask in ${authMode} mode`)
      assert.equal(result.reason, 'High-risk tool requires confirmation')
      // No window is available in this test, so the simulated prompt denies.
      assert.equal(result.allowed, false)
    }
  }
})

test('AI browser target validation accepts public http and https URLs', () => {
  assert.deepEqual(validateAiBrowserTarget('https://example.com/a'), {
    ok: true,
    url: 'https://example.com/a'
  })
  assert.deepEqual(validateAiBrowserTarget('http://example.com'), {
    ok: true,
    url: 'http://example.com/'
  })
})

test('AI browser target validation accepts public IPv4-embedded transition addresses', () => {
  const accepted = [
    'http://[2002:808:808::]',
    'http://[64:ff9b::808:808]',
    'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]',
    'http://[::ffff:0:808:808]',
    'http://[::ffff:0:0:808:808]',
    'http://[::ffff:0:0:0:8.8.8.8]',
    'http://[::ffff:8.8.8.8]'
  ]

  for (const raw of accepted) {
    const result = validateAiBrowserTarget(raw)
    assert.equal(result.ok, true, `${raw} must remain allowed`)
  }
})

test('AI browser target validation rejects dangerous schemes and local/private hosts', () => {
  const rejected = [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,x',
    'http://localhost:3000',
    'http://localhost./',
    'http://localhost.localdomain',
    'http://ip6-localhost',
    'http://ip6-loopback',
    'http://localhost4',
    'http://localhost6',
    'http://127.0.0.1',
    'http://10.0.0.1',
    'http://172.16.0.1',
    'http://192.168.1.1',
    'http://169.254.1.1',
    'http://100.64.0.1',
    'http://foo.local',
    'http://foo.internal',
    'http://[::1]',
    'http://[fe80::1]',
    'http://[fd00::1]',
    'http://[fec0::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:0:127.0.0.1]',
    'http://[::ffff:0:0:127.0.0.1]',
    'http://[::ffff:0:0:0:127.0.0.1]',
    'http://[2002:7f00:1::]',
    'http://[2002:c0a8:101::]',
    'http://[64:ff9b::127.0.0.1]',
    'http://[64:ff9b::c0a8:101]',
    'http://[2001:0:4136:e378:8000:63bf:80ff:fffe]',
    'http://[2001:0:c0a8:101:8000:63bf:3fff:fdd2]',
    'http://2130706433',
    'http://0.0.0.0'
  ]

  for (const raw of rejected) {
    const result = validateAiBrowserTarget(raw)
    assert.equal(result.ok, false, `${raw} must be rejected`)
    assert.equal(typeof result.reason, 'string', `${raw} must include a reason`)
    assert.ok(result.reason.length > 0, `${raw} must include a non-empty reason`)
  }
})

test('open_workspace_tab rejects unsafe browser targets before sending IPC', async () => {
  const sent = []
  const tool = toolOpenWorkspaceTab({
    getMainWindow: () => ({
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => {},
      focus: () => {},
      webContents: {
        send: (...args) => sent.push(args)
      }
    })
  })

  for (const url of ['file:///etc/passwd', 'http://127.0.0.1', 'http://foo.local']) {
    await assert.rejects(
      tool.handler({ kind: 'browser', url }),
      /browser URL rejected/,
      `${url} must be rejected before IPC`
    )
  }
  assert.equal(sent.length, 0)

  const opened = await tool.handler({ kind: 'browser', url: 'https://example.com/a' })
  assert.equal(opened.success, true)
  assert.deepEqual(sent, [[
    'workspace:openTab',
    { kind: 'browser', payload: { url: 'https://example.com/a' } }
  ]])
})
