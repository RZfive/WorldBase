import { build } from 'esbuild'

await build({
  entryPoints: ['electron/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist-electron/electron/main.js',
  banner: {
    js: "import { createRequire as __esbuildCreateRequire } from 'node:module'; const require = __esbuildCreateRequire(import.meta.url);"
  },
  external: [
    'electron',
    'better-sqlite3',
    'pnpm'
  ],
  sourcemap: false,
})

console.log('[build-main] Main process bundled as ESM with runtime-only externals')
