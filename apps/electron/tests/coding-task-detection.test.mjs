import test from 'node:test'
import assert from 'node:assert/strict'

const { detectCodingTask, isCodingTaskText } = await import('../src/shared/coding-task-detection.ts')

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
