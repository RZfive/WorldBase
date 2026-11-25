import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import './register-ts-hooks.mjs'
import {
  detectDocumentType,
  isSupportedDocument,
  parseDocumentBuffer
} from '../src/main/document-workbench/document-parser.ts'
import {
  buildDocumentRenderPreview,
  readDocumentRenderAsset
} from '../src/main/document-preview/document-render-service.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
)

test('detects and imports image documents without a text parser', async () => {
  assert.equal(detectDocumentType('assets/logo.PNG'), 'image')
  assert.equal(isSupportedDocument('assets/logo.png'), true)

  const artifact = await parseDocumentBuffer(ONE_PIXEL_PNG, { fileName: 'logo.png' })

  assert.equal(artifact.fileType, 'image')
  assert.equal(artifact.plainText, '')
  assert.equal(artifact.nodes.length, 1)
  assert.equal(artifact.nodes[0].type, 'image_placeholder')
  assert.equal(artifact.nodes[0].text, 'logo.png')
})

test('builds and reads a render asset for image documents', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worldbase-document-image-'))
  try {
    const filePath = path.join(directory, 'logo.png')
    await fs.writeFile(filePath, ONE_PIXEL_PNG)

    const render = await buildDocumentRenderPreview(filePath, 'image')
    assert.equal(render.kind, 'image')
    assert.equal(render.status, 'ready')
    assert.equal(render.source, 'original')
    assert.equal(render.mimeType, 'image/png')

    const asset = await readDocumentRenderAsset(render)
    assert.ok(asset)
    assert.equal(asset.mimeType, 'image/png')
    assert.deepEqual(Buffer.from(asset.bytes), ONE_PIXEL_PNG)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
