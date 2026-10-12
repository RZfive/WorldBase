/**
 * 文档文件监听单测：注册/引用计数/去抖/变化事件/unwatch 释放。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { DocumentFileWatcher } = await import('../electron/main-process/document-file-watcher.ts')

function waitForChange (watcher, filePath) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('change event timeout')), 5000)
    const off = watcher.onChange((change) => {
      if (path.resolve(change.filePath) !== path.resolve(filePath)) return
      clearTimeout(timer)
      off()
      resolve(change)
    })
  })
}

test('watch emits a debounced change with stat info', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-watch-'))
  const watcher = new DocumentFileWatcher()
  try {
    const file = path.join(dir, 'a.docx')
    await fs.writeFile(file, 'v1')
    assert.equal(watcher.watch(file), true)
    // 不存在的文件注册失败
    assert.equal(watcher.watch(path.join(dir, 'missing.docx')), false)

    const changePromise = waitForChange(watcher, file)
    // 短时间多次写只应触发去抖后的通知（等待首个事件即可验证通路）
    await fs.writeFile(file, 'v2-longer-content')
    const change = await changePromise
    assert.equal(path.resolve(change.filePath), path.resolve(file))
    assert.equal(change.size, Buffer.byteLength('v2-longer-content'))
  } finally {
    watcher.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('unwatch refcount keeps the watch until the last release', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-watch-'))
  const watcher = new DocumentFileWatcher()
  try {
    const file = path.join(dir, 'b.md')
    await fs.writeFile(file, 'x')
    watcher.watch(file)
    watcher.watch(file)
    assert.deepEqual(watcher.watchedPaths(), [path.resolve(file)])

    watcher.unwatch(file)
    assert.equal(watcher.watchedPaths().length, 1, 'still held by the second ref')

    const changePromise = waitForChange(watcher, file)
    await fs.writeFile(file, 'y')
    await changePromise

    watcher.unwatch(file)
    assert.equal(watcher.watchedPaths().length, 0, 'released after last unwatch')
  } finally {
    watcher.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('no spurious events while the file is untouched', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-watch-'))
  const watcher = new DocumentFileWatcher()
  try {
    const file = path.join(dir, 'c.txt')
    await fs.writeFile(file, 'stable')
    watcher.watch(file)

    let fired = false
    const off = watcher.onChange(() => { fired = true })
    await new Promise(resolve => setTimeout(resolve, 800))
    off()
    assert.equal(fired, false, 'no event without any write')
  } finally {
    watcher.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
