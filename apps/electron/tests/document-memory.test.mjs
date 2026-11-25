import assert from 'node:assert/strict'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { DocumentStore } from '../src/main/document-workbench/document-store.ts'
import { readDocumentRenderAsset } from '../src/main/document-preview/document-render-service.ts'

test('in-memory markdown documents render and feed the docfile context pipeline', async () => {
  const store = new DocumentStore()
  const markdown = '# 项目方案\n\n## 目标\n\n做一个可玩的方块世界。\n'
  const artifact = store.addInMemoryMarkdown('项目方案', markdown)

  assert.equal(artifact.ephemeral, true)
  assert.equal(artifact.filePath, '')
  assert.equal(artifact.fileName, '项目方案.md')
  assert.equal(artifact.fileType, 'md')
  assert.equal(artifact.plainText, markdown)
  assert.equal(artifact.render?.kind, 'markdown')
  assert.equal(artifact.render?.inlineContent, markdown)
  assert.equal(store.getArtifactText(artifact.id), markdown)

  const asset = await readDocumentRenderAsset(artifact.render)
  assert.ok(asset)
  assert.equal(asset.mimeType, 'text/markdown; charset=utf-8')
  assert.equal(Buffer.from(asset.bytes).toString('utf8'), markdown)

  const prompt = store.buildFileContextPrompt([artifact.id])
  assert.match(prompt, /项目方案\.md/)
  assert.match(prompt, /做一个可玩的方块世界/)
})

test('in-memory markdown summary carries no disk path', () => {
  const store = new DocumentStore()
  const artifact = store.addInMemoryMarkdown('PRD', '# PRD')
  const [summary] = store.listSummaries()

  assert.equal(summary.id, artifact.id)
  assert.equal(summary.filePath, '')
  assert.equal(summary.fileName, 'PRD.md')
  assert.equal(summary.fileType, 'md')
})
