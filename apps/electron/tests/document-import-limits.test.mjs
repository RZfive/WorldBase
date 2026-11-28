import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import {
  MAX_DOCUMENT_ATTACHMENT_SIZE_BYTES,
  readUploadedAttachment
} from '../src/renderer/components/chat/panel/attachment-utils.ts'
import {
  readUploadedAttachmentFromPath
} from '../electron/main-process/media/attachments.ts'
import {
  MAX_CHAT_UPLOADED_OFFICE_FILE_SIZE_BYTES,
  MAX_DOCUMENT_WORKBENCH_FILE_SIZE_BYTES
} from '../electron/main-process/constants.ts'

assert.equal(MAX_DOCUMENT_ATTACHMENT_SIZE_BYTES, 100 * 1024 * 1024)
assert.equal(MAX_CHAT_UPLOADED_OFFICE_FILE_SIZE_BYTES, MAX_DOCUMENT_ATTACHMENT_SIZE_BYTES)
assert.equal(MAX_DOCUMENT_WORKBENCH_FILE_SIZE_BYTES, MAX_DOCUMENT_ATTACHMENT_SIZE_BYTES)

test('office attachments support files larger than 10MB and still cap at 100MB', { timeout: 30_000 }, async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldbase-large-xlsx-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Data')
  sheet.addRow(['name', 'value'])
  sheet.addRow(['large workbook', 'ok'])
  const base = await workbook.xlsx.writeBuffer()
  const zip = await JSZip.loadAsync(base)
  zip.file('xl/media/large.bin', randomBytes(11 * 1024 * 1024), {
    binary: true,
    compression: 'STORE'
  })
  const largeXlsx = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  const filePath = path.join(root, 'large.xlsx')
  fs.writeFileSync(filePath, largeXlsx)
  assert.ok(fs.statSync(filePath).size > 10 * 1024 * 1024)

  const uploaded = await readUploadedAttachmentFromPath(filePath)
  assert.equal(uploaded.fileType, 'xlsx')
  assert.match(uploaded.content, /large workbook/)

  const tooLarge = path.join(root, 'too-large.xlsx')
  fs.writeFileSync(tooLarge, '')
  fs.truncateSync(tooLarge, MAX_DOCUMENT_ATTACHMENT_SIZE_BYTES + 1)
  await assert.rejects(readUploadedAttachmentFromPath(tooLarge), /100 MB/)
})

test('desktop attachments read large Office files from their local path before IPC bytes', async () => {
  const calls = []
  const previousWindow = globalThis.window
  globalThis.window = {
    electronAPI: {
      async readUploadedAttachmentFile (filePath) {
        calls.push(['path', filePath])
        return { filePath, fileName: 'large.xlsx', size: 11 * 1024 * 1024, fileType: 'xlsx', content: 'ok' }
      },
      async readUploadedAttachmentBuffer () {
        calls.push(['buffer'])
        throw new Error('Buffer path should not be used when a local file path exists')
      }
    }
  }
  try {
    const file = {
      name: 'large.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 11 * 1024 * 1024,
      path: '/tmp/large.xlsx',
      async arrayBuffer () {
        calls.push(['arrayBuffer'])
        return new ArrayBuffer(0)
      }
    }
    const result = await readUploadedAttachment(file)
    assert.equal(result.fileType, 'xlsx')
    assert.deepEqual(calls, [['path', '/tmp/large.xlsx']])
  } finally {
    globalThis.window = previousWindow
  }
})
