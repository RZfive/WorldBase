import assert from 'node:assert/strict'
import test from 'node:test'

import './register-ts-hooks.mjs'
import { buildToolRunSummary, filePathForToolRun } from '../src/main/ai-harness/tool-run-summary.ts'
import { getToolRunDisplayName } from '../src/renderer/components/chat/message-utils.ts'

test('grep-style tools show pattern, dir and include filter', () => {
  assert.equal(
    buildToolRunSummary('grep_search', { project_id: 'proj_1', pattern: 'ToolRun', include_pattern: '*.rs' }),
    'ToolRun · *.rs'
  )
  assert.equal(
    buildToolRunSummary('grep_workspace', { pattern: 'err', dir_path: 'src/', include_pattern: '*.ts' }),
    'err · src/ · *.ts'
  )
  assert.equal(buildToolRunSummary('glob_workspace', { pattern: '**/*.vue' }), '**/*.vue')
})

test('read tools show file path with optional line anchor', () => {
  assert.equal(buildToolRunSummary('read_workspace_file', { file_path: 'src/config.ts' }), 'src/config.ts')
  assert.equal(
    buildToolRunSummary('read_project_file', { project_id: 'proj_1', file_path: 'src/app.ts', start_line: 120 }),
    'src/app.ts:120'
  )
})

test('write/edit tools show only the path, never the content', () => {
  assert.equal(
    buildToolRunSummary('write_project_file', { project_id: 'p', file_path: 'src/a.vue', content: 'x'.repeat(5000) }),
    'src/a.vue'
  )
  assert.equal(
    buildToolRunSummary('edit_workspace_file', { file_path: 'a.md', old_string: 'old', new_string: 'new' }),
    'a.md'
  )
  assert.equal(
    buildToolRunSummary('edit_project_file', { project_id: 'p', file_path: 'a.md', replace_all: true }),
    'a.md · replace_all'
  )
  assert.equal(
    buildToolRunSummary('patch_project_file', { project_id: 'p', file_path: 'a.md', patches: [{}, {}, {}] }),
    'a.md · 3 patches'
  )
})

test('listings show the directory and stay bare at the root', () => {
  assert.equal(buildToolRunSummary('list_project_files', { project_id: 'p', dir_path: 'src/api' }), 'src/api')
  assert.equal(buildToolRunSummary('list_workspace_files', {}), '')
})

test('command tools show the command text, truncated', () => {
  assert.equal(buildToolRunSummary('run_workspace_command', { command: 'pnpm test' }), 'pnpm test')
  assert.equal(buildToolRunSummary('run_shell_command', { command: "git add -A && git commit -m 'msg'" }), "git add -A && git commit -m 'msg'")
  assert.equal(buildToolRunSummary('local_run_command', { command: 'node -e "x"' }), 'node -e "x"')
  const long = 'node -e "' + 'const a = 1; '.repeat(20) + '"'
  const summary = buildToolRunSummary('run_workspace_command', { command: long })
  assert.ok(summary.length <= 72, `summary too long: ${summary.length}`)
  assert.ok(summary.endsWith('…'))
  assert.ok(summary.startsWith('node -e'))
})

test('write_active_terminal previews the typed text and stays bare while polling', () => {
  assert.equal(buildToolRunSummary('write_active_terminal', { text: 'pnpm test', execute: true }), 'pnpm test')
  assert.equal(buildToolRunSummary('write_active_terminal', { text: '' }), '')
})

test('fetch_webpage shows the first url plus a count for extra urls', () => {
  assert.equal(buildToolRunSummary('fetch_webpage', { urls: ['https://example.com/docs'] }), 'https://example.com/docs')
  assert.equal(
    buildToolRunSummary('fetch_webpage', { urls: ['https://a.com', 'https://b.com'] }),
    'https://a.com +1'
  )
})

test('interact_current_page shows action and first meaningful target', () => {
  assert.equal(buildToolRunSummary('interact_current_page', { action: 'click', selector: '#submit' }), 'click · #submit')
  assert.equal(buildToolRunSummary('interact_current_page', { action: 'fill', label: '搜索', value: '关键词' }), 'fill · 搜索')
})

test('call_project_api shows method and path', () => {
  assert.equal(
    buildToolRunSummary('call_project_api', { project_id: 'p', method: 'GET', path: '/api/records' }),
    'GET · /api/records'
  )
})

test('tools without displayable arguments stay bare', () => {
  assert.equal(buildToolRunSummary('mcp__mcp_chrome_dev__evaluate_script__4tz2u5', { script: 'x' }), '')
  assert.equal(buildToolRunSummary('rebuild_project', { project_id: 'p' }), '')
  assert.equal(buildToolRunSummary('read_current_page', { max_chars: 1000 }), '')
  assert.equal(buildToolRunSummary('manage_todo_list', { items: [] }), '')
  assert.equal(buildToolRunSummary('some_future_tool', { anything: 1 }), '')
  assert.equal(buildToolRunSummary('read_workspace_file', null), '')
})

test('mcp display names drop the random suffix but keep real names', () => {
  assert.equal(getToolRunDisplayName('mcp__mcp_chrome_dev__evaluate_script__4tz2u5'), 'mcp_chrome_dev · evaluate_script')
  assert.equal(getToolRunDisplayName('mcp__mcp_chrome_dev__navigate_page__m6anbd'), 'mcp_chrome_dev · navigate_page')
  // No digit in the trailing segment → treat it as the real tool name.
  assert.equal(getToolRunDisplayName('mcp__myserver__tool'), 'myserver · tool')
  assert.equal(getToolRunDisplayName('read_workspace_file'), 'read_workspace_file')
  assert.equal(getToolRunDisplayName('long_term_goal_get_context'), '读取长期目标状态')
})

test('file tools expose the full target path for click-to-open', () => {
  const longPath = 'apps/electron/src/renderer/components/chat/message-utils.ts'
  assert.equal(
    filePathForToolRun('read_workspace_file', { file_path: longPath }),
    longPath
  )
  assert.equal(
    filePathForToolRun('write_workspace_file', { path: 'src/a.ts', content: 'x'.repeat(5000) }),
    'src/a.ts'
  )
  assert.equal(
    filePathForToolRun('local_write_file', { file_path: '/Users/me/notes.md' }),
    '/Users/me/notes.md'
  )
  // Non-file tools and malformed args carry no path.
  assert.equal(filePathForToolRun('grep_workspace', { pattern: 'needle' }), '')
  assert.equal(filePathForToolRun('read_workspace_file', null), '')
  assert.equal(filePathForToolRun('read_workspace_file', { file_path: '   ' }), '')
})
