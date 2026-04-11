import { build } from 'esbuild'

await build({
  entryPoints: ['electron/main.ts'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  outfile: 'dist-electron/electron/main.js',
  sourcemap: false,
})

console.log('[build-main] Main process bundled as ESM with external package dependencies')
