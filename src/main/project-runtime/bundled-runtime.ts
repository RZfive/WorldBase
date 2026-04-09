import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let runtimeBinDirPromise: Promise<string> | null = null

function resolveBundledNodePath (): string {
  return process.execPath
}

function resolveBundledPnpmPackageDir (): string {
  const resolvedEntry = require.resolve('pnpm')

  if (path.basename(resolvedEntry) === 'package.json') {
    return path.dirname(resolvedEntry)
  }

  return path.dirname(path.dirname(resolvedEntry))
}

function resolveBundledPnpmCliPath (binName: 'pnpm' | 'pnpx'): string {
  const candidatePaths = new Set<string>([
    path.join(process.resourcesPath, 'app.asar', 'node_modules', 'pnpm', 'bin', `${binName}.cjs`),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'pnpm', 'bin', `${binName}.cjs`)
  ])

  const pnpmPackageDir = resolveBundledPnpmPackageDir()
  candidatePaths.add(path.join(pnpmPackageDir, 'bin', `${binName}.cjs`))

  try {
    const pnpmPackageJson = require(path.join(pnpmPackageDir, 'package.json')) as {
      bin?: string | Partial<Record<'pnpm' | 'pnpx', string>>
    }
    const declaredBinPath = typeof pnpmPackageJson.bin === 'string'
      ? pnpmPackageJson.bin
      : pnpmPackageJson.bin?.[binName]

    if (declaredBinPath) {
      candidatePaths.add(path.resolve(pnpmPackageDir, declaredBinPath))
    }
  } catch {
    // Ignore package metadata read failures and fall back to the well-known paths above.
  }

  for (const candidatePath of candidatePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath
    }
  }

  throw new Error(`Unable to resolve bundled ${binName} CLI entry from pnpm package`)
}

function shEscape (value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

async function writeExecutableFile (filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, 'utf-8')
  await fs.chmod(filePath, 0o755)
}

async function ensureRuntimeBinDir (): Promise<string> {
  if (!runtimeBinDirPromise) {
    runtimeBinDirPromise = (async () => {
      const nodePath = resolveBundledNodePath()
      const pnpmCliPath = resolveBundledPnpmCliPath('pnpm')
      const pnpxCliPath = resolveBundledPnpmCliPath('pnpx')
      const hash = crypto.createHash('sha256')
        .update(`${nodePath}\n${pnpmCliPath}\n${pnpxCliPath}`)
        .digest('hex')
        .slice(0, 12)
      const runtimeBinDir = path.join(os.tmpdir(), 'the-world-runtime', hash)

      await fs.mkdir(runtimeBinDir, { recursive: true })

      const unixNode = [
        '#!/bin/sh',
        `exec env ELECTRON_RUN_AS_NODE=1 ${shEscape(nodePath)} "$@"`
      ].join('\n')

      const unixNpm = [
        '#!/bin/sh',
        `exec env ELECTRON_RUN_AS_NODE=1 ${shEscape(nodePath)} ${shEscape(pnpmCliPath)} "$@"`
      ].join('\n')

      const unixNpx = [
        '#!/bin/sh',
        `exec env ELECTRON_RUN_AS_NODE=1 ${shEscape(nodePath)} ${shEscape(pnpxCliPath)} "$@"`
      ].join('\n')

      const windowsNode = [
        '@echo off',
        'setlocal',
        'set ELECTRON_RUN_AS_NODE=1',
        `"${nodePath}" %*`
      ].join('\r\n')

      const windowsNpm = [
        '@echo off',
        'setlocal',
        'set ELECTRON_RUN_AS_NODE=1',
        `"${nodePath}" "${pnpmCliPath}" %*`
      ].join('\r\n')

      const windowsNpx = [
        '@echo off',
        'setlocal',
        'set ELECTRON_RUN_AS_NODE=1',
        `"${nodePath}" "${pnpxCliPath}" %*`
      ].join('\r\n')

      await Promise.all([
        writeExecutableFile(path.join(runtimeBinDir, 'node'), unixNode),
        writeExecutableFile(path.join(runtimeBinDir, 'npm'), unixNpm),
        writeExecutableFile(path.join(runtimeBinDir, 'npx'), unixNpx),
        writeExecutableFile(path.join(runtimeBinDir, 'node.cmd'), windowsNode),
        writeExecutableFile(path.join(runtimeBinDir, 'npm.cmd'), windowsNpm),
        writeExecutableFile(path.join(runtimeBinDir, 'npx.cmd'), windowsNpx)
      ])

      return runtimeBinDir
    })()
  }

  return runtimeBinDirPromise
}

export async function createBundledRuntimeEnv (
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<NodeJS.ProcessEnv> {
  const runtimeBinDir = await ensureRuntimeBinDir()

  return {
    ...process.env,
    ...extraEnv,
    PATH: [
      runtimeBinDir,
      path.join(cwd, 'node_modules', '.bin'),
      process.env.PATH || ''
    ].filter(Boolean).join(path.delimiter)
  }
}
