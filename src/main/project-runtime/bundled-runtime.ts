import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

let runtimeBinDirPromise: Promise<string> | null = null

const moduleRequire = createRequire(import.meta.url)

function resolveBundledNodePath (): string {
  return process.execPath
}

/**
 * Resolve the absolute path to the pnpm CLI bundled inside the app's own
 * node_modules. Works in dev (node_modules next to the repo root) and in a
 * packaged build (inside app.asar — Electron patches `require` to read it).
 *
 * pnpm ships as a `.cjs` entry point; we never shell out to an external
 * `npm`/`npx`, so the packaged app does not depend on the host having any
 * Node toolchain installed.
 */
function resolveBundledPnpmPath (): string {
  // `require.resolve('pnpm')` follows the package "main" field, which points
  // at bin/pnpm.cjs. On some pnpm versions "exports" restricts subpaths, so
  // resolve the package root via its package.json and append the bin path.
  const packageJsonPath = moduleRequire.resolve('pnpm')
  let packageRoot = path.dirname(packageJsonPath)
  // pnpm ships native addons (reflink.*.node). Electron auto-unpacks the whole
  // package to app.asar.unpacked so they load, but `require.resolve` returns
  // the asar virtual path. Rewrite it to the unpacked on-disk path, otherwise
  // spawning `node <asar-path>/pnpm.cjs` fails when pnpm loads its .node files.
  const asarMatch = packageRoot.match(/^(.*)\.asar(.*)$/)
  if (asarMatch) {
    packageRoot = path.join(asarMatch[1] + '.asar.unpacked', asarMatch[2])
  }
  const pnpmBinPath = path.join(packageRoot, 'bin', 'pnpm.cjs')
  if (!existsSync(pnpmBinPath)) {
    throw new Error(`Bundled pnpm CLI not found at ${pnpmBinPath}`)
  }
  return pnpmBinPath
}

function getOriginalPath (): string {
  return process.env.PATH || ''
}

function shEscape (value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function batchEscape (value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function createUnixNodeScript (nodePath: string): string {
  return [
    '#!/bin/sh',
    `exec env ELECTRON_RUN_AS_NODE=1 ${shEscape(nodePath)} "$@"`
  ].join('\n')
}

/**
 * Unix proxy that runs a bundled .cjs CLI (pnpm) with the bundled node.
 * Adding ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave as plain node.
 */
function createUnixCliScript (nodePath: string, cliPath: string): string {
  return [
    '#!/bin/sh',
    `exec env ELECTRON_RUN_AS_NODE=1 ${shEscape(nodePath)} ${shEscape(cliPath)} "$@"`
  ].join('\n')
}

function createWindowsNodeScript (nodePath: string): string {
  return [
    '@echo off',
    'setlocal',
    'set ELECTRON_RUN_AS_NODE=1',
    `"${nodePath}" %*`
  ].join('\r\n')
}

function createWindowsCliScript (nodePath: string, cliPath: string): string {
  return [
    '@echo off',
    'setlocal',
    'set ELECTRON_RUN_AS_NODE=1',
    `"${nodePath}" "${cliPath}" %*`
  ].join('\r\n')
}

async function writeExecutableFile (filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, 'utf-8')
  await fs.chmod(filePath, 0o755)
}

async function ensureRuntimeBinDir (): Promise<string> {
  if (!runtimeBinDirPromise) {
    runtimeBinDirPromise = (async () => {
      const nodePath = resolveBundledNodePath()
      const pnpmPath = resolveBundledPnpmPath()
      const hash = crypto.createHash('sha256')
        .update(`${nodePath}\n${pnpmPath}`)
        .digest('hex')
        .slice(0, 12)
      const runtimeBinDir = path.join(os.tmpdir(), 'the-world-runtime', hash)

      await fs.mkdir(runtimeBinDir, { recursive: true })

      const isWindows = process.platform === 'win32'
      const nodeScript = isWindows
        ? createWindowsNodeScript(nodePath)
        : createUnixNodeScript(nodePath)
      const pnpmScript = isWindows
        ? createWindowsCliScript(nodePath, pnpmPath)
        : createUnixCliScript(nodePath, pnpmPath)

      // npm/npx are aliased to pnpm so any `npm run`/`npx` invocation inside a
      // child project is served by the bundled pnpm — no external Node needed.
      const filesToWrite: Array<Promise<void>> = [
        writeExecutableFile(path.join(runtimeBinDir, isWindows ? 'node.cmd' : 'node'), nodeScript),
        writeExecutableFile(path.join(runtimeBinDir, isWindows ? 'pnpm.cmd' : 'pnpm'), pnpmScript),
        writeExecutableFile(path.join(runtimeBinDir, isWindows ? 'npm.cmd' : 'npm'), pnpmScript),
        writeExecutableFile(path.join(runtimeBinDir, isWindows ? 'npx.cmd' : 'npx'), pnpmScript)
      ]

      await Promise.all(filesToWrite)

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
  const originalPath = getOriginalPath()

  return {
    ...process.env,
    ...extraEnv,
    PATH: [
      runtimeBinDir,
      path.join(cwd, 'node_modules', '.bin'),
      originalPath
    ].filter(Boolean).join(path.delimiter)
  }
}
