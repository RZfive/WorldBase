import { execFile } from 'node:child_process'
import { mkdir, copyFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const electronDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoRoot = path.resolve(electronDir, '../..')
const manifest = path.join(repoRoot, 'harness-rs', 'Cargo.toml')
const targetDir = path.join(repoRoot, 'harness-rs', 'target', 'release')
const outputDir = path.join(electronDir, 'resources', 'harness')
const executable = process.platform === 'win32' ? 'worldbase-app-server.exe' : 'worldbase-app-server'

await run('cargo', ['build', '--manifest-path', manifest, '--release', '-p', 'worldbase-app-server'], {
  cwd: repoRoot,
  maxBuffer: 10 * 1024 * 1024
})
await mkdir(outputDir, { recursive: true })
// Keep only the host binary in the resources directory. This prevents a
// previous build from packaging an executable for a different platform when
// the same checkout is reused across targets.
await Promise.all([
  rm(path.join(outputDir, 'worldbase-app-server'), { force: true }),
  rm(path.join(outputDir, 'worldbase-app-server.exe'), { force: true })
])
await copyFile(path.join(targetDir, executable), path.join(outputDir, executable))
console.log(`[build-harness] copied ${executable} to ${path.relative(repoRoot, outputDir)}`)
