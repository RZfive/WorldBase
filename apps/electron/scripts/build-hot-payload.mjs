import { createHash, createPrivateKey, sign } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'

// archiver v8 是 ESM，命名导出 ZipArchive 类（Node 22 的 require(esm) 可直接加载）。
const require = createRequire(import.meta.url)
const { ZipArchive } = require('archiver')
// 自检复用客户端同一把 extract-zip：解包结果与用户机器上 apply 看到的完全一致。
const extractZip = require('extract-zip')

// 产出 docs/desktop-hot-update-design.md 第 3 节定义的 Hot Payload：
// release/win-unpacked/resources 里的 app.asar、app.asar.unpacked、harness，
// 加上签好名的 manifest.json / manifest.sig，打成一个 zip 并输出整体 sha256。

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(scriptDir, '..')
const execFileAsync = promisify(execFile)

const MANIFEST_SCHEMA_VERSION = 1
// 热包内容白名单：相对 resources/ 的顶层条目。Electron 运行时（exe/dll/locales/pak）
// 都在 win-unpacked 根下，本就不在这个目录里；resources 下仅排除安装器辅助文件。
const HOT_PAYLOAD_ENTRIES = ['app.asar', 'app.asar.unpacked', 'harness']
const EXCLUDED_NAMES = new Set(['.DS_Store', 'elevate.exe', 'LICENSE', 'LICENSE.electron.txt', 'LICENSES.chromium.html'])

// manifest（collectFiles）与 zip 内容（fsp.cp）必须用同一套排除规则：
// 两者一旦漂移，客户端 apply 的"清单外文件"白名单校验会拒绝整个热包。
// 名单是按 basename 匹配的，node_modules 深处的 LICENSE 同样被两侧一致地排除。
function isExcludedName (target) {
  return EXCLUDED_NAMES.has(path.basename(target))
}

// 三平台打包布局不同：win = release/win-unpacked/resources，
// mac = release/mac-arm64/WorldBase.app/Contents/Resources，
// linux = release/linux-unpacked/resources。
function defaultPackagedResources () {
  switch (process.platform) {
    case 'darwin': return path.join(appDir, 'release', 'mac-arm64', 'WorldBase.app', 'Contents', 'Resources')
    case 'linux': return path.join(appDir, 'release', 'linux-unpacked', 'resources')
    default: return path.join(appDir, 'release', 'win-unpacked', 'resources')
  }
}

function parseArgs (argv) {
  const defaultPlatform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'win32'
  const options = { platform: defaultPlatform, arch: process.arch, minBaseVersion: '', source: '', output: '' }
  for (const arg of argv) {
    if (arg.startsWith('--platform=')) options.platform = arg.slice('--platform='.length)
    else if (arg.startsWith('--arch=')) options.arch = arg.slice('--arch='.length)
    else if (arg.startsWith('--min-base-version=')) options.minBaseVersion = arg.slice('--min-base-version='.length)
    else if (arg.startsWith('--source=')) options.source = arg.slice('--source='.length)
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length)
  }
  return options
}

async function pathExists (target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

async function readJson (filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'))
}

async function resolveGitSha () {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: appDir })
    return stdout.trim()
  } catch {
    return ''
  }
}

function inferChannel (version) {
  return /(?:alpha|beta|rc)/i.test(version) ? 'beta' : 'stable'
}

async function collectFiles (rootDir, relDir = '') {
  const entries = await fsp.readdir(path.join(rootDir, relDir), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (isExcludedName(entry.name)) continue
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...await collectFiles(rootDir, relPath))
    } else if (entry.isFile()) {
      files.push(relPath)
    }
  }
  return files.sort()
}

async function hashFile (filePath) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return hash.digest('hex')
}

async function listFilesRecursive (rootDir, relDir = '') {
  const entries = await fsp.readdir(path.join(rootDir, relDir), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(rootDir, relPath))
    } else if (entry.isFile()) {
      files.push(relPath)
    }
  }
  return files.sort()
}

/**
 * 打包自检：重新解包产出的 zip，内容必须与 manifest 严格一致
 * （manifest.files + manifest.json [+ manifest.sig]，多一个或少一个都算失败）。
 * manifest 与包内容漂移 = 客户端 apply 必败，必须在 CI 就拦下。
 */
async function verifyZipMatchesManifest (zipPath, manifest, signed) {
  const checkDir = `${zipPath}.verify`
  await fsp.rm(checkDir, { recursive: true, force: true })
  try {
    await extractZip(zipPath, { dir: checkDir })
    const actual = await listFilesRecursive(checkDir)
    const expected = new Set(['manifest.json', ...manifest.files.map(file => file.path)])
    if (signed) expected.add('manifest.sig')
    const missing = [...expected].filter(relPath => !actual.includes(relPath))
    const extra = actual.filter(relPath => !expected.has(relPath))
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `zip content does not match manifest: ${missing.length} missing, ${extra.length} extra; ` +
        `missingSample=${JSON.stringify(missing.slice(0, 3))} extraSample=${JSON.stringify(extra.slice(0, 3))}`
      )
    }
  } finally {
    await fsp.rm(checkDir, { recursive: true, force: true })
  }
}

function loadSigningKey (raw) {
  const value = (raw || '').trim()
  if (!value) return null
  if (value.includes('-----BEGIN')) {
    return createPrivateKey(value.replace(/\\n/g, '\n'))
  }
  return createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' })
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  const resourcesDir = options.source || defaultPackagedResources()
  // 默认输出到 electron-builder 的 release 目录，与 .exe/latest.yml 并列，
  // CI 的 artifact 上传 glob 只匹配 apps/electron/release/WorldBase-hot-*.zip。
  const outputDir = options.output || path.join(appDir, 'release')

  if (!await pathExists(resourcesDir)) {
    throw new Error(`Packaged resources not found: ${resourcesDir}. Run the platform electron:build first.`)
  }
  for (const entry of HOT_PAYLOAD_ENTRIES) {
    if (!await pathExists(path.join(resourcesDir, entry))) {
      throw new Error(`Hot payload entry missing in packaged resources: ${entry}`)
    }
  }

  const appPackage = await readJson(path.join(appDir, 'package.json'))
  const electronPackage = await readJson(path.join(appDir, 'node_modules', 'electron', 'package.json'))
  const version = appPackage.version
  const relPaths = []
  for (const entry of HOT_PAYLOAD_ENTRIES) {
    const stat = await fsp.stat(path.join(resourcesDir, entry))
    if (stat.isDirectory()) {
      relPaths.push(...await collectFiles(resourcesDir, entry))
    } else {
      relPaths.push(entry)
    }
  }

  const files = []
  for (const relPath of relPaths) {
    const absPath = path.join(resourcesDir, relPath)
    const [sha256, stat] = await Promise.all([hashFile(absPath), fsp.stat(absPath)])
    files.push({ path: relPath, sha256, size: stat.size })
  }

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: 'hot_payload',
    appId: appPackage.build?.appId || 'com.theworld.app',
    version,
    channel: inferChannel(version),
    platform: options.platform,
    arch: options.arch,
    electronVersion: electronPackage.version,
    ...(options.minBaseVersion ? { minBaseVersion: options.minBaseVersion } : {}),
    builtAt: new Date().toISOString(),
    gitSha: await resolveGitSha(),
    files
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const signingKey = loadSigningKey(process.env.HOT_PAYLOAD_PRIVATE_KEY)
  let signature = null
  if (signingKey) {
    signature = sign(null, manifestBytes, signingKey).toString('base64')
  } else {
    console.warn('[hot-payload] HOT_PAYLOAD_PRIVATE_KEY is not set; manifest.sig will not be generated.')
  }

  const baseName = `WorldBase-hot-${version}-${options.platform}-${options.arch}`
  const zipPath = path.join(outputDir, `${baseName}.zip`)
  const staging = path.join(outputDir, 'hot-payload-staging')

  await fsp.rm(staging, { recursive: true, force: true })
  await fsp.mkdir(staging, { recursive: true })
  for (const entry of HOT_PAYLOAD_ENTRIES) {
    // filter 返回 true 表示复制；与 collectFiles 的排除规则同源，保证 zip 内容与 manifest 永远一致
    await fsp.cp(path.join(resourcesDir, entry), path.join(staging, entry), { recursive: true, filter: src => !isExcludedName(src) })
  }
  await fsp.writeFile(path.join(staging, 'manifest.json'), manifestBytes)
  if (signature) {
    await fsp.writeFile(path.join(staging, 'manifest.sig'), `${signature}\n`)
  }

  const output = fs.createWriteStream(zipPath)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  const done = new Promise((resolve, reject) => {
    output.once('error', reject)
    archive.once('error', reject)
    output.once('close', () => resolve())
  })
  archive.pipe(output)
  archive.directory(staging, false)
  await archive.finalize()
  await done
  await fsp.rm(staging, { recursive: true, force: true })

  await verifyZipMatchesManifest(zipPath, manifest, Boolean(signature))

  const zipSha256 = await hashFile(zipPath)
  const zipStat = await fsp.stat(zipPath)
  await fsp.writeFile(path.join(outputDir, `${baseName}.zip.sha256`), `${zipSha256}  ${path.basename(zipPath)}\n`)

  console.log(`[hot-payload] version=${version} electron=${manifest.electronVersion} files=${files.length}`)
  console.log(`[hot-payload] zip=${zipPath} size=${zipStat.size} sha256=${zipSha256}`)
  console.log(`[hot-payload] signed=${Boolean(signature)}`)
}

main().catch((error) => {
  console.error('[hot-payload] failed:', error.message)
  process.exit(1)
})
