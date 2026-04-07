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

function resolveBundledPnpmCliPath (binName: 'pnpm' | 'pnpx'): string {
  const packagedPath = path.join(process.resourcesPath, 'app.asar', 'node_modules', 'pnpm', 'bin', `${binName}.cjs`)
  if (existsSync(packagedPath)) {
    return packagedPath
  }

  return require.resolve(`pnpm/bin/${binName}.cjs`)
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
