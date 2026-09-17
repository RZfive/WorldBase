import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createComputerUsePermissionService } from '../electron/main-process/permissions/computer-use.ts'
import { createComputerUsePermissionState } from '../src/renderer/utils/computer-use-permissions.ts'
import checkMacPermissionSigning from '../scripts/check-macos-permission-signing.cjs'

function fixture (overrides = {}) {
  const calls = { screenReads: 0, accessibility: [], screenRequests: 0, panes: [], warnings: [] }
  const host = {
    platform: 'darwin',
    isPackaged: true,
    executablePath: '/Applications/WorldBase.app/Contents/MacOS/WorldBase',
    getScreenStatus: () => { calls.screenReads++; return 'denied' },
    isAccessibilityTrusted: prompt => { calls.accessibility.push(prompt); return false },
    requestScreenAccess: async () => { calls.screenRequests++ },
    openExternal: async url => { calls.panes.push(url) },
    warn: (...args) => { calls.warnings.push(args) },
    ...overrides
  }
  return { calls, host, service: createComputerUsePermissionService(host) }
}

const screenPane = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const accessibilityPane = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

test('packaged startup reads each permission once without requesting access or capturing the desktop', () => {
  const { calls, service } = fixture()
  const status = service.initialize()
  assert.deepEqual(status, {
    platform: 'darwin', isPackaged: true, appPath: '/Applications/WorldBase.app',
    screen: 'denied', accessibility: false, granted: false
  })
  for (let i = 0; i < 1000; i++) {
    assert.equal(service.initialize(), status)
    assert.equal(service.get(), status)
  }
  assert.equal(calls.screenReads, 1)
  assert.deepEqual(calls.accessibility, [false])
  assert.equal(calls.screenRequests, 0)
  assert.deepEqual(calls.panes, [])
})

test('diagnostics identify the running dev/copy/translocated app, not a hard-coded installation path', () => {
  for (const [isPackaged, appPath] of [
    [false, '/repo/node_modules/electron/dist/Electron.app'],
    [true, '/Volumes/WorldBase 1.5/WorldBase.app'],
    [true, '/private/var/folders/AppTranslocation/example/d/WorldBase.app']
  ]) {
    const { service } = fixture({ isPackaged, executablePath: `${appPath}/Contents/MacOS/WorldBase` })
    const status = service.initialize()
    assert.equal(status.isPackaged, isPackaged)
    assert.equal(status.appPath, appPath)
  }
})

test('probe failures are reported and do not discard the other permission', () => {
  const screenFailure = fixture({
    getScreenStatus: () => { throw new Error('screen probe unavailable') },
    isAccessibilityTrusted: () => true
  })
  const screenStatus = screenFailure.service.initialize()
  assert.equal(screenStatus.screen, 'unknown')
  assert.equal(screenStatus.accessibility, true)
  assert.equal(screenStatus.granted, false)
  assert.equal(screenFailure.calls.warnings.length, 1)
  assert.match(screenFailure.calls.warnings[0][0], /Screen Recording/)

  const accessibilityFailure = fixture({
    getScreenStatus: () => 'granted',
    isAccessibilityTrusted: () => { throw new Error('AX probe unavailable') }
  })
  const accessibilityStatus = accessibilityFailure.service.initialize()
  assert.equal(accessibilityStatus.screen, 'granted')
  assert.equal(accessibilityStatus.accessibility, false)
  assert.equal(accessibilityStatus.granted, false)
  assert.equal(accessibilityFailure.calls.warnings.length, 1)
  assert.match(accessibilityFailure.calls.warnings[0][0], /Accessibility/)
})

test('Grant registers both denied permissions as the current app without updating the snapshot', async () => {
  const { calls, service } = fixture()
  const startup = service.initialize()
  const results = await Promise.all([service.request(), service.request()])
  assert.deepEqual(results, [{ granted: false }, { granted: false }])
  assert.equal(calls.screenRequests, 1)
  assert.equal(calls.screenReads, 1)
  assert.deepEqual(calls.accessibility, [false, true])
  assert.deepEqual(calls.panes, [screenPane])
  assert.equal(service.get(), startup)
})

test('request failure/denial still opens the requested Settings pane', async () => {
  const { calls, service } = fixture({
    isAccessibilityTrusted: prompt => {
      if (prompt) throw new Error('Accessibility prompt unavailable')
      return false
    },
    requestScreenAccess: async () => { throw new Error('Screen Recording denied') }
  })
  service.initialize()
  assert.deepEqual(await service.request(), { granted: false })
  assert.deepEqual(calls.panes, [screenPane])
  assert.equal(calls.warnings.length, 2)
})

test('explicit Accessibility remains reachable even with a denied startup screen snapshot', async () => {
  const { calls, service } = fixture()
  service.initialize()
  await service.request('accessibility')
  assert.equal(calls.screenRequests, 0)
  assert.deepEqual(calls.accessibility, [false, true])
  assert.deepEqual(calls.panes, [accessibilityPane])
})

test('explicit Screen Recording does not prompt for Accessibility', async () => {
  const { calls, service } = fixture({ getScreenStatus: () => 'not-determined' })
  service.initialize()
  await service.request('screen')
  assert.equal(calls.screenRequests, 1)
  assert.deepEqual(calls.accessibility, [false])
  assert.deepEqual(calls.panes, [screenPane])
})

test('default Grant skips an already-granted screen and opens Accessibility', async () => {
  const { calls, service } = fixture({ getScreenStatus: () => 'granted' })
  service.initialize()
  await service.request()
  assert.equal(calls.screenRequests, 0)
  assert.deepEqual(calls.accessibility, [false, true])
  assert.deepEqual(calls.panes, [accessibilityPane])
})

test('a granted startup snapshot opens no prompts and never interprets new requests as a recheck', async () => {
  const { calls, service } = fixture({ getScreenStatus: () => 'granted', isAccessibilityTrusted: () => true })
  const status = service.initialize()
  assert.equal(status.granted, true)
  assert.deepEqual(await service.request(), { granted: true })
  assert.equal(calls.screenRequests, 0)
  assert.deepEqual(calls.panes, [])
  await service.request('accessibility')
  assert.deepEqual(calls.panes, [accessibilityPane])
  assert.equal(service.get(), status)
})

test('non-macOS platforms retain the previous grant policy without native macOS calls', async () => {
  for (const platform of ['win32', 'linux']) {
    const { calls, service } = fixture({ platform, executablePath: '/bin/worldbase' })
    assert.equal(service.initialize().granted, true)
    assert.deepEqual(await service.request(), { granted: true })
    assert.equal(calls.screenReads, 0)
    assert.equal(calls.screenRequests, 0)
    assert.deepEqual(calls.accessibility, [])
    assert.deepEqual(calls.panes, [])
  }
})

test('request validation rejects arbitrary renderer input and a failed request can be retried', async () => {
  let opens = 0
  const { calls, service } = fixture({ openExternal: async () => { if (++opens === 1) throw new Error('cannot open Settings') } })
  service.initialize()
  for (const target of ['https://example.invalid', '__proto__', null, {}]) {
    await assert.rejects(service.request(target), /Unknown Computer Use permission target/)
  }
  assert.equal(calls.screenRequests, 0)
  await assert.rejects(service.request('screen'), /cannot open Settings/)
  await service.request('screen')
  assert.equal(opens, 2)
  assert.equal(calls.screenRequests, 2)
})

test('the shared renderer state forwards explicit targets without reloading or changing permission status', async () => {
  const { service, calls } = fixture()
  const startup = service.initialize()
  let reads = 0
  const state = createComputerUsePermissionState(() => ({
    getComputerUsePermissions: async () => { reads++; return service.get() },
    requestComputerUsePermissions: target => service.request(target)
  }))
  await state.initialize()
  await state.request('screen')
  await state.request('accessibility')
  assert.equal(reads, 1)
  assert.equal(state.status.value, startup)
  assert.equal(state.granted.value, false)
  assert.equal(state.requesting.value, false)
  assert.deepEqual(calls.panes, [screenPane, accessibilityPane])
})

function signingContext (forceCodeSigning = false, electronPlatformName = 'darwin') {
  return {
    electronPlatformName,
    appOutDir: '/build output/mac-arm64',
    packager: { forceCodeSigning, appInfo: { productFilename: 'WorldBase' } }
  }
}

test('macOS packaging warns about the actual ad-hoc signature and keeps local builds possible', async () => {
  const warnings = []
  await checkMacPermissionSigning(signingContext(), {
    run: async (executable, args) => {
      assert.equal(executable, '/usr/bin/codesign')
      assert.deepEqual(args, ['-d', '--verbose=4', '-r-', '/build output/mac-arm64/WorldBase.app'])
      return { stderr: 'Signature=adhoc\nTeamIdentifier=not set\n# designated => cdhash H"example"\n' }
    },
    warn: message => warnings.push(message)
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /remove stale WorldBase entries/)
  assert.match(warnings[0], /electron:build:mac:arm64:signed/)
})

test('the signed build rejects ad-hoc/no-team signatures and permits a team-backed identity', async () => {
  const warnings = []
  const warn = message => warnings.push(message)
  for (const stderr of ['Signature=adhoc\nTeamIdentifier=not set\n', 'TeamIdentifier=not set\n', '']) {
    await assert.rejects(checkMacPermissionSigning(signingContext(true), {
      run: async () => ({ stderr }), warn
    }), /no team-backed signing identity/)
  }
  await checkMacPermissionSigning(signingContext(true), {
    run: async () => ({ stderr: 'Authority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n' }), warn
  })
  assert.deepEqual(warnings, [])
})

test('signature inspection failures warn locally, fail signed builds, and do not run off macOS', async () => {
  let runs = 0
  const warnings = []
  const deps = { run: async () => { runs++; throw new Error('signature unavailable') }, warn: message => warnings.push(message) }
  await checkMacPermissionSigning(signingContext(), deps)
  assert.equal(warnings.length, 1)
  await assert.rejects(checkMacPermissionSigning(signingContext(true), deps), /signature unavailable/)
  await checkMacPermissionSigning(signingContext(true, 'win32'), deps)
  assert.equal(runs, 2)
})

test('packaging wires the signing hook and a strict distribution build without disabling security', async () => {
  const config = JSON.parse(await readFile(new URL('../electron-builder.json', import.meta.url)))
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
  assert.equal(config.afterSign, 'scripts/check-macos-permission-signing.cjs')
  assert.equal(config.appId, 'com.theworld.app')
  assert.notEqual(config.mac.hardenedRuntime, false)
  assert.notEqual(config.mac.identity, null)
  assert.match(pkg.scripts['electron:build:mac:arm64:signed'], /-c\.mac\.forceCodeSigning=true/)
  assert.match(pkg.scripts['electron:build:mac:arm64:signed'], /-c\.mac\.type=distribution/)
})
