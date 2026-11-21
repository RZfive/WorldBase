import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildHarness, missingBuildOutputPackages } from '../scripts/build-harness.mjs'

const missingOutputs = [
  'error: couldn\'t read `/repo/target/release/build/libsqlite3-sys-3422d1501d7e5c2c/out/bindgen.rs`: No such file or directory (os error 2)',
  'error: couldn\'t read `/repo/target/release/build/tree-sitter-f7b3a2f90e3f6bd3/out/stdlib-symbols.txt`: No such file or directory (os error 2)'
].join('\n')

async function fixture (context) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'worldbase-harness-build-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const electronDir = path.join(repoRoot, 'apps', 'electron')
  const outputDir = path.join(electronDir, 'resources', 'harness')
  const executable = process.platform === 'win32' ? 'worldbase-app-server.exe' : 'worldbase-app-server'
  const bundled = path.join(outputDir, executable)
  const customBuild = path.join(repoRoot, 'custom-cargo-target', executable)
  await mkdir(outputDir, { recursive: true })
  await mkdir(path.dirname(customBuild), { recursive: true })
  await writeFile(bundled, 'previous executable')
  await writeFile(customBuild, 'rebuilt executable')
  return { repoRoot, electronDir, bundled, customBuild }
}

test('missing build outputs identify only affected Cargo packages', () => {
  assert.deepEqual(missingBuildOutputPackages(missingOutputs), ['libsqlite3-sys', 'tree-sitter'])
  assert.deepEqual(missingBuildOutputPackages(missingOutputs + '\n' + missingOutputs), ['libsqlite3-sys', 'tree-sitter'])
  assert.deepEqual(missingBuildOutputPackages('error: couldn\'t read `/repo/src/main.rs`: No such file or directory (os error 2)'), [])
  assert.deepEqual(missingBuildOutputPackages('error[E0308]: mismatched types'), [])
})

test('the harness build repairs generated outputs once and copies the Cargo-reported artifact', async context => {
  const options = await fixture(context)
  const calls = []
  await buildHarness({
    ...options,
    runCargo: async args => {
      calls.push(args)
      if (calls.length === 1) throw Object.assign(new Error('Cargo failed'), { stderr: missingOutputs })
      if (args[0] === 'clean') {
        assert.equal(await readFile(options.bundled, 'utf8'), 'previous executable')
        return {}
      }
      return { executable: options.customBuild }
    }
  })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[1], ['clean', '--manifest-path', path.join(options.repoRoot, 'harness-rs', 'Cargo.toml'), '--release', '-p', 'libsqlite3-sys', '-p', 'tree-sitter'])
  assert.deepEqual(calls[2], calls[0])
  assert.equal(await readFile(options.bundled, 'utf8'), 'rebuilt executable')
})

test('source failures preserve the bundled harness and are not retried', async context => {
  const options = await fixture(context)
  const error = Object.assign(new Error('Compile failed'), { stderr: 'error[E0308]: mismatched types' })
  let attempts = 0
  await assert.rejects(buildHarness({
    ...options,
    runCargo: async () => { attempts++; throw error }
  }), failure => failure === error)
  assert.equal(attempts, 1)
  assert.equal(await readFile(options.bundled, 'utf8'), 'previous executable')
})

test('an unsuccessful cache repair does not retry indefinitely or remove the working harness', async context => {
  const options = await fixture(context)
  const error = Object.assign(new Error('Cargo failed'), { stderr: missingOutputs })
  let attempts = 0
  await assert.rejects(buildHarness({
    ...options,
    runCargo: async args => {
      attempts++
      if (args[0] === 'clean') return {}
      throw error
    }
  }), failure => failure === error)
  assert.equal(attempts, 3)
  assert.equal(await readFile(options.bundled, 'utf8'), 'previous executable')
})
