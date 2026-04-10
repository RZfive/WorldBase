import { build } from 'esbuild'

await build({
  entryPoints: ['electron/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist-electron/electron/main.js',
  external: [
    'electron',
    'better-sqlite3',
    // readable-stream/* are optional fallbacks in officegen for old Node.js
    // versions lacking built-in stream.Transform / stream.PassThrough.
    // Modern Node.js (and Electron) always provide these natively.
    'readable-stream',
    'readable-stream/*',
  ],
  sourcemap: false,
})

console.log('[build-main] Main process bundled as ESM')
