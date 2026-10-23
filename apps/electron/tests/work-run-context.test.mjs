import test from 'node:test'
import assert from 'node:assert/strict'

const { resolveWorkRunContext } = await import('../src/renderer/components/chat/panel/work-run-context.ts')

test('document-only edit keeps coding off and uses the document parent as root', () => {
  const context = resolveWorkRunContext({
    text: '修改 report.docx 的标题',
    activeTabKind: 'document',
    documentTabs: [{
      filePath: '/Users/me/Documents/report.docx',
      fileName: 'report.docx',
      fileType: 'docx'
    }]
  })

  assert.equal(context.intent, 'document')
  assert.equal(context.coding.enabled, false)
  assert.equal(context.coding.root, '/Users/me/Documents')
  assert.deepEqual(context.documents.map(document => document.filePath), ['/Users/me/Documents/report.docx'])
  assert.deepEqual(context.targets.map(target => target.source), ['active-document'])
})

test('explicit document path without a tab still supplies its parent as root', () => {
  const context = resolveWorkRunContext({
    text: '修改 docs/report.docx'
  })

  assert.equal(context.intent, 'document')
  assert.equal(context.coding.enabled, false)
  assert.equal(context.coding.root, 'docs')
  assert.deepEqual(context.documents.map(document => document.filePath), ['docs/report.docx'])
})

test('code file path enables coding', () => {
  const context = resolveWorkRunContext({
    text: '修复 src/report.ts 的 bug'
  })

  assert.equal(context.intent, 'coding')
  assert.equal(context.coding.enabled, true)
  assert.equal(context.coding.root, null)
  assert.deepEqual(context.targets, [{
    filePath: 'src/report.ts',
    kind: 'code',
    source: 'text'
  }])
})

test('mixed xlsx and ts request keeps both targets and enables coding', () => {
  const context = resolveWorkRunContext({
    text: '读取 data.xlsx 生成 src/report.ts'
  })

  assert.equal(context.intent, 'coding')
  assert.equal(context.coding.enabled, true)
  assert.equal(context.coding.root, null)
  assert.deepEqual(context.documents.map(document => document.filePath), ['data.xlsx'])
  assert.deepEqual(
    context.targets.map(target => [target.filePath, target.kind]),
    [['data.xlsx', 'document'], ['src/report.ts', 'code']]
  )
})

test('coding intent without files enables coding', () => {
  const context = resolveWorkRunContext({
    text: '修复登录接口报错的 bug'
  })

  assert.equal(context.intent, 'coding')
  assert.equal(context.coding.enabled, true)
  assert.equal(context.coding.root, null)
  assert.deepEqual(context.targets, [])
})

test('greeting without files stays normal', () => {
  const context = resolveWorkRunContext({
    text: '你好'
  })

  assert.equal(context.intent, 'normal')
  assert.equal(context.coding.enabled, false)
  assert.equal(context.coding.root, null)
  assert.deepEqual(context.documents, [])
  assert.deepEqual(context.targets, [])
})

test('coding root defers to a bound project, then folderRoot, then the document parent', () => {
  const input = {
    text: '修复 src/app.ts',
    documentTabs: [{ filePath: '/Users/me/Documents/spec.docx' }]
  }

  // A managed project id resolves to a project root in Rust; never pass it as
  // a filesystem path or let a folder root compete with it.
  assert.equal(resolveWorkRunContext({
    ...input,
    targetProjectId: 'proj-42',
    folderRoot: '/Users/me/project'
  }).coding.root, null)

  assert.equal(resolveWorkRunContext({
    ...input,
    folderRoot: '/Users/me/project'
  }).coding.root, '/Users/me/project')

  assert.equal(resolveWorkRunContext(input).coding.root, '/Users/me/Documents')
  assert.equal(resolveWorkRunContext({ text: '修复 src/app.ts' }).coding.root, null)
})

test('an open document tab is context, not the target, for a code request', () => {
  const context = resolveWorkRunContext({
    text: '修复登录接口报错的 bug',
    activeTabKind: 'folder',
    folderRoot: '/repo',
    documentTabs: [{ filePath: '/repo/spec.docx' }]
  })

  assert.equal(context.intent, 'coding')
  assert.equal(context.coding.enabled, true)
  assert.equal(context.coding.root, '/repo')
  assert.deepEqual(context.targets, [])
  assert.deepEqual(context.documents.map(document => document.filePath), ['/repo/spec.docx'])
})

test('windows paths normalize to posix-style parents', () => {
  const context = resolveWorkRunContext({
    text: '修改这份文档的摘要',
    activeTabKind: 'document',
    documentTabs: [{ filePath: 'C:\\Users\\me\\Documents\\report.docx' }]
  })

  assert.equal(context.coding.enabled, false)
  assert.equal(context.coding.root, 'C:/Users/me/Documents')
  assert.equal(context.targets[0].filePath, 'C:/Users/me/Documents/report.docx')
})

test('a generic file reference with an open document stays document work', () => {
  const context = resolveWorkRunContext({
    text: '修改这个文件',
    activeTabKind: 'document',
    documentTabs: [{ filePath: '/Users/me/Documents/report.docx' }]
  })

  assert.equal(context.intent, 'document')
  assert.equal(context.coding.enabled, false)
  assert.equal(context.coding.root, '/Users/me/Documents')
  assert.deepEqual(context.targets.map(target => target.source), ['active-document'])
})

test('real code context still wins over an open document tab', () => {
  const context = resolveWorkRunContext({
    text: '修复登录接口报错的 bug',
    activeTabKind: 'document',
    documentTabs: [{ filePath: '/Users/me/Documents/report.docx' }]
  })

  assert.equal(context.intent, 'coding')
  assert.equal(context.coding.enabled, true)
  assert.equal(context.coding.root, '/Users/me/Documents')
})

test('an explicit markdown path follows an open document tab, not the code default', () => {
  const context = resolveWorkRunContext({
    text: '修改 README.md',
    activeTabKind: 'document',
    documentTabs: [{ filePath: '/repo/README.md' }]
  })

  assert.equal(context.coding.enabled, false)
  assert.equal(context.coding.root, '/repo')
  assert.deepEqual(context.targets.map(target => [target.filePath, target.kind]), [
    ['/repo/README.md', 'document']
  ])
})

test('a casual message does not turn the active folder file into a coding target', () => {
  const context = resolveWorkRunContext({
    text: '你好',
    folderRoot: '/repo',
    activeFolderFilePath: '/repo/src/app.ts',
    activeTabKind: 'folder'
  })

  assert.equal(context.intent, 'normal')
  assert.equal(context.coding.enabled, false)
  assert.deepEqual(context.targets, [])
})

test('an active folder file is a target when the folder tab is active', () => {
  const context = resolveWorkRunContext({
    text: '修复这个 bug',
    folderRoot: '/repo',
    activeFolderFilePath: '/repo/src/app.ts',
    activeTabKind: 'folder'
  })

  assert.equal(context.coding.enabled, true)
  assert.deepEqual(context.targets, [{
    filePath: '/repo/src/app.ts',
    kind: 'code',
    source: 'active-folder-file'
  }])
})

test('a bare name in text matches an open document tab', () => {
  const context = resolveWorkRunContext({
    text: '修改 report.docx',
    activeTabKind: 'document',
    documentTabs: [{ filePath: '/Users/me/Documents/report.docx' }]
  })

  assert.equal(context.documents.length, 1)
  assert.equal(context.targets.length, 1)
  assert.equal(context.coding.root, '/Users/me/Documents')
})
