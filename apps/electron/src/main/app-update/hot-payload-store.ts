import { app } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * 热更新包的本地状态管理（docs/desktop-hot-update-design.md 5.1/5.3/5.4）。
 *
 * 目录固定在 %LOCALAPPDATA%/WorldBase/hot 而不是 userData（Roaming）：
 * 每版热包 100MB 上下，不能进漫游配置。bootstrap（build-main.mjs 生成的
 * main.cjs）按同样的路径约定读取 current.json，两边必须保持一致。
 */

export interface HotPayloadManifest {
  schemaVersion?: number
  kind?: string
  appId?: string
  version: string
  channel?: string
  platform?: string
  arch?: string
  electronVersion?: string
  minBaseVersion?: string
  builtAt?: string
  gitSha?: string
  files: Array<{ path: string; sha256: string; size: number }>
}

export interface HotBootState {
  version: string
  attempts: number
  lastOkAt?: string
}

export interface HotPendingEvent {
  kind: 'hot_payload'
  fromVersion: string
  toVersion: string
  phase: 'rolled_back'
  error?: string
}

export interface HotCurrentPointer {
  version: string
  dir: string
}

/** 客户端内置的 ed25519 公钥（SPKI DER, base64）。轮换时新旧并存一个版本周期。 */
const HOT_PAYLOAD_PUBLIC_KEYS: string[] = [
  'MCowBQYDK2VwAyEAWllDlczN2T6XKvqncvr1DlK/UtZ/BU36R2Qo1PP6GX8='
]

/**
 * 跨平台热包根目录，与 build-main.mjs bootstrap 里的 resolveHotRoot() 必须保持一致。
 * 每版热包 100MB 上下：Windows 走 LOCALAPPDATA（避开 Roaming），mac 放
 * Application Support，linux 走 XDG_DATA_HOME（默认 ~/.local/share）。
 */
export function getHotRoot (): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || app.getPath('home')
    return path.join(localAppData, 'WorldBase', 'hot')
  }
  const home = app.getPath('home')
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'WorldBase', 'hot')
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  return path.join(dataHome, 'WorldBase', 'hot')
}

function readJsonSync<T> (filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJsonSync (filePath: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
  } catch {
    // 状态写失败只影响回滚精度，不能让主流程失败
  }
}

export function readCurrentPointer (): HotCurrentPointer | null {
  const current = readJsonSync<HotCurrentPointer>(path.join(getHotRoot(), 'current.json'))
  if (!current || typeof current.version !== 'string' || !current.version) return null
  return {
    version: current.version,
    dir: typeof current.dir === 'string' && current.dir ? current.dir : current.version
  }
}

/** 所有引用 process.resourcesPath 的地方都应改走这里，保证 JS 与 Rust 二进制同源。 */
export function resolveResourcesPath (): string {
  return process.env.WORLDBASE_HOT_RESOURCES || process.resourcesPath
}

export function isHotPayloadActive (): boolean {
  return Boolean(process.env.WORLDBASE_HOT_RESOURCES)
}

/**
 * 生效版本：热包生效时是 manifest 的 version，否则是安装器版本。
 * About 页展示、更新检查的 current 参数、启动上报都应使用它；
 * installed 参数（安装器版本）仍由调用方传 app.getVersion()。
 */
export function getEffectiveVersion (): string {
  return readCurrentPointer()?.version || app.getVersion()
}

export function getInstalledVersion (): string {
  return app.getVersion()
}

export function resetBootState (version: string): void {
  writeJsonSync(path.join(getHotRoot(), 'boot-state.json'), { version, attempts: 0 })
}

export function writeCurrentPointer (version: string): void {
  writeJsonSync(path.join(getHotRoot(), 'current.json'), { version, dir: version })
}

/**
 * 主窗口 ready 且 Rust harness 握手成功后调用：确认这一版热包能正常工作。
 * 返回上一次启动的版本（用于 boot_ok 事件的 fromVersion 语义调整）。
 */
export function markHotBootOk (): void {
  const pointer = readCurrentPointer()
  if (!pointer) return
  writeJsonSync(path.join(getHotRoot(), 'boot-state.json'), {
    version: pointer.version,
    attempts: 0,
    lastOkAt: new Date().toISOString()
  })
}

export async function readPendingEvents (): Promise<HotPendingEvent[]> {
  try {
    const raw = await fsp.readFile(path.join(getHotRoot(), 'pending-events.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function clearPendingEvents (): Promise<void> {
  try {
    await fsp.rm(path.join(getHotRoot(), 'pending-events.json'), { force: true })
  } catch {
    // 忽略
  }
}

/** 保留当前版与其余最新的 N-1 个版本目录，删除更早的。 */
export async function pruneHotVersions (keepCount = 2): Promise<void> {
  const pointer = readCurrentPointer()
  try {
    const entries = await fsp.readdir(getHotRoot(), { withFileTypes: true })
    const versionDirs = entries
      .filter(entry => entry.isDirectory() && /^\d+(\.\d+)*$/.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .reverse()

    for (const [index, name] of versionDirs.entries()) {
      const isCurrent = pointer != null && (name === pointer.dir || name === pointer.version)
      if (!isCurrent && index >= keepCount) {
        await fsp.rm(path.join(getHotRoot(), name), { recursive: true, force: true }).catch(() => {})
      }
    }
  } catch {
    // 清理失败不影响应用
  }
}

export { HOT_PAYLOAD_PUBLIC_KEYS }
