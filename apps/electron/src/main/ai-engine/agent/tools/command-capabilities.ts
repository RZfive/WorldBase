// Base commands run_project_command accepts as a SINGLE command (no shell
// operators). This is a curated, dev-loop-oriented set: package managers and
// runtimes, the common type-check / lint / format / test runners, plus a few
// read-only shell utilities as a fallback. It is a guardrail against obvious
// footguns, not a security boundary — node/npx can already run arbitrary code,
// so the real boundary is the per-project working directory the command runs in.
export const PROJECT_COMMAND_WHITELIST = [
  // package managers & JS/TS runtimes
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'tsx',
  // version control (subcommands further restricted to read-only ones)
  'git',
  // type-check / lint / format / test runners
  'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'playwright',
  // read-only shell utilities (dedicated tools are preferred; allowed as fallback)
  'echo', 'cat', 'ls', 'pwd', 'which', 'head', 'tail', 'wc',
  'find', 'grep', 'sort', 'uniq', 'env', 'printenv', 'true', 'date'
]

export const LOCAL_COMMAND_DISCOVERY_CANDIDATES = [
  'node', 'npm', 'npx', 'git',
  'python', 'python3', 'pip', 'pip3',
  'bash', 'sh', 'zsh',
  'pwsh', 'powershell', 'cmd',
  'ls', 'cat', 'grep', 'find', 'head', 'tail', 'wc', 'echo', 'pwd',
  'curl', 'wget'
]

/**
 * Patterns that are ALWAYS rejected — even in developer command mode — because
 * they are destructive, exfiltrating, or escalate privileges. They are matched
 * against the full raw command string as a defense-in-depth guardrail on top of
 * the per-segment whitelist (which already blocks bases like rm/sudo/curl).
 */
export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  // Recursive force-delete targeting a root / home / system path.
  /\brm\b[^|;&]*\s-[a-z]*(?:rf|fr|r[a-z]*f|f[a-z]*r)[a-z]*\b[^|;&]*\s(?:\/(?:\s|$|\*)|~|\$HOME|\/(?:etc|usr|bin|sbin|var|lib|opt|boot|dev|System|Library|Applications|Users)\b)/i,
  // Filesystem / disk destroyers.
  /\b(?:mkfs|fdisk|mkswap)\b/i,
  /\bdd\b[^|;&]*\bif=/i,
  // Privilege escalation.
  /\b(?:sudo|doas)\b/i,
  // Classic fork bomb.
  /:\(\)\s*\{[^}]*\}\s*;\s*:/,
  // Pipe a network download straight into a shell / interpreter.
  /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|python|python3|node)\b/i,
  // Redirect into a raw device or system path.
  />\s*\/dev\/(?:sd|hd|disk|nvme)/i,
  // Power / mass-process control.
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /\bkill\s+-9?\s*-1\b/,
  // Recursive permission/ownership change rooted at the filesystem root.
  /\bch(?:mod|own)\b[^|;&]*\s-R\b[^|;&]*\s\//i,
  // Overwrite shell startup files or ssh material.
  /(?:>|>>)\s*~?\/?\.(?:bashrc|zshrc|profile|bash_profile|ssh\/)/i
]

/**
 * Developer command mode lets run_project_command chain whitelisted commands
 * with shell operators (&&, ||, |, ;, redirects). It is OFF by default so the
 * tool stays tightened for normal users; set THE_WORLD_DEV_COMMANDS=1 (or
 * true/yes) to opt in. The dangerous-pattern blacklist still applies.
 */
export function isDeveloperCommandModeEnabled (): boolean {
  const flag = (process.env.THE_WORLD_DEV_COMMANDS || '').trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on'
}
