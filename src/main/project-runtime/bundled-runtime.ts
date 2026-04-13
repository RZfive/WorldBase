import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'

let runtimeBinDirPromise: Promise<string> | null = null
let chinaMirrorEnabledPromise: Promise<boolean> | null = null

const CHINA_NPM_REGISTRY = 'https://registry.npmmirror.com'
const CHINA_IP_LOOKUP_URLS = [
  'https://api.country.is/',
  'https://ipapi.co/json/'
]

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

function hasExplicitRegistryConfig (env: NodeJS.ProcessEnv): boolean {
  return [
    env.NPM_CONFIG_REGISTRY,
    env.npm_config_registry,
    process.env.NPM_CONFIG_REGISTRY,
    process.env.npm_config_registry
  ].some(value => typeof value === 'string' && value.trim().length > 0)
}

function readForcedChinaIpFlag (): boolean | null {
  const raw = process.env.THE_WORLD_FORCE_CHINA_IP
  if (!raw) return null
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function extractCountryCode (payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const record = payload as Record<string, unknown>
  const value = record.country ?? record.country_code ?? record.countryCode
  return typeof value === 'string' && value.trim()
    ? value.trim().toUpperCase()
    : null
}

async function isChinaIp (): Promise<boolean> {
  const forced = readForcedChinaIpFlag()
  if (forced != null) {
    return forced
  }

  if (!chinaMirrorEnabledPromise) {
    chinaMirrorEnabledPromise = (async () => {
      for (const url of CHINA_IP_LOOKUP_URLS) {
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(3000),
            headers: {
              accept: 'application/json'
            }
          })

          if (!response.ok) {
            continue
          }

          const countryCode = extractCountryCode(await response.json())
          if (countryCode === 'CN') {
            return true
          }
          if (countryCode) {
            return false
          }
        } catch {
          // Ignore detection failures and fall back to the default registry.
        }
      }

      return false
    })()
  }

  return chinaMirrorEnabledPromise
}

async function resolveRegistryEnv (env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (hasExplicitRegistryConfig(env)) {
    return {}
  }

  // Allow deployments to force a specific npm mirror without disabling the
  // automatic China-IP fallback logic globally.
  const explicitRegistry = process.env.THE_WORLD_NPM_REGISTRY?.trim()
  const registry = explicitRegistry || (await isChinaIp() ? CHINA_NPM_REGISTRY : '')

  if (!registry) {
    return {}
  }

  return {
    NPM_CONFIG_REGISTRY: registry,
    npm_config_registry: registry
  }
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
  const registryEnv = await resolveRegistryEnv(extraEnv)

  return {
    ...process.env,
    ...registryEnv,
    ...extraEnv,
    THE_WORLD_ORIGINAL_PATH: originalPath,
    PATH: [
      runtimeBinDir,
      path.join(cwd, 'node_modules', '.bin'),
      originalPath
    ].filter(Boolean).join(path.delimiter)
  }
}
