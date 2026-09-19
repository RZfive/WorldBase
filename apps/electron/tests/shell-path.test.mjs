import assert from 'node:assert/strict'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { mergePathEntries, parseLoginShellPath } from '../src/main/system-capabilities/shell-path.ts'

test('parseLoginShellPath ignores rc-file banners around the marker', () => {
  const stdout = 'Welcome!\n__WORLDBASE_PATH__/opt/homebrew/bin:/usr/bin__WORLDBASE_PATH__\ntrailing noise'
  assert.equal(parseLoginShellPath(stdout), '/opt/homebrew/bin:/usr/bin')
})

test('parseLoginShellPath returns null without a complete marker pair or with an empty PATH', () => {
  assert.equal(parseLoginShellPath(''), null)
  assert.equal(parseLoginShellPath('__WORLDBASE_PATH__/usr/bin'), null)
  assert.equal(parseLoginShellPath('__WORLDBASE_PATH__   __WORLDBASE_PATH__'), null)
})

test('mergePathEntries keeps the current order and appends new login-shell entries once', () => {
  const merged = mergePathEntries('/tmp/runtime:/usr/bin', '/opt/homebrew/bin:/usr/bin:/Users/me/n/bin:/opt/homebrew/bin', ':')
  assert.equal(merged, '/tmp/runtime:/usr/bin:/opt/homebrew/bin:/Users/me/n/bin')
})

test('mergePathEntries handles a missing current PATH and drops empty segments', () => {
  assert.equal(mergePathEntries(undefined, ':/usr/local/bin::/usr/bin', ':'), '/usr/local/bin:/usr/bin')
})
