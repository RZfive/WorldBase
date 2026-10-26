import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import './register-ts-hooks.mjs'
import { findSearchExtractPreset } from '../src/shared/search-extract-presets.ts'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const ELECTRON_ROOT = path.resolve(TEST_DIR, '..')
const REPO_ROOT = path.resolve(ELECTRON_ROOT, '../..')

const CONTRACT_PATH = path.join(REPO_ROOT, 'harness-rs/crates/tools/electron-tool-contracts.json')
const WINDOWS_PATH = path.join(ELECTRON_ROOT, 'electron/main-process/windows.ts')
const IPC_PATH = path.join(ELECTRON_ROOT, 'electron/main-process/ipc.ts')
const MAIN_CONSTANTS_PATH = path.join(ELECTRON_ROOT, 'electron/main-process/constants.ts')
const APP_PATH = path.join(ELECTRON_ROOT, 'src/App.vue')
const BROWSER_WEBVIEW_PATH = path.join(ELECTRON_ROOT, 'src/renderer/components/app/BrowserWebView.vue')
const BROWSER_WORKSPACE_TAB_PATH = path.join(ELECTRON_ROOT, 'src/renderer/components/workspace/tabs/BrowserWorkspaceTab.vue')
const PROJECT_APP_WORKSPACE_TAB_PATH = path.join(ELECTRON_ROOT, 'src/renderer/components/workspace/tabs/ProjectAppWorkspaceTab.vue')
const PAGE_AUTOMATION_TYPES_PATH = path.join(ELECTRON_ROOT, 'src/shared/page-automation-types.ts')

// The Electron host catalog is intentionally small: page automation, tab
// management, project/browser opening, and ask_user. Everything else executes
// in Rust. Keep this constant in sync with the contract generator.
const EXPECTED_CONTRACT_TOOL_COUNT = 8

const READ_PAGE_MODES = ['interactive', 'article', 'search_results', 'screenshot', 'diagnostics']
const READ_PAGE_PROPS = ['tab_id', 'full_page', 'max_width', 'format', 'quality', 'clear_diagnostics']
const INTERACT_ACTIONS = [
  'navigate',
  'reload',
  'back',
  'forward',
  'evaluate',
  'wait_for',
  'find',
  'batch',
  'resize',
  'emulate',
  'press_key'
]
const INTERACT_PROPS = ['tab_id', 'ref', 'modifiers', 'actions', 'state', 'url', 'width', 'height', 'reset']
const EMULATE_PROPS = ['media', 'color_scheme', 'reduced_motion', 'user_agent', 'device_scale_factor', 'mobile']
const TYPED_ACTIONS = ['batch', 'wait_for', 'find', 'navigate', 'reload', 'back', 'forward', 'resize']

async function readJson (filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function readText (filePath) {
  return await fs.readFile(filePath, 'utf8')
}

function getContractTool (contract, name) {
  const tool = contract.tools.find(candidate => candidate.name === name)
  assert.ok(tool, `expected the host tool contract to include ${name}`)
  return tool
}

function extractFunctionSection (source, functionName) {
  const marker = `export function ${functionName}`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `expected windows.ts to define ${functionName}`)
  const nextExport = source.indexOf('\nexport ', start + marker.length)
  return source.slice(start, nextExport === -1 ? undefined : nextExport)
}

function sliceBetween (source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `expected source to contain ${startMarker}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `expected source to contain ${endMarker} after ${startMarker}`)
  return source.slice(start, end)
}

test('host tool contract keeps the expected built-in page tool count', async () => {
  const contract = await readJson(CONTRACT_PATH)

  assert.equal(contract.tools.length, EXPECTED_CONTRACT_TOOL_COUNT)
  for (const name of ['read_current_page', 'interact_current_page']) {
    getContractTool(contract, name)
  }
})

test('read_current_page contract covers all read modes and screenshot/diagnostics options', async () => {
  const readPage = getContractTool(await readJson(CONTRACT_PATH), 'read_current_page')
  const properties = readPage.parameters?.properties || {}
  const modes = properties.mode?.enum || []

  for (const mode of READ_PAGE_MODES) {
    assert.ok(modes.includes(mode), `read_current_page mode enum must include ${mode}`)
  }
  for (const property of READ_PAGE_PROPS) {
    assert.ok(properties[property], `read_current_page must expose the ${property} property`)
  }
})

test('interact_current_page contract covers navigation, batch, find, wait and viewport actions', async () => {
  const interactPage = getContractTool(await readJson(CONTRACT_PATH), 'interact_current_page')
  const properties = interactPage.parameters?.properties || {}
  const actions = properties.action?.enum || []

  for (const action of INTERACT_ACTIONS) {
    assert.ok(actions.includes(action), `interact_current_page action enum must include ${action}`)
  }
  for (const property of INTERACT_PROPS) {
    assert.ok(properties[property], `interact_current_page must expose the ${property} property`)
  }
  for (const property of EMULATE_PROPS) {
    assert.ok(properties[property], `interact_current_page must expose the ${property} property for emulate`)
  }
})

test('search result presets match bing, duckduckgo, google and github hosts', () => {
  const cases = [
    ['https://www.bing.com/search?q=opencode', 'bing'],
    ['https://html.duckduckgo.com/html/?q=opencode', 'duckduckgo'],
    ['https://www.google.co.uk/search?q=opencode', 'google'],
    ['https://github.com/search?q=opencode', 'github']
  ]

  for (const [url, expectedId] of cases) {
    const preset = findSearchExtractPreset(url)
    assert.ok(preset, `expected a search extract preset for ${url}`)
    assert.equal(preset.id, expectedId)
  }

  assert.equal(findSearchExtractPreset('https://example.com/search?q=opencode'), null)
  assert.equal(findSearchExtractPreset('not a url'), null)
})

test('windows prompt policy keeps built-in page tools ahead of chrome/playwright MCP', async () => {
  const source = await readText(WINDOWS_PATH)
  const activePagePolicy = extractFunctionSection(source, 'buildActivePagePromptSection')
  const webPolicy = extractFunctionSection(source, 'buildWebCapabilityPolicySection')

  for (const [label, section] of [
    ['active page policy', activePagePolicy],
    ['web capability policy', webPolicy]
  ]) {
    assert.match(section, /screenshot/i, `${label} must mention screenshot`)
    assert.match(section, /diagnostics/i, `${label} must mention diagnostics`)
    assert.match(section, /tab_id/, `${label} must mention tab_id`)
    assert.match(section, /chrome\/playwright/i, `${label} must name chrome/playwright MCP`)
    assert.match(
      section,
      /chrome\/playwright[\s\S]{0,400}(?:CDP-level|CDP network)|(?:CDP-level|CDP network)[\s\S]{0,400}chrome\/playwright/i,
      `${label} must restrict chrome/playwright MCP to CDP-level work`
    )
  }
})

test('BrowserWebView exposes the built-in capture surfaces and real input events', async () => {
  const source = await readText(BROWSER_WEBVIEW_PATH)
  const expose = source.match(/defineExpose\(\s*\{([\s\S]*?)\}\s*\)/)

  assert.ok(expose, 'BrowserWebView must keep a defineExpose block')
  for (const name of ['captureScreenshot', 'captureDiagnostics', 'captureSearchResults']) {
    assert.match(expose[1], new RegExp(`\\b${name}\\b`), `BrowserWebView must expose ${name}`)
  }
  assert.match(source, /sendInputEvent/, 'BrowserWebView must drive real keyboard/mouse input')
})

test('page automation types include the new action and request-mode unions', async () => {
  const source = await readText(PAGE_AUTOMATION_TYPES_PATH)
  const actionUnion = sliceBetween(
    source,
    'export type BrowserAutomationAction =',
    'export interface BrowserAutomationActionResult'
  )

  for (const action of TYPED_ACTIONS) {
    assert.match(
      actionUnion,
      new RegExp(`type:\\s*'${action}'`),
      `BrowserAutomationAction must include ${action}`
    )
  }
  assert.match(source, /PageAutomationSnapshotMode\s*=\s*[^\n]*'search_results'/)
  assert.match(source, /type:\s*'screenshot'/)
  assert.match(source, /type:\s*'diagnostics'/)
})

test('app view embeds project pages with the automation-capable BrowserWebView', async () => {
  const source = await readText(APP_PATH)
  const embeddedTemplate = sliceBetween(source, 'class="embedded-app"', 'class="chat-shell')

  assert.match(embeddedTemplate, /<BrowserWebView/, 'embedded-app template must render BrowserWebView')
  assert.match(
    source,
    /:hide-bar="appState\.kind === 'project'"/,
    'project pages must pass the hidden browser bar flag'
  )
  assert.doesNotMatch(
    source,
    /embedded-app[\s\S]*?<iframe/,
    'embedded-app must not fall back to an iframe project surface'
  )
  assert.match(source, /activeEmbeddedPageSurface/, 'embedded pages must expose an automation surface')
})

test('app view bounds page readiness and queue waits', async () => {
  const source = await readText(APP_PATH)

  assert.match(source, /PAGE_AUTOMATION_HANDLE_WAIT_MS/, 'must bound handle resolution')
  assert.match(source, /PAGE_AUTOMATION_READY_WAIT_MS/, 'must bound readiness')
  assert.match(source, /PAGE_AUTOMATION_QUEUE_TIMEOUT_MS/, 'must bound the automation queue')
  assert.match(source, /handle\.waitForReady\s*\(/, 'must wait on the page handle')

  const queueSection = sliceBetween(source, 'function enqueuePageAutomation', 'function comparablePageUrl')
  assert.match(queueSection, /withTimeout\s*\(/, 'enqueuePageAutomation must wrap queued work in withTimeout')
  assert.match(queueSection, /PAGE_AUTOMATION_QUEUE_TIMEOUT_MS/, 'queue work must use the queue timeout')
})

test('main-process page automation timeout exceeds the renderer queue budget', async () => {
  const source = await readText(MAIN_CONSTANTS_PATH)
  const match = source.match(/export const PAGE_AUTOMATION_REQUEST_TIMEOUT_MS\s*=\s*([0-9_]+)/)

  assert.ok(match, 'expected PAGE_AUTOMATION_REQUEST_TIMEOUT_MS to be defined as a number')
  const timeoutMs = Number(match[1].replaceAll('_', ''))
  assert.ok(Number.isFinite(timeoutMs), 'expected the page automation timeout to be numeric')
  assert.ok(timeoutMs >= 40000, `expected the main-process timeout to be at least 40000ms, got ${timeoutMs}`)
})

test('BrowserWebView keeps hidden chrome and bounded screenshot waits', async () => {
  const source = await readText(BROWSER_WEBVIEW_PATH)

  assert.match(source, /hideBar\?:\s*boolean/, 'BrowserWebView must accept the hideBar prop')
  assert.match(source, /\bwithTimeout\b/, 'BrowserWebView must bound long page operations')
  assert.match(source, /SCREENSHOT_FULL_PAGE_TIMEOUT_MS/, 'full-page screenshots must have a timeout')
  assert.match(source, /SCREENSHOT_VIEWPORT_TIMEOUT_MS/, 'viewport screenshots must have a timeout')
})

test('workspace browser and project tabs register their automation surfaces', async () => {
  for (const [label, filePath] of [
    ['BrowserWorkspaceTab', BROWSER_WORKSPACE_TAB_PATH],
    ['ProjectAppWorkspaceTab', PROJECT_APP_WORKSPACE_TAB_PATH]
  ]) {
    const source = await readText(filePath)

    assert.match(source, /watch\(\s*browserRef/, `${label} must watch its BrowserWebView ref`)
    assert.match(source, /\bnextTick\b/, `${label} must wait for mount before registering`)
    assert.match(source, /\bregisterSurface\b/, `${label} must register a page automation surface`)
  }
})

test('main-process screenshot capture is wrapped in a timeout', async () => {
  const source = await readText(IPC_PATH)
  const captureSection = sliceBetween(
    source,
    'const captured = await withTimeout(',
    'Timed out capturing the page screenshot'
  )

  assert.match(captureSection, /Page\.captureScreenshot/, 'the capture command must be inside withTimeout')
  assert.match(captureSection, /PAGE_SCREENSHOT_CAPTURE_TIMEOUT_MS/, 'the capture command must use the screenshot timeout')
})
