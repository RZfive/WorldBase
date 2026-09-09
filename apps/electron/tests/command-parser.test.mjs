import assert from 'node:assert/strict'
import test from 'node:test'
import './register-ts-hooks.mjs'
import {
  scanCommandSegments,
  splitCommandSegments,
  stripRedirections,
  tokenizeCommand
} from '../src/main/ai-engine/agent/tools/command-parser.ts'

test('command scanner ignores shell syntax inside quotes and escaped text', () => {
  assert.deepEqual(scanCommandSegments('echo "a|b"'), {
    segments: ['echo "a|b"'],
    hasOperator: false
  })
  assert.deepEqual(scanCommandSegments("echo 'a;b'"), {
    segments: ["echo 'a;b'"],
    hasOperator: false
  })
  assert.deepEqual(scanCommandSegments('echo a\\|b'), {
    segments: ['echo a\\|b'],
    hasOperator: false
  })
})

test('command scanner recognizes separators, pipes, and pipe-stderr operators', () => {
  assert.deepEqual(scanCommandSegments('echo a && echo b || cat input |& tee log; echo done'), {
    segments: ['echo a', 'echo b', 'cat input', 'tee log', 'echo done'],
    hasOperator: true
  })
})

test('tokenizer keeps quoted words together and handles adjacent pieces', () => {
  assert.deepEqual(tokenizeCommand('echo "a|b"'), ['echo', 'a|b'])
  assert.deepEqual(tokenizeCommand("echo 'a;b'"), ['echo', 'a;b'])
  assert.deepEqual(tokenizeCommand('echo "> file"'), ['echo', '> file'])
  assert.deepEqual(tokenizeCommand('echo a"b"c'), ['echo', 'abc'])
  assert.deepEqual(tokenizeCommand('echo 123'), ['echo', '123'])
  assert.deepEqual(tokenizeCommand(String.raw`echo a\ b`), ['echo', 'a b'])
  assert.deepEqual(tokenizeCommand('echo trailing' + '\\'), ['echo', 'trailing\\'])
})

test('tokenizer and segment splitter reject unterminated quotes', () => {
  assert.throws(() => tokenizeCommand('echo "unterminated'), /Unterminated quoted string/)
  assert.throws(() => splitCommandSegments('echo > "unterminated'), /Unterminated quoted string/)
})

test('redirection stripping is quote-aware and preserves numeric arguments', () => {
  assert.equal(
    stripRedirections('npm run build 2>&1 && echo done > output.txt'),
    'npm run build   && echo done'
  )
  assert.equal(stripRedirections('echo 123'), 'echo 123')
  assert.equal(stripRedirections('echo "> file"'), 'echo "> file"')
  assert.equal(stripRedirections("echo 'a;b' > \"file name\""), "echo 'a;b'")
  assert.equal(stripRedirections('2>&1'), '')
  assert.equal(stripRedirections('>&2'), '')
  assert.equal(stripRedirections('0<&1'), '')
  assert.equal(stripRedirections('> "file name"'), '')
})

test('splitCommandSegments removes redirections without splitting quoted content', () => {
  assert.deepEqual(
    splitCommandSegments('echo "a|b" 2>&1 && echo "> file" > "file name"'),
    ['echo "a|b"', 'echo "> file"']
  )
})
