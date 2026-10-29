import test from 'node:test'
import assert from 'node:assert/strict'

const {
  detectCodingTask,
  detectWorkIntent,
  isCodingTaskText,
  isDocumentTaskText
} = await import('../src/shared/coding-task-detection.ts')

test('detects fenced code blocks', () => {
  assert.equal(isCodingTaskText('请检查这段代码：```ts\nconst value = 1\n```'), true)
})

test('detects code and project tags', () => {
  assert.equal(isCodingTaskText('处理 [[code:snippet-1]]'), true)
  assert.equal(isCodingTaskText('打开 [[project:demo]]'), true)
})

test('detects code file paths', () => {
  assert.equal(isCodingTaskText('请修改 src/App.tsx 和 package.json'), true)
  assert.equal(isCodingTaskText('检查 .vue 文件'), true)
})

test('detects Chinese bug fixes', () => {
  assert.equal(isCodingTaskText('修复登录接口报错的 bug'), true)
})

test('detects Chinese component implementation', () => {
  assert.equal(isCodingTaskText('实现一个新的表单组件'), true)
})

test('detects English refactoring', () => {
  assert.equal(isCodingTaskText('Refactor the authentication function'), true)
})

test('detects stack traces', () => {
  assert.equal(isCodingTaskText('TypeError: Cannot read properties of undefined\n    at render (app.js:12:3)'), true)
})

test('detects compiler and build errors', () => {
  assert.equal(isCodingTaskText('Build failed: error TS2304: Cannot find name X'), true)
  assert.equal(isCodingTaskText('npm ERR! code ELIFECYCLE'), true)
})

test('returns false for a greeting', () => {
  assert.equal(isCodingTaskText('你好'), false)
})

test('returns false for weather chat', () => {
  assert.equal(isCodingTaskText('今天天气怎么样'), false)
})

test('returns false for a pure conceptual question', () => {
  assert.equal(isCodingTaskText('什么是函数式编程？'), false)
})

test('returns false for an action without a code object', () => {
  assert.equal(isCodingTaskText('请帮我修复这个问题'), false)
})

test('returns the documented reason for each result', () => {
  assert.deepEqual(detectCodingTask('请更新 src/main.rs'), {
    isCoding: true,
    reason: 'strong code signal'
  })
  assert.deepEqual(detectCodingTask('推荐一部电影'), {
    isCoding: false,
    reason: 'no coding signals'
  })
})

test('detects document edits as document intent', () => {
  const documentRequests = [
    '修改这份 PDF 文件',
    '润色 report.docx',
    '把 PPT 第二页标题改一下',
    '读取 data.xlsx',
    '总结一下这份文档',
    '更新表格里的数据',
    '插入一段文字到 Word 文档',
    '删除 PDF 第二页',
    '替换幻灯片里的标题',
    '翻译 report.docx',
    '润色这段文字'
  ]

  for (const text of documentRequests) {
    const detection = detectWorkIntent(text)
    assert.equal(detection.intent, 'document', text)
    assert.equal(detection.coding, false, text)
    assert.equal(isDocumentTaskText(text), true, text)
    assert.equal(isCodingTaskText(text), false, text)
  }
})

test('keeps coding detection for code requests', () => {
  const codingRequests = [
    '修复登录接口报错的 bug',
    '实现一个新的表单组件',
    'Refactor the authentication function',
    '请修改 src/App.tsx 和 package.json',
    '读取 data.xlsx 生成 src/report.ts'
  ]

  for (const text of codingRequests) {
    const detection = detectWorkIntent(text)
    assert.equal(detection.intent, 'coding', text)
    assert.equal(detection.coding, true, text)
    assert.equal(isDocumentTaskText(text), false, text)
    assert.equal(isCodingTaskText(text), true, text)
  }
})

test('strong code signals win over document wording', () => {
  const detection = detectWorkIntent('修改这份 PDF 文档里的 src/report.ts')
  assert.equal(detection.intent, 'coding')
  assert.equal(detection.reason, 'strong code signal')
  assert.equal(isDocumentTaskText('修改这份 PDF 文档里的 src/report.ts'), false)
})

test('returns normal intent for conversational text', () => {
  const detection = detectWorkIntent('今天天气怎么样')
  assert.deepEqual(detection, {
    intent: 'normal',
    coding: false,
    reason: 'no coding signals'
  })
  assert.equal(isDocumentTaskText('今天天气怎么样'), false)
})

test('keeps the coding-only compatibility API for document tasks', () => {
  assert.deepEqual(detectCodingTask('修改这份 PDF 文件'), {
    isCoding: false,
    reason: 'no coding signals'
  })
})
