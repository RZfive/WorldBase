/**
 * Small, policy-oriented shell parser shared by the Electron command tools.
 *
 * This is deliberately not a shell implementation.  It only understands the
 * quoting, escaping, separators, and redirection syntax needed to validate a
 * command before it is passed to `spawn(..., { shell: true })`.  Keeping this
 * logic in one module prevents run_project_command and run_workspace_command
 * from drifting apart (and mirrors the quote-aware Rust harness parser).
 */

export interface CommandScanResult {
  segments: string[]
  hasOperator: boolean
}

/**
 * Split a command at unquoted `;`, `&`, and `|` operators.
 *
 * `<` and `>` are marked as operators but are not separators.  Redirections
 * are removed by splitCommandSegments before validation; retaining them here
 * lets callers detect shell syntax in normal (non-developer) mode.
 */
export function scanCommandSegments (command: string): CommandScanResult {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  let hasOperator = false
  const chars = Array.from(command)

  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index]

    if (escaped) {
      current += character
      escaped = false
      continue
    }

    if (quote !== null) {
      current += character
      if (quote === '"' && character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }

    if (character === '\\') {
      current += character
      escaped = true
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      current += character
      continue
    }

    if (character === '<' || character === '>') {
      hasOperator = true
      current += character
      continue
    }

    if (character === ';' || character === '&' || character === '|') {
      hasOperator = true
      if (current.trim()) {
        segments.push(current.trim())
      }
      current = ''

      // Treat &&, ||, and |& as one separator.  The policy only needs the
      // command segments, not the exact operator used between them.
      const next = chars[index + 1]
      if ((character === '&' && next === '&') ||
          (character === '|' && (next === '|' || next === '&'))) {
        index += 1
      }
      continue
    }

    current += character
  }

  if (quote !== null) {
    throw new Error('Unterminated quoted string in command.')
  }

  if (current.trim()) {
    segments.push(current.trim())
  }

  return { segments, hasOperator }
}

/**
 * Remove shell redirection clauses while preserving quoted `<` / `>` text.
 * Ordinary numeric arguments (for example `echo 123`) are copied verbatim.
 */
export function stripRedirections (text: string): string {
  const chars = Array.from(text)
  let output = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  let index = 0

  while (index < chars.length) {
    const character = chars[index]

    if (escaped) {
      output += character
      escaped = false
      index += 1
      continue
    }

    if (quote !== null) {
      output += character
      if (quote === '"' && character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      index += 1
      continue
    }

    if (character === '\\') {
      output += character
      escaped = true
      index += 1
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      output += character
      index += 1
      continue
    }

    const digitStart = index
    while (index < chars.length && /^[0-9]$/.test(chars[index])) {
      index += 1
    }

    if (index < chars.length && (chars[index] === '<' || chars[index] === '>')) {
      const operator = chars[index]
      index += 1
      while (index < chars.length && chars[index] === operator) {
        index += 1
      }

      // Descriptor duplication (`2>&1`, `>&2`, `0<&1`) has no file word to
      // consume, only an optional `-` or descriptor after `&`.
      while (index < chars.length && /\s/.test(chars[index])) {
        index += 1
      }
      if (index < chars.length && chars[index] === '&') {
        index += 1
        if (index < chars.length && chars[index] === '-') {
          index += 1
        }
        while (index < chars.length && /^[0-9]$/.test(chars[index])) {
          index += 1
        }
      } else {
        // Consume one shell word as the redirection target.  Quoted paths and
        // escaped spaces stay within the target; a following command
        // separator remains available to the segment scanner.
        let targetQuote: '"' | "'" | null = null
        let targetEscaped = false
        while (index < chars.length) {
          const target = chars[index]
          if (targetEscaped) {
            targetEscaped = false
            index += 1
            continue
          }
          if (targetQuote !== null) {
            if (targetQuote === '"' && target === '\\') {
              targetEscaped = true
            } else if (target === targetQuote) {
              targetQuote = null
            }
            index += 1
            continue
          }
          if (target === '\\') {
            targetEscaped = true
            index += 1
            continue
          }
          if (target === '"' || target === "'") {
            targetQuote = target
            index += 1
            continue
          }
          if (/\s/.test(target) || target === ';' || target === '&' || target === '|') {
            break
          }
          index += 1
        }
      }

      // Keep one separator so adjacent words do not accidentally join.
      output += ' '
      continue
    }

    // The digits did not introduce a redirection; copy them and the current
    // non-digit character (if any) verbatim.
    output += chars.slice(digitStart, index).join('')
    if (index < chars.length) {
      output += chars[index]
      index += 1
    }
  }

  return output.trim()
}

/**
 * Split a developer-mode command after removing redirections.
 */
export function splitCommandSegments (command: string): string[] {
  // Validate quoting before stripping targets.  This also catches an
  // unterminated quoted redirection target instead of silently accepting it.
  scanCommandSegments(command)
  return scanCommandSegments(stripRedirections(command)).segments
}

/**
 * Tokenize one command segment.  Quotes are removed, escaped characters are
 * decoded, and adjacent quoted/unquoted pieces form one token (`a"b"c`).
 */
export function tokenizeCommand (command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let tokenStarted = false
  let escaped = false

  for (const character of Array.from(command)) {
    if (escaped) {
      current += character
      tokenStarted = true
      escaped = false
      continue
    }

    if (quote !== null) {
      if (quote === '"' && character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      } else {
        current += character
      }
      tokenStarted = true
      continue
    }

    if (character === '\\') {
      escaped = true
      tokenStarted = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      tokenStarted = true
      continue
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(current)
        current = ''
        tokenStarted = false
      }
      continue
    }

    current += character
    tokenStarted = true
  }

  if (quote !== null) {
    throw new Error('Unterminated quoted string in command.')
  }
  if (escaped) {
    // Match the Rust harness: a trailing backslash is retained as a literal
    // character rather than disappearing from the policy token.
    current += '\\'
  }
  if (tokenStarted) {
    tokens.push(current)
  }
  return tokens
}

