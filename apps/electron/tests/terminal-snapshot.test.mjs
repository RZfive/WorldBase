import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildTerminalSnapshot,
  normalizeTerminalText,
  PromptEolMarkFilter,
  stripAnsiEscapes,
  stripPromptEolMarks,
  tailClip,
  tailLines
} from '../electron/main-process/terminal/terminal-ansi.ts'

// Byte-for-byte chunk captured from the user's zsh (PROMPT_SP partial-line
// mark before every starship-style prompt).
const REAL_MARK = '\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m' + ' '.repeat(79) + '\r \r\r' +
  '\u001b[0m\u001b[27m\u001b[24m\u001b[J\r\n'

test('stripAnsiEscapes removes CSI, OSC and two-char escapes but keeps text', () => {
  const input = '\u001B[2J\u001B[1;32mok\u001B[0m \u001B]0;title\u0007done \u001B(M end'
  assert.equal(stripAnsiEscapes(input), 'ok done  end')
  assert.equal(stripAnsiEscapes('plain'), 'plain')
  assert.equal(stripAnsiEscapes(''), '')
})

test('normalizeTerminalText folds carriage returns and drops control chars', () => {
  // \r without \n (progress overwrite) becomes a newline; backspace is dropped.
  assert.equal(normalizeTerminalText('a\rb\u0008c'), 'a\nbc')
  assert.equal(normalizeTerminalText('x\r\ny'), 'x\ny')
  assert.equal(normalizeTerminalText('\u001B[31merr\u001B[0m'), 'err')
})

test('tailClip keeps the tail and breaks at a line boundary', () => {
  const text = 'first\nsecond\nthird'
  const clipped = tailClip(text, 12)
  assert.equal(clipped.truncated, true)
  // The tail window starts inside "second"; clipping cuts up to that newline.
  assert.equal(clipped.text, 'third')
  const untouched = tailClip(text, 100)
  assert.deepEqual(untouched, { text, truncated: false })
})

test('tailLines keeps the last N non-empty lines', () => {
  assert.equal(tailLines('a\nb\nc\nd\n', 2), 'c\nd')
  assert.equal(tailLines('a\nb', 0), '')
  assert.equal(tailLines('a\nb\nc', 10), 'a\nb\nc')
})

test('buildTerminalSnapshot cleans, filters by lines and clamps by chars', () => {
  const raw = '\u001B[32m$\u001B[0m npm install\ninstalled 1 package\n\n\ndone\n'
  const byLines = buildTerminalSnapshot(raw, { lines: 2 })
  assert.equal(byLines.text, 'installed 1 package\ndone')
  assert.equal(byLines.truncated, false)

  const byChars = buildTerminalSnapshot('aaaa\nbbbbbbbbbbbbbbbb', { maxChars: 8 })
  assert.equal(byChars.text, 'bbbbbbbb')
  assert.equal(byChars.truncated, true)
})

test('stripPromptEolMarks collapses the zsh partial-line mark to a newline', () => {
  const withMark = `output line\r\n${REAL_MARK}\u001b[1;38;5;33m~\u001b[0m \r\n\u001b[1;32m❯\u001b[0m `
  const cleaned = stripPromptEolMarks(withMark)
  assert.ok(!cleaned.includes('[7m%'))
  // The mark line collapses to a single line break (a blank line before the prompt).
  assert.equal(cleaned, 'output line\r\n\n\u001b[1;38;5;33m~\u001b[0m \r\n\u001b[1;32m❯\u001b[0m ')
  // Untouched when no mark is present.
  assert.equal(stripPromptEolMarks('plain\r\ntext'), 'plain\r\ntext')
})

test('PromptEolMarkFilter handles marks split across data events', () => {
  const filter = new PromptEolMarkFilter()
  const stream = `before\r\n${REAL_MARK}after-prompt`

  const first = filter.push(stream.slice(0, stream.length - 60))
  const second = filter.push(stream.slice(stream.length - 60))

  assert.equal(first + second, 'before\r\n\nafter-prompt')
  assert.ok(!(first + second).includes('[7m%'))
})

test('buildTerminalSnapshot drops the partial-line mark for AI reads', () => {
  const snapshot = buildTerminalSnapshot(`${REAL_MARK}~ ❯ pwd\r\n/Users/tanyafang\r\n${REAL_MARK}`)
  assert.ok(!snapshot.text.includes('%\n'))
  assert.ok(snapshot.text.includes('/Users/tanyafang'))
})
