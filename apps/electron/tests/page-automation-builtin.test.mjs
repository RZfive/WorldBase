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
const PRELOAD_PATH = path.join(ELECTRON_ROOT, 'electron/preload.ts')
const ENV_TYPES_PATH = path.join(ELECTRON_ROOT, 'src/env.d.ts')
const MAIN_CONSTANTS_PATH = path.join(ELECTRON_ROOT, 'electron/main-process/constants.ts')
const APP_PATH = path.join(ELECTRON_ROOT, 'src/App.vue')
const BROWSER_WEBVIEW_PATH = path.join(ELECTRON_ROOT, 'src/renderer/components/app/BrowserWebView.vue')
const BROWSER_WORKSPACE_TAB_PATH = path.join(ELECTRON_ROOT, 'src/renderer/components/workspace/tabs/BrowserWorkspaceTab.vue')
const PROJECT_APP_WORKSPACE_TAB_PATH = path.join(ELECTRON_ROOT, 'src/renderer/components/workspace/tabs/ProjectAppWorkspaceTab.vue')
const PAGE_AUTOMATION_TYPES_PATH = path.join(ELECTRON_ROOT, 'src/shared/page-automation-types.ts')
const AGENT_RS_PATH = path.join(REPO_ROOT, 'harness-rs/crates/core/src/agent.rs')
const OPEN_WORKSPACE_TAB_TOOL_PATH = path.join(ELECTRON_ROOT, 'src/main/ai-host/agent/tools/tool-open-workspace-tab.ts')
const OPEN_PROJECT_APP_TOOL_PATH = path.join(ELECTRON_ROOT, 'src/main/ai-host/agent/tools/tool-open-project-app.ts')
const CHAT_PANEL_PATH = path.join(ELECTRON_ROOT, 'src/renderer/components/chat/ChatPanel.vue')
const CHAT_PANEL_CONTAINER_PATH = path.join(ELECTRON_ROOT, 'src/renderer/components/chat/panel/ChatPanelContainer.vue')
const CHAT_PANEL_TYPES_PATH = path.join(ELECTRON_ROOT, 'src/renderer/components/chat/panel/types.ts')
const WORKSPACE_STORE_PATH = path.join(ELECTRON_ROOT, 'src/renderer/components/workspace/workspace-store.ts')

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

test('foreground focus guards and project-preview hints block external browser MCP fallback', async () => {
  const appSource = await readText(APP_PATH)
  assert.match(appSource, /page_tools_foreground_required/, 'App.vue must expose the machine-readable foreground error code')
  assert.match(appSource, /not a missing browser capability/i, 'App.vue must say the foreground guard is not a capability gap')
  assert.match(appSource, /chrome\/playwright MCP as a workaround/i, 'App.vue must forbid chrome/playwright MCP as a workaround')

  const windowsSource = await readText(WINDOWS_PATH)
  const webPolicy = extractFunctionSection(windowsSource, 'buildWebCapabilityPolicySection')
  assert.match(webPolicy, /page_tools_foreground_required/, 'web policy must cover page_tools_foreground_required')
  assert.match(
    webPolicy,
    /page_tools_foreground_required[\s\S]{0,500}(?:never|do not) use chrome\/playwright/i,
    'web policy must forbid chrome/playwright MCP for foreground-gated page tools'
  )
  assert.match(webPolicy, /open_workspace_tab\(kind="project"\)/, 'web policy must route loopback previews to project tabs')
  assert.match(webPolicy, /open_project_app/, 'web policy must offer open_project_app for loopback previews')
  assert.match(
    webPolicy,
    /localhost[\s\S]{0,200}not a capability gap|kind="browser"[\s\S]{0,300}not a capability gap/i,
    'web policy must say a localhost browser-tab rejection is not a capability gap'
  )

  const agentSource = await readText(AGENT_RS_PATH)
  const webToolsPrompt = sliceBetween(agentSource, 'fn web_tools_prompt', 'fn computer_use_prompt')
  assert.match(webToolsPrompt, /page_tools_foreground_required/, 'agent.rs web prompt must carry the foreground rule')
  assert.match(
    webToolsPrompt,
    /open_workspace_tab[\s\S]{0,300}open_project_app/,
    'agent.rs web prompt must carry the loopback project-preview rule'
  )

  const toolSource = await readText(OPEN_WORKSPACE_TAB_TOOL_PATH)
  assert.match(toolSource, /browser URL rejected:[\s\S]{0,300}kind="project"[\s\S]{0,200}open_project_app/, 'open_workspace_tab rejection must suggest the project-preview path')
  assert.match(toolSource, /external browser MCP/i, 'open_workspace_tab rejection must forbid external browser MCP fallback')
})

test('App mounts hidden background page hosts and routes background page requests', async () => {
  const source = await readText(APP_PATH)

  assert.match(source, /class="background-page-hosts"/, 'App.vue must render the hidden background host container')
  assert.match(source, /aria-hidden="true" inert/, 'background hosts must stay hidden from the user and accessibility tree')
  assert.match(source, /\bbackgroundHostSpecs\b/, 'App.vue must track background host specs')
  assert.match(source, /:allow-popups="false"/, 'background hosts must disable popups')
  assert.match(source, /function handleBackgroundWorkspaceTabOpened\s*\(/, 'App.vue must define the background tab handler')
  assert.match(
    source,
    /@background-workspace-tab-opened="handleBackgroundWorkspaceTabOpened"/,
    'App.vue must subscribe to the background tab event'
  )
  assert.match(source, /page_tools_background_host_missing/, 'App.vue must expose the missing-host error code')
  assert.match(source, /function waitForBackgroundHostHandle\s*\(/, 'background actions must wait for the host handle')
  assert.match(source, /validateAiBrowserTarget\(finalUrl\)/, 'background browser pages must revalidate their final URL')

  const routingIndex = source.indexOf('handleBackgroundPageAutomationRequest(payload, requestedConversationId, respond)')
  const foregroundGuardIndex = source.indexOf('page_tools_foreground_required')
  assert.notEqual(routingIndex, -1, 'page automation requests must route to the background host handler')
  assert.notEqual(foregroundGuardIndex, -1, 'App.vue must keep the foreground guard')
  assert.ok(routingIndex < foregroundGuardIndex, 'background routing must run before the foreground guard')

  const hostSection = sliceBetween(
    source,
    'function handleBackgroundWorkspaceTabOpened',
    'watch(chatCurrentConversationId'
  )
  assert.match(hostSection, /spec\.tabId = tabId/, 'background specs must remember the opened tab id')
  assert.match(hostSection, /host\.tabId = tabId/, 'opened background tabs must attach their tab id to the host')
})

test('background workspace tab events cover page kinds only on open and activate', async () => {
  const container = await readText(CHAT_PANEL_CONTAINER_PATH)
  const emissions = container.match(/emit\('backgroundWorkspaceTabOpened'/g) || []
  assert.equal(emissions.length, 1, 'the background tab event must be emitted from exactly one helper')

  const helper = sliceBetween(
    container,
    'function emitBackgroundWorkspaceTabOpened',
    'function handleBackgroundWorkspaceTabRequest'
  )
  assert.match(
    helper,
    /entry\.kind !== 'browser' && entry\.kind !== 'project'/,
    'only browser/project tabs may open a background host'
  )
  assert.match(
    helper,
    /buildSnapshotTabSummary\(entry, state\.activeTabId\)/,
    'background events must summarize the resulting active snapshot tab'
  )

  const openSection = sliceBetween(
    container,
    'function handleBackgroundWorkspaceTabRequest',
    'function handleBackgroundWorkspaceControl'
  )
  assert.match(
    openSection,
    /emitBackgroundWorkspaceTabOpened\(conversationId, state\)/,
    'background opens must emit the tab event'
  )

  const controlSection = sliceBetween(
    container,
    'function handleBackgroundWorkspaceControl',
    '// AI-originated requests arrive'
  )
  assert.match(controlSection, /request\.action === 'activate'/, 'background controls may emit only for activate')
  assert.match(
    controlSection,
    /emitBackgroundWorkspaceTabOpened\(conversationId, outcome\)/,
    'background activate must emit the tab event'
  )

  const chatPanel = await readText(CHAT_PANEL_PATH)
  assert.match(
    chatPanel,
    /@background-workspace-tab-opened="payload => emit\('backgroundWorkspaceTabOpened', payload\)"/,
    'ChatPanel.vue must forward the background tab event to App'
  )

  const types = await readText(CHAT_PANEL_TYPES_PATH)
  assert.match(types, /interface BackgroundWorkspaceTabOpenedPayload/, 'types.ts must declare the event payload')
  const payloadSection = sliceBetween(
    types,
    'export interface BackgroundWorkspaceTabOpenedPayload',
    '}\n\n/**'
  )
  for (const field of ['conversationId: string', 'tabId: string', 'kind: string', 'title?: string', 'url?: string', 'projectId?: string']) {
    assert.ok(payloadSection.includes(field), `background tab payload must include ${field}`)
  }
  assert.match(
    types,
    /\(e: 'backgroundWorkspaceTabOpened', payload: BackgroundWorkspaceTabOpenedPayload\): void/,
    'ChatPanelEmit must type the background tab event'
  )

  const store = await readText(WORKSPACE_STORE_PATH)
  assert.match(
    store,
    /export function buildSnapshotTabSummary\s*\(/,
    'workspace-store must export the snapshot summary helper'
  )
})

test('background hosts disable popups, keep running offscreen, and carry conversation ids', async () => {
  const webview = await readText(BROWSER_WEBVIEW_PATH)
  assert.match(webview, /allowPopups\?: boolean/, 'BrowserWebView must accept allowPopups')
  assert.match(webview, /backgroundThrottling=no/, 'BrowserWebView must keep offscreen hosts unthrottled')
  assert.match(
    webview,
    /:allowpopups="props\.allowPopups === false \? undefined : ''"/,
    'allowPopups=false must remove the webview allowpopups attribute'
  )

  const toolSource = await readText(OPEN_PROJECT_APP_TOOL_PATH)
  assert.match(toolSource, /conversationId\?: string/, 'open_project_app must accept the run conversation id')
  assert.match(
    toolSource,
    /project:openInShell'[\s\S]{0,200}conversationId/,
    'project:openInShell must carry conversationId so background opens stay hidden'
  )
})

test('background host continuity falls back to the last live surface', async () => {
  const source = await readText(APP_PATH)
  for (const token of [
    'lastPageSurfaceByConversation',
    'recordLastPageSurface',
    'page_tools_background_tab_missing',
    'pruneBackgroundPageTargets',
    ':background-host="true"'
  ]) {
    assert.ok(source.includes(token), `App.vue must contain ${token}`)
  }

  const recordSection = sliceBetween(
    source,
    'function recordLastPageSurface',
    'function getOrCreateBackgroundHostSpecFromLastSurface'
  )
  assert.match(
    recordSection,
    /lastPageSurfaceByConversation\.value\.set\(conversationId, entry\)/,
    'the active page surface must be remembered per conversation'
  )
  assert.match(source, /recordLastPageSurface,\s*\{ immediate: true \}/, 'last-surface recording must run on every surface change')

  const lastSpecSection = sliceBetween(
    source,
    'function getOrCreateBackgroundHostSpecFromLastSurface',
    'function resolveBackgroundAutomationTarget'
  )
  assert.match(
    lastSpecSection,
    /tabId && last\.tabId !== tabId/,
    'last-surface fallback must not serve a different requested tab id'
  )

  const backgroundHandler = sliceBetween(
    source,
    'async function handleBackgroundPageAutomationRequest',
    'async function handlePageAutomationRequest'
  )
  assert.match(
    backgroundHandler,
    /getOrCreateBackgroundHostSpecFromLastSurface\(conversationId, requestedTabId\)/,
    'a background page request must fall back to the conversation last surface'
  )
  assert.match(
    backgroundHandler,
    /page_tools_background_tab_missing/,
    'an unmatched explicit tab id must return the tab-missing error'
  )
})

test('background automation rejects unmatched tab ids and prunes on the closed-tab event', async () => {
  const source = await readText(APP_PATH)
  const resolveSection = sliceBetween(
    source,
    'function resolveBackgroundAutomationTarget',
    'async function waitForBackgroundHostHandle'
  )
  const tabIdStart = resolveSection.indexOf('if (tabId) {')
  assert.notEqual(tabIdStart, -1, 'target resolution must branch on an explicit tab id')
  const tabIdEnd = resolveSection.indexOf('\n  }', tabIdStart)
  assert.notEqual(tabIdEnd, -1, 'expected the explicit tab-id branch to close')
  const tabIdBlock = resolveSection.slice(tabIdStart, tabIdEnd)

  assert.match(tabIdBlock, /return null/, 'an unmatched explicit tab id must fail instead of falling through')
  assert.doesNotMatch(tabIdBlock, /latestBackgroundHost\(hosts\)/, 'explicit tab ids must not fall back to the latest host')
  assert.doesNotMatch(tabIdBlock, /latestBackgroundSpec\(specs\)/, 'explicit tab ids must not fall back to the latest spec')

  const pruneSection = sliceBetween(
    source,
    'function pruneBackgroundPageTargets',
    'function findBackgroundHostSpecFor'
  )
  assert.match(pruneSection, /backgroundHostSpecs\.value\.delete\(spec\.key\)/, 'close pruning must drop the spec')
  assert.match(pruneSection, /backgroundHosts\.value\.delete\(host\.id\)/, 'close pruning must drop the host')
  assert.match(
    pruneSection,
    /lastPageSurfaceByConversation\.value\.delete\(conversationId\)/,
    'close pruning must drop the remembered surface'
  )

  const closedHandler = sliceBetween(
    source,
    'function handleBackgroundWorkspaceTabClosed',
    'watch(chatCurrentConversationId'
  )
  assert.match(
    closedHandler,
    /pruneBackgroundPageTargets\(conversationId, \{ action: 'close', tabId/,
    'the closed-tab event must prune by the reported tab id'
  )
  assert.match(
    source,
    /@background-workspace-tab-closed="handleBackgroundWorkspaceTabClosed"/,
    'App.vue must subscribe to the closed-tab event'
  )

  const chatPanel = await readText(CHAT_PANEL_PATH)
  assert.match(
    chatPanel,
    /@background-workspace-tab-closed="payload => emit\('backgroundWorkspaceTabClosed', payload\)"/,
    'ChatPanel.vue must forward the closed-tab event to App'
  )
})

test('background hosts keep hidden pages muted and unfocused', async () => {
  const source = await readText(BROWSER_WEBVIEW_PATH)
  assert.match(source, /backgroundHost\?: boolean/, 'BrowserWebView must accept the backgroundHost flag')
  assert.match(source, /backgroundHost: false/, 'backgroundHost must default to false for foreground pages')
  assert.match(source, /setAudioMuted/, 'background hosts must mute their guest audio')

  const focusSection = sliceBetween(
    source,
    'function focusWebviewForInput',
    'function webviewZoomFactor'
  )
  assert.match(focusSection, /if \(props\.backgroundHost\) return/, 'background hosts must not steal focus')
  assert.match(focusSection, /webview\.focus/, 'foreground pages must still focus for real input')

  const mediaSection = sliceBetween(
    source,
    'function applyBackgroundHostMediaPolicy',
    'function focusWebviewForInput'
  )
  assert.match(mediaSection, /setAudioMuted\?\.\(true\)/, 'the media policy must mute background guests')

  const attachSection = sliceBetween(source, 'function attachWebviewListeners', 'let detachListeners')
  const mediaCalls = attachSection.match(/applyBackgroundHostMediaPolicy\(webview\)/g) || []
  assert.ok(mediaCalls.length >= 2, 'the media policy must run on attach and again on dom-ready')
})

test('background host policy keeps page tools off chrome/playwright fallback', async () => {
  const windowsSource = await readText(WINDOWS_PATH)
  const webPolicy = extractFunctionSection(windowsSource, 'buildWebCapabilityPolicySection')
  assert.match(webPolicy, /hidden background host/i, 'web policy must mention the hidden background host')
  assert.match(webPolicy, /page_tools_background_host_missing/, 'web policy must cover the missing-host error')
  assert.match(
    webPolicy,
    /never use chrome\/playwright MCP as a workaround/i,
    'web policy must forbid chrome/playwright MCP as the background fallback'
  )

  const agentSource = await readText(AGENT_RS_PATH)
  const webToolsPrompt = sliceBetween(agentSource, 'fn web_tools_prompt', 'fn computer_use_prompt')
  assert.match(webToolsPrompt, /hidden background host/i, 'agent.rs web prompt must mention the hidden background host')
  assert.match(webToolsPrompt, /page_tools_background_host_missing/, 'agent.rs web prompt must cover the missing-host error')
  assert.match(
    webToolsPrompt,
    /never use chrome\/playwright MCP as a workaround/i,
    'agent.rs web prompt must forbid chrome/playwright MCP as the background fallback'
  )
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

test('BrowserWebView rebuilds a timed-out screenshot host once with recovery budget', async () => {
  const source = await readText(BROWSER_WEBVIEW_PATH)
  assert.match(source, /:key="webviewGeneration"/, 'the screenshot recovery must replace the webview host')
  assert.match(source, /:src="currentUrl"/, 'the replacement host must retain the current page URL')

  const recovery = sliceBetween(source, 'const SCREENSHOT_RECOVERY_BUDGET_MS', 'interface WebviewLoadWaiter')
  assert.match(recovery, /detachListeners\?\.\(\)/, 'recovery must detach listeners from the old host')
  assert.match(recovery, /webviewGeneration\.value \+= 1/, 'recovery must mount a fresh host')
  assert.match(recovery, /readyState === "interactive" \|\| readyState === "complete"/, 'recovery must wait for a usable replacement document')
  assert.match(recovery, /isScreenshotTimeoutError/, 'only screenshot timeouts should enter host recovery')
  assert.match(recovery, /return await captureAttempt\(timeoutMs\)/, 'the first capture must retain the existing path')
  assert.match(recovery, /await captureAttempt\(retryTimeoutMs\)/, 'recovery must retry the capture once on the new host')
  assert.match(recovery, /page was reloaded and its emulation was reset/, 'the recovery result must disclose the reset page state')

  const app = await readText(APP_PATH)
  const budget = sliceBetween(app, 'function extractUserTimeoutMs', 'function comparablePageUrl')
  assert.match(budget, /request\.timeoutMs \+ PAGE_SCREENSHOT_RECOVERY_BUDGET_MS/, 'the page request must leave time for host recovery')
  assert.match(budget, /Math\.min\(PAGE_AUTOMATION_QUEUE_TIMEOUT_MS/, 'the recovery budget must stay within the main-process request limit')
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

test('main-process page automation covers native keys, network logs, viewport screenshots and timeouts', async () => {
  const source = await readText(IPC_PATH)

  assert.match(source, /ipcMain\.handle\('pageAutomation:dispatchKey'/, 'ipc.ts must expose native page key dispatch')
  assert.match(source, /ipcMain\.handle\('pageAutomation:getNetworkLog'/, 'ipc.ts must expose the browser network log')

  const recorder = sliceBetween(
    source,
    'function registerBrowserNetworkRecorder',
    'function withTimeout'
  )
  assert.match(recorder, /webRequest\.onBeforeRequest/, 'the network recorder must capture request start timestamps')
  const beforeRequest = sliceBetween(
    recorder,
    'browserSession.webRequest.onBeforeRequest',
    'browserSession.webRequest.onCompleted'
  )
  assert.match(beforeRequest, /\(details, callback\)/, 'the before-request listener must accept Electron\'s continuation callback')
  assert.match(beforeRequest, /callback\(\{\}\)/, 'the before-request listener must release every intercepted request')
  assert.doesNotMatch(beforeRequest, /if \(!webContentsId\) return/, 'an unknown guest must not skip the request continuation')
  assert.match(recorder, /webRequest\.onCompleted/, 'the network recorder must capture completed requests')
  assert.match(recorder, /webRequest\.onErrorOccurred/, 'the network recorder must capture failed requests')
  assert.match(recorder, /appendBrowserNetworkEntry/, 'the network recorder must buffer entries per guest')
  assert.match(recorder, /recordBrowserNetworkRequestStart/, 'the network recorder must record per-request start times')
  const durationCalls = recorder.match(/takeBrowserNetworkRequestDurationMs\(webContentsId, details\.id, details\.timestamp\)/g) || []
  assert.equal(durationCalls.length, 2, 'completed and failed entries must both derive durationMs from the tracked start time')
  assert.doesNotMatch(recorder, /durationMs:\s*null/, 'no recorder branch may hardcode durationMs to null')

  const screenshot = sliceBetween(
    source,
    "ipcMain.handle('pageAutomation:captureScreenshot'",
    "ipcMain.handle('pageAutomation:dispatchKey'"
  )
  assert.match(screenshot, /request\.fullPage === true/, 'screenshot capture must distinguish viewport and full-page modes')
  assert.match(screenshot, /fromSurface:\s*true/, 'screenshot capture must use the rendered page surface')
  assert.match(screenshot, /captureBeyondViewport:\s*false/, 'viewport screenshots must not capture beyond the viewport')
  assert.match(screenshot, /captureBeyondViewport\s*=\s*true/, 'full-page screenshots must expand beyond the viewport')
  assert.match(screenshot, /cssLayoutViewport/, 'viewport screenshots must size themselves from the layout viewport')
  assert.match(screenshot, /request\.timeoutMs/, 'screenshot capture must honor the requested timeout')
  assert.match(screenshot, /PAGE_SCREENSHOT_MAX_OPERATION_TIMEOUT_MS/, 'screenshot capture must clamp the timeout')
})

test('preload and renderer types expose native key dispatch and network logs', async () => {
  for (const [label, filePath] of [
    ['preload', PRELOAD_PATH],
    ['env types', ENV_TYPES_PATH]
  ]) {
    const source = await readText(filePath)
    assert.match(source, /dispatchBrowserPageKey/, `${label} must expose dispatchBrowserPageKey`)
    assert.match(source, /getBrowserPageNetworkLog/, `${label} must expose getBrowserPageNetworkLog`)
  }

  const preload = await readText(PRELOAD_PATH)
  assert.match(preload, /pageAutomation:dispatchKey/, 'preload must bridge pageAutomation:dispatchKey')
  assert.match(preload, /pageAutomation:getNetworkLog/, 'preload must bridge pageAutomation:getNetworkLog')
})

test('BrowserWebView uses native key, network and screenshot bridges with array wait text', async () => {
  const source = await readText(BROWSER_WEBVIEW_PATH)

  assert.match(source, /window\.electronAPI\?\.dispatchBrowserPageKey/, 'BrowserWebView must dispatch real keys natively')
  assert.match(source, /window\.electronAPI\?\.getBrowserPageNetworkLog/, 'BrowserWebView must merge the native network log')
  assert.match(source, /window\.electronAPI\?\.captureBrowserPageScreenshot/, 'BrowserWebView must use the main-process screenshot bridge')

  const screenshot = sliceBetween(
    source,
    'async function captureScreenshot',
    'interface WebviewLoadWaiter'
  )
  assert.match(screenshot, /captureBrowserPageScreenshot/, 'screenshots must prefer the main-process bridge')
  assert.match(screenshot, /fullPage,/, 'the screenshot bridge must receive the fullPage flag')
  assert.match(screenshot, /timeoutMs,/, 'the screenshot bridge must receive the adjustable timeout')
  assert.match(screenshot, /fullPage: false/, 'the viewport fallback must report fullPage false')

  const diagnostics = sliceBetween(source, 'async function captureDiagnostics', 'function dedupeConsoleEntries')
  assert.match(diagnostics, /performance\.getEntriesByType\('navigation'\)/, 'diagnostics must include document navigation transfer sizes')
  assert.match(diagnostics, /performance\.getEntriesByType\('resource'\)/, 'diagnostics must include subresource transfer sizes')
  const merge = sliceBetween(source, 'function mergeDiagnosticsNetwork', 'function isResourceLikeEntry')
  assert.match(merge, /transferSize:\s*preferred\.transferSize \?\? fallback\.transferSize \?\? null/, 'dedupe must preserve a measured transfer size from either entry')

  assert.match(
    source,
    /function waitTextValues\(value: string \| string\[\] \| undefined\)/,
    'wait_for must accept array text'
  )
  assert.match(source, /Array\.isArray\(value\) \? value : value \? \[value\] : \[\]/, 'wait text must normalize strings and arrays')
  assert.match(source, /waitTextValues\(action\.text\)/, 'wait_for must route text through the array-aware helper')
})

test('App forwards the screenshot timeout to the page handle', async () => {
  const source = await readText(APP_PATH)
  const screenshot = sliceBetween(
    source,
    "if (request.type === 'screenshot')",
    "if (request.type === 'diagnostics')"
  )

  assert.match(screenshot, /fullPage:\s*request\.fullPage/, 'screenshots must keep the fullPage flag')
  assert.match(screenshot, /maxWidth:\s*request\.maxWidth/, 'screenshots must keep maxWidth')
  assert.match(screenshot, /format:\s*request\.format/, 'screenshots must keep format')
  assert.match(screenshot, /quality:\s*request\.quality/, 'screenshots must keep quality')
  assert.match(screenshot, /timeoutMs:\s*request\.timeoutMs/, 'screenshots must forward the adjustable timeout')
})

test('BrowserWebView settles animation frames with a timer fallback in hidden hosts', async () => {
  const source = await readText(BROWSER_WEBVIEW_PATH)
  const raf = sliceBetween(
    source,
    'function nextAnimationFrame()',
    'async function measurePageViewport'
  )

  assert.match(raf, /window\.requestAnimationFrame/, 'nextAnimationFrame must still request a real frame')
  assert.match(raf, /window\.setTimeout\(settle, 32\)/, 'hidden host windows must get a timer fallback so the wait can settle')
  assert.match(raf, /window\.clearTimeout\(fallbackTimer\)/, 'the frame callback must clear the fallback timer')
})

test('emulate actions honor the action timeout end to end', async () => {
  const source = await readText(BROWSER_WEBVIEW_PATH)
  const wrapper = sliceBetween(
    source,
    'async function runEmulationAction(',
    'async function runEmulationActionWithinBudget'
  )

  assert.match(wrapper, /Number\(action\.timeoutMs\)/, 'the emulate wrapper must derive its budget from action.timeoutMs')
  assert.match(wrapper, /withTimeout\(runEmulationActionWithinBudget\(action\), timeoutMs/, 'the whole emulate action must run under one timeout')
  assert.match(
    source,
    /runEmulationActionWithinBudget\(action\)/,
    'the unbounded emulation body must be extracted behind the bounded wrapper'
  )
})

test('page emulation serializes per-surface operations and drops stale rollbacks', async () => {
  const source = await readText(IPC_PATH)
  const operations = sliceBetween(
    source,
    'interface PageEmulationTargetOperations',
    'function pageDebuggerIsAttached'
  )

  assert.match(operations, /const pageEmulationTargetOperations = new Map/, 'operations must be tracked per page surface')
  assert.match(operations, /invalidatePageEmulationOperations/, 'resets must be able to invalidate older operations')
  assert.match(operations, /operations\.queue = run\.then/, 'each operation must advance the per-surface queue')
  assert.match(operations, /operations\.generation === generation/, 'an operation must know when it has been superseded')

  const reset = sliceBetween(source, "if (request.reset === true) {", 'const hasOverrides =')
  assert.match(
    reset,
    /invalidatePageEmulationOperations\(webContentsId\)[\s\S]*return await enqueuePageEmulationOperation/,
    'a reset must invalidate running emulation before it is queued'
  )
  assert.match(reset, /assertPageEmulationCurrent\(isCurrent\)/, 'an in-flight reset must stop once superseded')
  assert.match(reset, /resetPageEmulationMedia/, 'reset must run through the verified media reset helper')
  assert.match(reset, /closePageEmulationSession/, 'a completed reset must drop the old debugger session')

  const emulate = sliceBetween(source, 'const hasOverrides = request.media', "ipcMain.on('pageAutomation:response'")
  assert.match(emulate, /enqueuePageEmulationOperation/, 'emulate must run inside the per-surface queue')
  assert.match(
    emulate,
    /applyPageEmulation\(session\.debugger, nextState, request\.timeoutMs, \{ isCurrent \}\)/,
    'emulate must stop applying once a reset supersedes it'
  )
  assert.match(
    emulate,
    /if \(!\(error instanceof PageEmulationSupersededError\) && isCurrent\(\)\)/,
    'a superseded emulate must not roll the old state back'
  )
  assert.match(
    emulate,
    /if \(addedEmulationRef && isCurrent\(\)\)/,
    'refs from a superseded emulate must be left to the reset'
  )
})

test('page emulation reset clears named features and verifies the system baseline', async () => {
  const source = await readText(IPC_PATH)
  const apply = sliceBetween(source, 'async function applyPageEmulation', 'interface PageMediaState')
  assert.match(apply, /clearNamedMediaFeatures/, 'reset must use the explicit feature-clear path')
  assert.match(apply, /\{ name: 'prefers-color-scheme', value: '' \}/, 'reset must clear prefers-color-scheme by name')
  assert.match(apply, /\{ name: 'prefers-reduced-motion', value: '' \}/, 'reset must clear prefers-reduced-motion by name')

  const mediaExpression = sliceBetween(source, 'const PAGE_MEDIA_STATE_EXPRESSION', 'function readSystemMediaBaseline')
  assert.match(mediaExpression, /prefers-color-scheme: dark/, 'reset verification must read the live color scheme')
  assert.match(mediaExpression, /prefers-reduced-motion: reduce/, 'reset verification must read the live reduced-motion state')

  const baseline = sliceBetween(source, 'function readSystemMediaBaseline', 'async function readPageMediaState')
  assert.match(baseline, /nativeTheme\.shouldUseDarkColors/, 'the expected color scheme must come from the system theme')
  assert.match(baseline, /prefersReducedMotion/, 'the expected reduced-motion state must come from the system')

  const reset = sliceBetween(source, 'async function resetPageEmulationMedia', 'function toEmulatedResult')
  assert.match(
    reset,
    /applyPageEmulation\(debuggerSession, \{\}, timeoutMs, \{/,
    'reset must clear overrides instead of forcing a color scheme'
  )
  assert.match(reset, /clearAndVerify/, 'reset must verify the page media state after clearing')
  assert.match(reset, /rebuildPageEmulationSession/, 'an unverified reset must rebuild the debugger session')
  assert.match(
    reset,
    /closePageEmulationSession\(webContentsId, rebuilt\)/,
    'the final fallback must detach instead of forcing a light theme'
  )
  assert.doesNotMatch(reset, /themeSource\s*=/, 'reset must not force the app theme source')

  const close = sliceBetween(source, 'function closePageEmulationSession', 'function releasePageEmulationSessionRef')
  assert.match(close, /session\.debugger\.detach\(\)/, 'closing a reset session must detach even while screenshot refs remain')
})

test('page tool contract exposes snapshot, timeout and array wait text', async () => {
  const contract = await readJson(CONTRACT_PATH)

  const interact = getContractTool(contract, 'interact_current_page')
  const interactProps = interact.parameters?.properties || {}
  assert.ok(interactProps.include_snapshot, 'interact_current_page must expose include_snapshot')
  assert.equal(interactProps.include_snapshot.type, 'boolean', 'include_snapshot must be boolean')
  assert.ok(interactProps.timeout, 'interact_current_page must expose timeout')
  assert.ok(interactProps.timeout_ms, 'interact_current_page must expose timeout_ms')

  const textBranches = (interactProps.text?.oneOf || []).map(branch => branch.type)
  assert.ok(textBranches.includes('string'), 'wait_for text must accept a string')
  assert.ok(textBranches.includes('array'), 'wait_for text must accept an array')
  const textArray = (interactProps.text?.oneOf || []).find(branch => branch.type === 'array')
  assert.equal(textArray?.items?.type, 'string', 'wait_for text array items must be strings')

  const read = getContractTool(contract, 'read_current_page')
  const readProps = read.parameters?.properties || {}
  assert.ok(readProps.timeout, 'read_current_page must expose screenshot timeout')
  assert.ok(readProps.timeout_ms, 'read_current_page must expose screenshot timeout_ms')
  assert.match(String(readProps.timeout.description || ''), /screenshot/i, 'read timeout must be screenshot-scoped')
  assert.match(String(readProps.timeout_ms.description || ''), /screenshot/i, 'read timeout_ms must be screenshot-scoped')
})
