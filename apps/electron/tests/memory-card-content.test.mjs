import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'vue/compiler-sfc'
import { hasAdditionalMemoryDetails } from '../src/renderer/utils/memory-card-content.ts'

const file = new URL('../src/renderer/components/settings/MemorySettingsPanel.vue', import.meta.url)
const { descriptor, errors } = parse(await fs.readFile(file, 'utf8'), { filename: file.pathname })
assert.deepEqual(errors, [])

function findElements (node, predicate) {
  if (!node) return []
  return [
    ...(node.type === 1 && predicate(node) ? [node] : []),
    ...(node.children || []).flatMap(child => findElements(child, predicate))
  ]
}
function hasClass (node, name) {
  return node.props?.some(prop => prop.type === 6 && prop.name === 'class' && prop.value?.content.split(/\s+/).includes(name))
}
function section (className) {
  const nodes = findElements(descriptor.template.ast, node => hasClass(node, className))
  assert.equal(nodes.length, 1, `one ${className} section`)
  return nodes[0]
}

test('memory details and source sections are native disclosures, closed by default', () => {
  for (const name of ['memory-details', 'memory-source']) {
    const node = section(name)
    assert.equal(node.tag, 'details')
    assert.ok(node.children.some(child => child.type === 1 && child.tag === 'summary'))
    assert.equal(node.props.some(prop => prop.name === 'open' || (prop.name === 'bind' && prop.arg?.content === 'open')), false)
  }
})

test('missing source information is inside the collapsed source section, not a permanent card footer', () => {
  const source = section('memory-source')
  assert.equal(findElements(source, node => hasClass(node, 'memory-source-missing')).length, 1)
  assert.equal(findElements(descriptor.template.ast, node => hasClass(node, 'memory-source-missing')).length, 1)
})

test('details render through the sanitized markdown pipeline; source text stays escaped', () => {
  const details = section('memory-details')
  const body = findElements(details, node => hasClass(node, 'memory-details-body'))
  assert.equal(body.length, 1)
  const htmlDirective = body[0].props.find(prop => prop.type === 7 && prop.name === 'html')
  assert.ok(htmlDirective, 'details body injects rendered HTML')
  assert.match(htmlDirective.exp?.content || '', /renderMarkdown\(/, 'injected HTML must come from the renderMarkdown sanitizer')
  assert.equal(findElements(details, child => child.tag === 'pre').length, 0)

  const source = section('memory-source')
  const pre = findElements(source, child => child.tag === 'pre')
  assert.equal(pre.length, 1)
  assert.equal(pre[0].props.some(prop => prop.type === 7 && prop.name === 'html'), false)
  assert.ok(pre[0].children.some(child => child.type === 5), 'Vue text interpolation escapes markup')
})

test('empty details and legacy copies of the summary or user source are suppressed', () => {
  assert.equal(hasAdditionalMemoryDetails({ summary: 'fact' }), false)
  assert.equal(hasAdditionalMemoryDetails({ summary: 'fact', details: '  \n ' }), false)
  assert.equal(hasAdditionalMemoryDetails({ summary: 'fact', details: ' fact ' }), false)
  assert.equal(hasAdditionalMemoryDetails({ summary: '用户喜欢吃苹果', sourceText: '我喜欢吃苹果。\n请记住。', details: '我喜欢吃苹果。 请记住。' }), false)
})

test('independent legacy AI details remain available without rewriting the original memory', () => {
  const entry = Object.freeze({
    summary: '项目架构概述',
    details: '```mermaid flowchart LR A --> B``` <img src=x onerror=alert(1)>',
    sourceText: '  帮我设计这个项目。\n\n保留原话。  '
  })
  const before = JSON.stringify(entry)
  assert.equal(hasAdditionalMemoryDetails(entry), true)
  assert.equal(JSON.stringify(entry), before)
})
