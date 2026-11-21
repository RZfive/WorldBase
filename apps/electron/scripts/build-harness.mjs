import { spawn } from 'node:child_process'
import { mkdir, copyFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

function runCargoCommand (args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const lines = createInterface({ input: child.stdout })
    let executable
    let stderr = ''
    lines.on('line', line => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        console.log(line)
        return
      }
      if (message.reason === 'compiler-artifact' && message.target?.name === 'worldbase-app-server' && message.target.kind.includes('bin')) {
        executable = message.executable || undefined
      }
    })
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr = (stderr + chunk).slice(-128 * 1024)
      process.stderr.write(chunk)
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      lines.close()
      if (code === 0) resolve({ executable })
      else reject(Object.assign(new Error(`Cargo exited (${code ?? signal}).`), { stderr, code }))
    })
  })
}

export function missingBuildOutputPackages (stderr) {
  const pattern = /error: couldn't read [`']([^`'\r\n]+)[`']: (?:No such file or directory|The system cannot find the file specified)/g
  const packages = new Set()
  for (const match of String(stderr || '').matchAll(pattern)) {
    const generated = match[1].replaceAll('\\', '/').match(/\/build\/([a-zA-Z0-9_-]+)-[a-f0-9]+\/out\/.+$/)
    if (generated) packages.add(generated[1])
  }
  return [...packages]
}

export async function buildHarness ({
  electronDir = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
  repoRoot = path.resolve(electronDir, '../..'),
  runCargo = runCargoCommand
} = {}) {
  const manifest = path.join(repoRoot, 'harness-rs', 'Cargo.toml')
  const args = ['build', '--manifest-path', manifest, '--release', '-p', 'worldbase-app-server', '--message-format=json-render-diagnostics']
  let artifact
  try {
    artifact = await runCargo(args, repoRoot)
  } catch (error) {
    const packages = missingBuildOutputPackages(error.stderr)
    if (!packages.length) throw error
    console.warn(`[build-harness] Missing cached build outputs; rebuilding ${packages.join(', ')}.`)
    await runCargo(['clean', '--manifest-path', manifest, '--release', ...packages.flatMap(name => ['-p', name])], repoRoot)
    artifact = await runCargo(args, repoRoot)
  }
  if (!artifact.executable) throw new Error('Cargo did not report a worldbase-app-server executable.')
  const outputDir = path.join(electronDir, 'resources', 'harness')
  const executable = process.platform === 'win32' ? 'worldbase-app-server.exe' : 'worldbase-app-server'
  const temporary = path.join(outputDir, `.${executable}.${process.pid}.tmp`)
  await mkdir(outputDir, { recursive: true })
  try {
    await copyFile(artifact.executable, temporary)
    await rename(temporary, path.join(outputDir, executable))
  } finally {
    await rm(temporary, { force: true })
  }
  await rm(path.join(outputDir, process.platform === 'win32' ? 'worldbase-app-server' : 'worldbase-app-server.exe'), { force: true })
  console.log(`[build-harness] copied ${executable} to ${path.relative(repoRoot, outputDir)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildHarness()
  } catch (error) {
    console.error(`[build-harness] ${error.message}`)
    process.exitCode = 1
  }
}
