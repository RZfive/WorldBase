import { build } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bytenode from 'bytenode'

const BYTECODE_FLAG = '--bytecode'
const isBytecodeBuild = process.argv.includes(BYTECODE_FLAG)
const workspaceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const outputDir = path.join(workspaceRoot, 'dist-electron/electron')
const mainModulePath = path.join(outputDir, 'main.js')
const mainLoaderPath = path.join(outputDir, 'main.cjs')
const mainBytecodeSourcePath = path.join(outputDir, 'main.bytecode.cjs')
const mainBytecodePath = path.join(outputDir, 'main.jsc')

await mkdir(outputDir, { recursive: true })
await Promise.all([
  rm(mainLoaderPath, { force: true }),
  rm(mainBytecodeSourcePath, { force: true }),
  rm(mainBytecodePath, { force: true }),
  ...(isBytecodeBuild ? [rm(mainModulePath, { force: true })] : [])
])

const bundleOutfile = isBytecodeBuild ? mainBytecodeSourcePath : mainModulePath

await build({
  entryPoints: [path.join(workspaceRoot, 'electron/main.ts')],
  bundle: true,
  platform: 'node',
  format: isBytecodeBuild ? 'cjs' : 'esm',
  outfile: bundleOutfile,
  banner: isBytecodeBuild
    ? {
        js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;"
      }
    : {
        js: "import { createRequire as __esbuildCreateRequire } from 'node:module'; const require = __esbuildCreateRequire(import.meta.url);"
      },
  define: isBytecodeBuild
    ? {
        'import.meta.url': 'import_meta_url'
      }
    : undefined,
  external: [
    'electron',
    'sharp',
    'pnpm'
  ],
  target: ['node22'],
  treeShaking: true,
  minify: true,
  legalComments: 'none',
  sourcemap: false
})

if (isBytecodeBuild) {
  await bytenode.compileFile({
    filename: mainBytecodeSourcePath,
    output: mainBytecodePath,
    electron: true,
    compileAsModule: true,
    createLoader: false
  })
  await rm(mainBytecodeSourcePath, { force: true })
}

await writeFile(
  mainLoaderPath,
  `'use strict';

const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const bytecodeEntry = join(__dirname, 'main.jsc');
const moduleEntry = join(__dirname, 'main.js');

(async () => {
  try {
    if (existsSync(bytecodeEntry)) {
      require('bytenode');
      require(bytecodeEntry);
      return;
    }

    await import(pathToFileURL(moduleEntry).href);
  } catch (error) {
    process.nextTick(() => {
      throw error;
    });
  }
})();
`,
  'utf8'
)

console.log(
  isBytecodeBuild
    ? '[build-main] Main process bundled as minified CommonJS bytecode with a CJS loader'
    : '[build-main] Main process bundled as minified ESM with a CJS loader and runtime-only externals'
)
