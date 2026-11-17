#!/usr/bin/env node
/* Copy Next.js static assets into the standalone output produced by `next build`. */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const standalone = path.join(root, '.next', 'standalone')

function copyDirectory (source, target) {
  if (!fs.existsSync(source)) return false
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      copyDirectory(from, to)
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to)
    }
  }
  return true
}

if (!fs.existsSync(standalone)) {
  console.log('[postbuild] .next/standalone is missing; skipping asset copy')
  process.exit(0)
}

const staticCopied = copyDirectory(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'))
const publicCopied = copyDirectory(path.join(root, 'public'), path.join(standalone, 'public'))

if (!fs.existsSync(path.join(root, 'data'))) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
}

console.log(`[postbuild] standalone assets synced (static=${staticCopied}, public=${publicCopied})`)
