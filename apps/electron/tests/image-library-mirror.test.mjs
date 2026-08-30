import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { ImageLibraryStore } from '../src/main/settings/image-library-store.ts'

function mirror (id, overrides = {}) {
  return {
    id,
    createdAt: '2026-08-30T12:00:00.000Z',
    mode: 'generate',
    providerId: 'rust-provider',
    model: 'rust-image-model',
    prompt: `Rust image ${id}`,
    fileName: `${id}.png`,
    ...overrides
  }
}

test('rebuildIndexFromMirrors removes stale Electron image rows after Rust ownership', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'worldbase-image-mirror-'))
  const library = path.join(userData, 'image-library')
  try {
    await fs.mkdir(library, { recursive: true })
    await fs.writeFile(
      path.join(library, 'legacy-image.json'),
      JSON.stringify(mirror('legacy-image', { folder: 'legacy', tags: ['old'] }))
    )

    const store = new ImageLibraryStore(userData)
    assert.deepEqual(store.query({ folder: '*', limit: 20, offset: 0 }).items.map(item => item.id), ['legacy-image'])

    await fs.rm(path.join(library, 'legacy-image.json'))
    await fs.writeFile(
      path.join(library, 'rust-image.json'),
      JSON.stringify(mirror('rust-image', {
        mode: 'edit',
        folder: 'rust-runs',
        tags: ['generated', 'native'],
        negativePrompt: 'blur',
        aspectRatio: '16:9',
        size: '1792x1024',
        outputFormat: 'webp'
      }))
    )
    await fs.writeFile(path.join(library, 'folders.json'), JSON.stringify(['rust-runs', 'empty-rust-folder']))

    store.rebuildIndexFromMirrors()

    const page = store.query({ folder: '*', limit: 20, offset: 0 })
    assert.equal(page.total, 1)
    assert.deepEqual(page.items.map(item => item.id), ['rust-image'])
    assert.deepEqual(page.items[0].tags, ['generated', 'native'])
    assert.equal(page.items[0].folder, 'rust-runs')
    assert.equal(page.items[0].mode, 'edit')
    assert.deepEqual(store.listFolders().map(folder => [folder.name, folder.count]), [
      ['empty-rust-folder', 0],
      ['rust-runs', 1]
    ])
  } finally {
    await fs.rm(userData, { recursive: true, force: true })
  }
})

test('TS fallback folder mutations keep the Rust handoff mirror current', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'worldbase-image-folder-mirror-'))
  const library = path.join(userData, 'image-library')
  try {
    const store = new ImageLibraryStore(userData)
    store.createFolder('empty-ts-folder')
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(library, 'folders.json'), 'utf8')),
      ['empty-ts-folder']
    )

    store.deleteFolder('empty-ts-folder')
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(library, 'folders.json'), 'utf8')),
      []
    )
  } finally {
    await fs.rm(userData, { recursive: true, force: true })
  }
})
