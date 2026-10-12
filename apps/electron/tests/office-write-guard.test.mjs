/**
 * Office 直写守卫单测：已存在的 Office 文档禁止直写（防止全文重建丢图），
 * 新建路径与纯文本目标放行；纯文本工具对任何 Office 目标都拒绝。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const {
  assertOfficeWriteAllowed,
  assertTextToolNotOfficeTarget,
  isOfficeDocumentPath
} = await import('../src/main/ai-engine/agent/tools/office-write-guard.ts')

test('isOfficeDocumentPath detects office extensions case-insensitively', () => {
  assert.equal(isOfficeDocumentPath('/tmp/a.docx'), true)
  assert.equal(isOfficeDocumentPath('/tmp/a.PPTX'), true)
  assert.equal(isOfficeDocumentPath('/tmp/a.xls'), true)
  assert.equal(isOfficeDocumentPath('/tmp/a.md'), false)
  assert.equal(isOfficeDocumentPath('/tmp/a.docx.md'), false)
  assert.equal(isOfficeDocumentPath('/tmp/noext'), false)
})

test('assertOfficeWriteAllowed rejects an existing office document', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-guard-'))
  try {
    const target = path.join(dir, 'report.docx')
    await fs.writeFile(target, 'binary-ish')
    await assert.rejects(
      () => assertOfficeWriteAllowed(target),
      /doc_draft/
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('assertOfficeWriteAllowed allows new office paths and text files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-guard-'))
  try {
    await assertOfficeWriteAllowed(path.join(dir, 'new-deck.pptx'))
    const textFile = path.join(dir, 'notes.md')
    await fs.writeFile(textFile, '# ok')
    await assertOfficeWriteAllowed(textFile)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('assertTextToolNotOfficeTarget rejects any office target synchronously', () => {
  assert.throws(() => assertTextToolNotOfficeTarget('src/assets/existing.xlsx'), /doc_draft|local_write_file/)
  assert.throws(() => assertTextToolNotOfficeTarget('src/assets/brand-new.pptx'))
  assert.doesNotThrow(() => assertTextToolNotOfficeTarget('src/app/main.ts'))
})
