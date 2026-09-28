// Bootstrap 热更新分支功能验证：从 scripts/build-main.mjs 生成的 main.cjs 里
// 提取 tryActivateHotPayload + resolveHotRoot，在受控沙箱里跑多平台启动场景。
// 前置：先运行 `node scripts/build-main.mjs` 生成 dist-electron/electron/main.cjs
//（本测试的 npm script 已保证这一点）。
import { test } from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const { fileURLToPath } = await import('node:url')
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const loaderPath = path.join(workspaceRoot, 'dist-electron', 'electron', 'main.cjs')

const source = fs.readFileSync(loaderPath, 'utf8')
const start = source.indexOf('function compareSemverCore')
const end = source.indexOf('(async () => {')
if (start < 0 || end < 0) {
  throw new Error('bootstrap hot payload functions not found in generated main.cjs; run build:main first')
}
const functions = source.slice(start, end)

const PLATFORM_ROOTS = {
  win32: (base) => ({ env: { LOCALAPPDATA: base }, root: path.join(base, 'WorldBase', 'hot') }),
  darwin: (base) => ({ env: { HOME: base }, root: path.join(base, 'Library', 'Application Support', 'WorldBase', 'hot') }),
  linux: (base) => ({ env: { HOME: base, XDG_DATA_HOME: path.join(base, 'xdg') }, root: path.join(base, 'xdg', 'WorldBase', 'hot') })
}

async function makeEnv (platform) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), `wb-hot-${platform}-`))
  const { env, root } = PLATFORM_ROOTS[platform](base)
  const versionDir = path.join(root, '1.5.2')
  await fsp.mkdir(path.join(versionDir, 'app.asar', 'dist-electron', 'electron'), { recursive: true })
  await fsp.writeFile(path.join(versionDir, 'app.asar', 'dist-electron', 'electron', 'main.cjs'), 'module.exports = {}')
  await fsp.writeFile(path.join(versionDir, 'manifest.json'), JSON.stringify({
    kind: 'hot_payload',
    version: '1.5.2',
    electronVersion: '40.8.0'
  }))
  return { base, env, root, versionDir, platform }
}

function buildActivator (env, overrides = {}) {
  const context = {
    process: {
      platform: env.platform,
      env: env.env,
      versions: { electron: '40.8.0' }
    },
    console,
    require,
    join: path.join,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    rmSync: fs.rmSync,
    ...overrides
  }
  const script = new vm.Script(`(function (app) {\n${functions}\nreturn tryActivateHotPayload(app);\n})`)
  return script.runInNewContext(context)
}

const packagedApp = { isPackaged: true, getVersion: () => '1.5.0' }

async function withEnv (platform, run) {
  const env = await makeEnv(platform)
  try {
    await run(env)
  } finally {
    await fsp.rm(env.base, { recursive: true, force: true })
  }
}

test('missing current.json falls back to installed app', async () => {
  await withEnv('win32', async (env) => {
    if (buildActivator(env)(packagedApp) !== null) throw new Error('expected null without current.json')
  })
})

test('valid payload activates and counts boot attempts (win32)', async () => {
  await withEnv('win32', async (env) => {
    await fsp.writeFile(path.join(env.root, 'current.json'), JSON.stringify({ version: '1.5.2', dir: '1.5.2' }))
    const activate = buildActivator(env)
    const entry = activate(packagedApp)
    if (typeof entry !== 'string' || !entry.endsWith('main.cjs')) throw new Error(`unexpected entry: ${entry}`)
    const first = JSON.parse(await fsp.readFile(path.join(env.root, 'boot-state.json'), 'utf8'))
    if (first.attempts !== 1) throw new Error(`expected attempts=1, got ${first.attempts}`)
    activate(packagedApp)
    const second = JSON.parse(await fsp.readFile(path.join(env.root, 'boot-state.json'), 'utf8'))
    if (second.attempts !== 2) throw new Error(`expected attempts=2, got ${second.attempts}`)
  })
})

test('valid payload activates in the macOS hot root', async () => {
  await withEnv('darwin', async (env) => {
    await fsp.writeFile(path.join(env.root, 'current.json'), JSON.stringify({ version: '1.5.2', dir: '1.5.2' }))
    const entry = buildActivator(env)(packagedApp)
    if (typeof entry !== 'string' || !entry.includes('Application Support')) {
      throw new Error(`darwin entry not in Application Support: ${entry}`)
    }
  })
})

test('valid payload activates in the linux XDG data root', async () => {
  await withEnv('linux', async (env) => {
    await fsp.writeFile(path.join(env.root, 'current.json'), JSON.stringify({ version: '1.5.2', dir: '1.5.2' }))
    const entry = buildActivator(env)(packagedApp)
    if (typeof entry !== 'string' || !entry.startsWith(env.env.XDG_DATA_HOME)) {
      throw new Error(`linux entry not under XDG_DATA_HOME: ${entry}`)
    }
  })
})

test('linux falls back to ~/.local/share without XDG_DATA_HOME', async () => {
  await withEnv('linux', async (env) => {
    const root = path.join(env.env.HOME, '.local', 'share', 'WorldBase', 'hot')
    const versionDir = path.join(root, '1.5.2')
    await fsp.mkdir(path.join(versionDir, 'app.asar', 'dist-electron', 'electron'), { recursive: true })
    await fsp.writeFile(path.join(versionDir, 'app.asar', 'dist-electron', 'electron', 'main.cjs'), 'module.exports = {}')
    await fsp.writeFile(path.join(versionDir, 'manifest.json'), JSON.stringify({
      kind: 'hot_payload', version: '1.5.2', electronVersion: '40.8.0'
    }))
    await fsp.writeFile(path.join(root, 'current.json'), JSON.stringify({ version: '1.5.2', dir: '1.5.2' }))
    const sandbox = { ...env, env: { HOME: env.env.HOME }, root }
    const entry = buildActivator(sandbox)(packagedApp)
    if (typeof entry !== 'string' || !entry.includes(path.join('.local', 'share'))) {
      throw new Error(`linux fallback entry unexpected: ${entry}`)
    }
  })
})

test('electron version mismatch cleans up and falls back', async () => {
  await withEnv('win32', async (env) => {
    await fsp.writeFile(path.join(env.root, 'current.json'), JSON.stringify({ version: '1.5.2', dir: '1.5.2' }))
    const activate = buildActivator(env, {
      process: {
        platform: 'win32',
        env: env.env,
        versions: { electron: '41.0.0' }
      }
    })
    if (activate(packagedApp) !== null) throw new Error('expected null on electron mismatch')
    if (fs.existsSync(env.versionDir)) throw new Error('hot dir should be removed')
    if (fs.existsSync(path.join(env.root, 'current.json'))) throw new Error('current.json should be removed')
  })
})

test('two failed boots roll back and queue a rollback event', async () => {
  await withEnv('win32', async (env) => {
    await fsp.writeFile(path.join(env.root, 'current.json'), JSON.stringify({ version: '1.5.2', dir: '1.5.2' }))
    await fsp.writeFile(path.join(env.root, 'boot-state.json'), JSON.stringify({ version: '1.5.2', attempts: 2 }))
    if (buildActivator(env)(packagedApp) !== null) throw new Error('expected null for bad package')
    if (fs.existsSync(env.versionDir)) throw new Error('hot dir should be removed on rollback')
    const pending = JSON.parse(await fsp.readFile(path.join(env.root, 'pending-events.json'), 'utf8'))
    if (!Array.isArray(pending) || pending[0]?.phase !== 'rolled_back' || pending[0]?.toVersion !== '1.5.2') {
      throw new Error(`unexpected pending events: ${JSON.stringify(pending)}`)
    }
  })
})

test('installer upgrade over the hot version clears the payload', async () => {
  await withEnv('win32', async (env) => {
    await fsp.writeFile(path.join(env.root, 'current.json'), JSON.stringify({ version: '1.5.2', dir: '1.5.2' }))
    const upgradedApp = { isPackaged: true, getVersion: () => '1.6.0' }
    if (buildActivator(env)(upgradedApp) !== null) throw new Error('expected null after installer upgrade')
    if (fs.existsSync(env.versionDir)) throw new Error('hot dir should be removed after upgrade')
  })
})

test('unpackaged (dev) runs never activate the hot payload', async () => {
  await withEnv('win32', async (env) => {
    await fsp.writeFile(path.join(env.root, 'current.json'), JSON.stringify({ version: '1.5.2', dir: '1.5.2' }))
    const devApp = { isPackaged: false, getVersion: () => '1.5.0' }
    if (buildActivator(env)(devApp) !== null) throw new Error('expected null in dev mode')
  })
})
