/**
 * Pure helpers for cleaning PTY output before it is shown to the model or
 * persisted in snapshots. Kept side-effect free so they are unit-testable
 * from node:test without an Electron runtime.
 */

/** Strips ANSI/VT escape sequences (CSI, OSC, and single-char escapes). */
export function stripAnsiEscapes (input: string): string {
  if (!input) return ''
  // eslint-disable-next-line no-control-regex
  const OSC = '\u001B]'
  // eslint-disable-next-line no-control-regex
  const BEL = '\u0007'
  // eslint-disable-next-line no-control-regex
  const ESC = '\u001B'
  let out = ''
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === ESC) {
      const next = input[i + 1]
      if (next === '[') {
        // CSI sequence: ESC [ ... final-byte (letters/@/`)
        i += 2
        while (i < input.length && !/[A-Za-z@`]/.test(input[i])) i += 1
        i += 1
        continue
      }
      if (next === ']') {
        // OSC sequence: ESC ] ... (BEL or ESC \)
        i += 2
        while (i < input.length) {
          if (input[i] === BEL) { i += 1; break }
          if (input[i] === ESC && input[i + 1] === '\\') { i += 2; break }
          i += 1
        }
        continue
      }
      if (next !== undefined) {
        // Charset/attribute escapes are three characters: ESC ( X, ESC ) X, ESC # X, ESC % X
        if (['(', ')', '#', '%'].includes(next) && input[i + 2] !== undefined) {
          i += 3
          continue
        }
        // Two-char escape (e.g. ESC M, ESC 7)
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (ch === OSC) {
      // Bare OSC start (defensive)
      i += 1
      while (i < input.length && input[i] !== BEL) i += 1
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * zsh PROMPT_SP partial-line mark: before every prompt the user's shell emits
 * an inverse-video `%` plus padding spaces and an erase-display. Rendered in
 * the terminal (and in AI snapshots) it reads as a stray standalone `%` line,
 * so we strip the whole chunk and keep only its line break.
 */
const PROMPT_EOL_MARK_PATTERN = /\x1b\[1m\x1b\[7m%(?:\x1b\[[0-9;]*m)*[ ]*(?:\r ?)+\x1b\[0m\x1b\[27m\x1b\[24m\x1b\[J\r\n/g

const PROMPT_EOL_MARK_HEAD = '\u001B[1m\u001B[7m%'
/** Marks longer than this cannot be real (they scale with columns, ~hundreds). */
const PROMPT_EOL_MARK_MAX_LENGTH = 4096

export function stripPromptEolMarks (input: string): string {
  if (!input.includes(PROMPT_EOL_MARK_HEAD)) return input
  return input.replace(PROMPT_EOL_MARK_PATTERN, '\n')
}

/**
 * Streaming variant for the live renderer pipe: mark chunks can straddle
 * PTY data events, so a tail that may still complete into a mark is held
 * back until the next chunk resolves it (or grows past any plausible mark).
 */
export class PromptEolMarkFilter {
  private pending = ''

  push (chunk: string): string {
    let buffer = this.pending + chunk
    buffer = stripPromptEolMarks(buffer)

    let emitUpTo = buffer.length
    const headIndex = buffer.lastIndexOf(PROMPT_EOL_MARK_HEAD)
    if (
      headIndex !== -1
      && buffer.indexOf('\n', headIndex) === -1
      && buffer.length - headIndex < PROMPT_EOL_MARK_MAX_LENGTH
    ) {
      emitUpTo = headIndex
    }

    const output = buffer.slice(0, emitUpTo)
    this.pending = buffer.slice(emitUpTo)
    return output
  }
}

/** Normalizes control characters that are noise in prompts (\r from progress lines etc.). */
export function normalizeTerminalText (input: string): string {
  return stripAnsiEscapes(input)
    .replace(/\r\n/g, '\n')
    .replace(/\r(?!\n)/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

/** Keeps only the last `maxChars` characters, breaking at a line boundary when possible. */
export function tailClip (input: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0 || input.length <= maxChars) return { text: input, truncated: false }
  const slice = input.slice(input.length - maxChars)
  const firstNewline = slice.indexOf('\n')
  const text = firstNewline > 0 ? slice.slice(firstNewline + 1) : slice
  return { text, truncated: true }
}

/** Keeps only the last `lines` non-empty logical lines. */
export function tailLines (input: string, lines: number): string {
  if (lines <= 0) return ''
  const all = input.split('\n').filter(line => line.trim() !== '')
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

export interface TerminalSnapshotOptions {
  lines?: number
  maxChars?: number
}

export interface TerminalTextSnapshot {
  text: string
  truncated: boolean
}

/** Cleans raw PTY scrollback into a prompt-safe tail snapshot. */
export function buildTerminalSnapshot (raw: string, options: TerminalSnapshotOptions = {}): TerminalTextSnapshot {
  const cleaned = normalizeTerminalText(stripPromptEolMarks(raw))
  const maxChars = options.maxChars && options.maxChars > 0 ? options.maxChars : 12000
  let text = cleaned
  if (options.lines && options.lines > 0) {
    text = tailLines(text, options.lines)
  }
  const clipped = tailClip(text, maxChars)
  return { text: clipped.text, truncated: clipped.truncated }
}
