import test from 'node:test'
import assert from 'node:assert/strict'

const {
  classifyWorkFile,
  isAssetFile,
  isCodeFile,
  isDocumentFile
} = await import('../src/shared/work-file-kind.ts')

test('classifies office and PDF files as documents', () => {
  for (const filePath of [
    'report.pdf',
    'memo.doc',
    'memo.docx',
    'sheet.xls',
    'sheet.xlsx',
    'deck.ppt',
    'deck.pptx'
  ]) {
    assert.equal(classifyWorkFile(filePath), 'document', filePath)
  }
})

test('classifies markdown and plain text by document surface', () => {
  for (const filePath of [
    'notes.md',
    'notes.markdown',
    'notes.mdx',
    'notes.txt',
    'data.csv',
    'data.tsv'
  ]) {
    assert.equal(classifyWorkFile(filePath), 'code', filePath)
    assert.equal(classifyWorkFile(filePath, { documentSurface: true }), 'document', filePath)
    assert.equal(classifyWorkFile(filePath, { documentSurface: false }), 'code', filePath)
  }
})

test('classifies source, config, and scripts as code', () => {
  for (const filePath of [
    'src/app.ts',
    'src/App.tsx',
    'src/index.js',
    'src/index.mjs',
    'src/App.vue',
    'main.py',
    'main.go',
    'main.rs',
    'Main.java',
    'package.json',
    'tsconfig.json',
    'config.yaml',
    'config.yml',
    'Cargo.toml',
    'settings.ini',
    'index.html',
    'styles.css',
    'schema.sql',
    'scripts/build.sh',
    'scripts/run.ps1'
  ]) {
    assert.equal(classifyWorkFile(filePath), 'code', filePath)
  }
})

test('classifies images, media, archives, fonts, and databases as assets', () => {
  for (const filePath of [
    'logo.png',
    'photo.JPG',
    'diagram.svg',
    'sound.mp3',
    'clip.mp4',
    'bundle.zip',
    'backup.tar.gz',
    'font.woff2',
    'index.db',
    'cache.sqlite',
    'cache.sqlite3'
  ]) {
    assert.equal(classifyWorkFile(filePath), 'asset', filePath)
  }
})

test('classifies unknown and extensionless files as unknown', () => {
  for (const filePath of [
    'README',
    'Makefile',
    '.gitignore',
    'archive.unknownext',
    '',
    'trailingdot.'
  ]) {
    assert.equal(classifyWorkFile(filePath), 'unknown', filePath)
  }
})

test('handles Windows paths and mixed-case extensions', () => {
  assert.equal(classifyWorkFile('C:\\Users\\Ada\\Reports\\Q3.DOCX'), 'document')
  assert.equal(classifyWorkFile('C:\\repo\\src\\App.TSX'), 'code')
  assert.equal(classifyWorkFile('C:\\assets\\LOGO.PNG'), 'asset')
  assert.equal(classifyWorkFile('C:\\notes\\SUMMARY.MD'), 'code')
  assert.equal(
    classifyWorkFile('C:\\notes\\SUMMARY.MD', { documentSurface: true }),
    'document'
  )
  assert.equal(classifyWorkFile('C:\\backups\\site.TAR.GZ'), 'asset')
})

test('exposes document, code, and asset helpers', () => {
  assert.equal(isDocumentFile('report.pdf'), true)
  assert.equal(isDocumentFile('notes.md'), true)
  assert.equal(isDocumentFile('src/app.ts'), false)
  assert.equal(isCodeFile('notes.md'), true)
  assert.equal(isCodeFile('src/app.ts'), true)
  assert.equal(isCodeFile('report.pdf'), false)
  assert.equal(isAssetFile('logo.png'), true)
  assert.equal(isAssetFile('archive.tar.gz'), true)
  assert.equal(isAssetFile('src/app.ts'), false)
})
