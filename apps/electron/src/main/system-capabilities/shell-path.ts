import { execFile } from 'node:child_process'
import path from 'node:path'

/**
 * Desktop launchers (Finder, Dock, Linux `.desktop` files) start Electron with
 * a minimal PATH such as `/usr/bin:/bin:/usr/sbin:/sbin`. Anything installed
 * by Homebrew, nvm, volta, n, uv, or cargo is missing, so a stdio MCP server
 * configured as a bare `npx` / `uvx` / `node` command fails with
 * "spawn npx ENOENT" (TS harness) or "spawn mcp server npx" (Rust harness)
 * even though the same command runs fine from a terminal.
 *
 * This module asks the user's login shell for its PATH once and merges the
 * result into `process.env.PATH`. Child processes (the Rust app-server, MCP
 * servers, project runtimes) inherit the merged value.
 */

const PATH_MARKER = '__WORLDBASE_PATH__'
const PROBE_TIMEOUT_MS = 5000

let loginShellPathPromise: Promise<string | null> | null = null

/** Extract the PATH between markers; rc files may print banners around it. */
export function parseLoginShellPath (stdout: string): string | null {
  const start = stdout.indexOf(PATH_MARKER)
  if (start < 0) return null
  const valueStart = start + PATH_MARKER.length
  const end = stdout.indexOf(PATH_MARKER, valueStart)
  if (end < 0) return null
  const value = stdout.slice(valueStart, end).trim()
  return value ? value : null
}

/**
 * Keep the current PATH order and append every login-shell directory that is
 * not already present, so explicit overrides stay ahead of shell defaults.
 */
export function mergePathEntries (current: string | undefined, loginShellPath: string, delimiter: string = path.delimiter): string {
  const entries: string[] = []
  const seen = new Set<string>()
  for (const source of [current || '', loginShellPath]) {
    for (const entry of source.split(delimiter)) {
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      entries.push(entry)
    }
  }
  return entries.join(delimiter)
}

function resolveShell (): string {
  const shell = (process.env.SHELL || '').trim()
  return shell || '/bin/sh'
}

function buildProbeScript (shell: string): string {
  if (path.basename(shell) === 'fish') {
    return `printf '${PATH_MARKER}%s${PATH_MARKER}' (string join ':' $PATH)`
  }
  return `printf '${PATH_MARKER}%s${PATH_MARKER}' "$PATH"`
}

/** Resolve the login shell's PATH. Cached per process, including failures. */
export function getLoginShellPath (): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null)
  if (!loginShellPathPromise) {
    loginShellPathPromise = new Promise<string | null>((resolve) => {
      const shell = resolveShell()
      execFile(shell, ['-ilc', buildProbeScript(shell)], {
        timeout: PROBE_TIMEOUT_MS,
        encoding: 'utf8',
        windowsHide: true
      }, (error, stdout) => {
        const resolved = parseLoginShellPath(typeof stdout === 'string' ? stdout : '')
        if (!resolved) {
          console.warn(`[main:shell-path] Login shell PATH probe via ${shell} failed:`, error?.message || 'no PATH in output')
        }
        resolve(resolved)
      })
    })
  }
  return loginShellPathPromise
}

/**
 * Merge the login shell PATH into `process.env.PATH`. Safe to call more than
 * once; returns the PATH in effect afterwards.
 */
export async function ensureLoginShellPath (): Promise<string> {
  const loginPath = await getLoginShellPath()
  if (!loginPath) return process.env.PATH || ''
  const merged = mergePathEntries(process.env.PATH, loginPath)
  if (merged !== process.env.PATH) {
    process.env.PATH = merged
  }
  return merged
}
