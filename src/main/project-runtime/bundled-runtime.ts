import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'

let runtimeBinDirPromise: Promise<string> | null = null

function resolveBundledNodePath (): string {
  return process.execPath
}

function getOriginalPath (): string {
  return process.env.PATH || ''
}

function resolveSystemCommandPath (commandNames: string[]): string | null {
  const pathEntries = getOriginalPath().split(path.delimiter).filter(Boolean)

  for (const dir of pathEntries) {
    for (const commandName of commandNames) {
      const candidatePath = path.join(dir, commandName)
      if (existsSync(candidatePath)) {
        return candidatePath
      }
    }
  }

  return null
}

function shEscape (value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function batchEscape (value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function createUnixProxyScript (targetPath: string, runtimeBinDir: string): string {
  return [
    '#!/bin/sh',
    `ORIGINAL_PATH=${shEscape(getOriginalPath())}`,
    `export PATH=${shEscape(`${runtimeBinDir}${path.delimiter}`)}$ORIGINAL_PATH`,
    `exec ${shEscape(targetPath)} "$@"`
  ].join('\n')
}

function createWindowsProxyScript (targetPath: string, runtimeBinDir: string): string {
  return [
    '@echo off',
    'setlocal',
    `set "ORIGINAL_PATH=${getOriginalPath().replace(/"/g, '""')}"`,
    `set "PATH=${runtimeBinDir};%ORIGINAL_PATH%"`,
    `call ${batchEscape(targetPath)} %*`
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
      const npmPath = resolveSystemCommandPath(process.platform === 'win32'
        ? ['npm.cmd', 'npm.exe', 'npm']
        : ['npm'])
      const npxPath = resolveSystemCommandPath(process.platform === 'win32'
        ? ['npx.cmd', 'npx.exe', 'npx']
        : ['npx'])
      const hash = crypto.createHash('sha256')
        .update(`${nodePath}\n${npmPath || ''}\n${npxPath || ''}`)
        .digest('hex')
        .slice(0, 12)
      const runtimeBinDir = path.join(os.tmpdir(), 'the-world-runtime', hash)

      await fs.mkdir(runtimeBinDir, { recursive: true })

      const unixNode = [
        '#!/bin/sh',
        `exec env ELECTRON_RUN_AS_NODE=1 ${shEscape(nodePath)} "$@"`
      ].join('\n')

      const unixProxyScripts = [
        npmPath ? createUnixProxyScript(npmPath, runtimeBinDir) : null,
        npxPath ? createUnixProxyScript(npxPath, runtimeBinDir) : null
      ]

      const windowsNode = [
        '@echo off',
        'setlocal',
        'set ELECTRON_RUN_AS_NODE=1',
        `"${nodePath}" %*`
      ].join('\r\n')

      const windowsProxyScripts = [
        npmPath ? createWindowsProxyScript(npmPath, runtimeBinDir) : null,
        npxPath ? createWindowsProxyScript(npxPath, runtimeBinDir) : null
      ]

      const [unixNpmScript, unixNpxScript] = unixProxyScripts
      const [windowsNpmScript, windowsNpxScript] = windowsProxyScripts

      const filesToWrite: Array<Promise<void>> = [
        writeExecutableFile(path.join(runtimeBinDir, 'node'), unixNode),
        writeExecutableFile(path.join(runtimeBinDir, 'node.cmd'), windowsNode)
      ]

      if (unixNpmScript) {
        filesToWrite.push(writeExecutableFile(path.join(runtimeBinDir, 'npm'), unixNpmScript))
      }
      if (unixNpxScript) {
        filesToWrite.push(writeExecutableFile(path.join(runtimeBinDir, 'npx'), unixNpxScript))
      }
      if (windowsNpmScript) {
        filesToWrite.push(writeExecutableFile(path.join(runtimeBinDir, 'npm.cmd'), windowsNpmScript))
      }
      if (windowsNpxScript) {
        filesToWrite.push(writeExecutableFile(path.join(runtimeBinDir, 'npx.cmd'), windowsNpxScript))
      }

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
