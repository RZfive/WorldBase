import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BYTECODE_FLAG = '--bytecode'
const isBytecodeBuild = process.argv.includes(BYTECODE_FLAG)
const workspaceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const outputDir = path.join(workspaceRoot, 'dist-electron/electron')
const preloadLoaderPath = path.join(outputDir, 'preload.js')

await mkdir(outputDir, { recursive: true })
await Promise.all([
  rm(preloadLoaderPath, { force: true }),
  rm(path.join(outputDir, 'preload.bytecode.cjs'), { force: true }),
  rm(path.join(outputDir, 'preload.jsc'), { force: true })
])

await build({
  entryPoints: [path.join(workspaceRoot, 'electron/preload.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: preloadLoaderPath,
  external: ['electron'],
  target: ['node22'],
  treeShaking: true,
  minify: true,
  legalComments: 'none',
  sourcemap: false
})

console.log(
  isBytecodeBuild
    ? '[build-preload] Preload script bundled as minified CommonJS (kept as JS for Electron preload stability)'
    : '[build-preload] Preload script bundled as minified CommonJS'
)
