import { build } from 'esbuild'

await build({
  entryPoints: ['electron/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/electron/preload.js',
  external: ['electron'],
})

console.log('[build-preload] Preload script bundled as CJS')
