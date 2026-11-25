import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import './register-ts-hooks.mjs'
import {
  classifyWorkspaceFile,
  readFolderWorkspaceFile
} from '../src/main/folder-workspace/folder-workspace-fs.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
)

test('classifies browser-renderable images as image files', () => {
  for (const filePath of [
    'logo.png',
    'photo.JPG',
    'portrait.jpeg',
    'animation.gif',
    'hero.webp',
    'favicon.ico',
    'diagram.bmp',
    'cover.avif'
  ]) {
    assert.equal(classifyWorkspaceFile(filePath).kind, 'image', filePath)
  }
  assert.equal(classifyWorkspaceFile('icon.svg').kind, 'svg')
  assert.equal(classifyWorkspaceFile('archive.zip').kind, 'binary')
})

test('reads png files as a self-contained image preview', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'worldbase-workspace-image-'))
  try {
    await fs.mkdir(path.join(rootPath, 'assets'))
    await fs.writeFile(path.join(rootPath, 'assets', 'logo.PNG'), ONE_PIXEL_PNG)

    const result = await readFolderWorkspaceFile(rootPath, 'assets/logo.PNG')

    assert.equal(result.kind, 'image')
    assert.equal(result.fileName, 'logo.PNG')
    assert.equal(result.mimeType, 'image/png')
    assert.equal(result.content, '')
    assert.equal(result.lineCount, 0)
    assert.equal(result.truncated, false)
    assert.match(result.imageDataUrl, /^data:image\/png;base64,/)
    assert.equal(
      Buffer.from(result.imageDataUrl.split(',')[1], 'base64').equals(ONE_PIXEL_PNG),
      true
    )
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true })
  }
})

test('reads svg source and a previewable data url together', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'worldbase-workspace-svg-'))
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'
  try {
    await fs.writeFile(path.join(rootPath, 'icon.svg'), source)

    const result = await readFolderWorkspaceFile(rootPath, 'icon.svg')

    assert.equal(result.kind, 'svg')
    assert.equal(result.language, 'xml')
    assert.equal(result.content, source)
    assert.equal(result.mimeType, 'image/svg+xml')
    assert.match(result.imageDataUrl, /^data:image\/svg\+xml;base64,/)
    assert.equal(
      Buffer.from(result.imageDataUrl.split(',')[1], 'base64').toString('utf8'),
      source
    )
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true })
  }
})

test('still rejects non-image binary previews', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'worldbase-workspace-binary-'))
  try {
    await fs.writeFile(path.join(rootPath, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04]))

    await assert.rejects(
      readFolderWorkspaceFile(rootPath, 'archive.zip'),
      /Cannot preview binary file/
    )
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true })
  }
})
