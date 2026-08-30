import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron')
const testFiles = process.argv.slice(2)

if (testFiles.length === 0) {
  throw new Error('Expected at least one test file.')
}

const result = spawnSync(electron, [
  '--experimental-strip-types',
  '--import', './tests/register-ts-hooks.mjs',
  '--test',
  ...testFiles
], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1'
  },
  stdio: 'inherit'
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
