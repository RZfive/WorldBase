import { app, ipcMain, shell } from 'electron'
import path from 'node:path'
import type { AIEngineServices } from '../../src/main/ai-engine/engine-contracts.js'
import { RustHarnessEngine } from '../../src/main/ai-harness/rust-harness-engine.js'
import { ProjectFS } from '../../src/main/project-fs/project-fs.js'
import { ProjectPackageService } from '../../src/main/project-fs/project-package-service.js'
import { RuntimeManager } from '../../src/main/project-runtime/runtime-manager.js'
import { BuilderService } from '../../src/main/project-runtime/builder-service.js'
import { AppGateway, type RestartPolicy, type ServiceEntry } from '../../src/main/project-runtime/app-gateway.js'
import { UpdateService } from '../../src/main/app-update/update-service.js'
import { ProcessManagerService } from '../../src/main/project-runtime/process-manager-service.js'
import { ProjectApiClient } from '../../src/main/project-api-bridge/api-client.js'
import { ProjectDataAccess } from '../../src/main/project-data-access/data-access.js'
import { SqliteAdapter } from '../../src/main/project-data-access/adapters/sqlite-adapter.js'
import { LanServer } from '../../src/main/lan-server/server.js'
import type { LanProjectControl } from '../../src/main/lan-server/routes/projects.js'
import { LAN_SERVER_PORT } from '../../src/main/constants.js'
import { SystemService, type HarnessProjectRuntimeSnapshot } from '../../src/main/system-capabilities/system-service.js'
import { SettingsStore } from '../../src/main/settings/settings-store.js'
import { ChatHistoryStore } from '../../src/main/settings/chat-history.js'
import { AILogStore } from '../../src/main/settings/ai-log-store.js'
import { ImageLibraryStore } from '../../src/main/settings/image-library-store.js'
import { StudioTaskStore } from '../../src/main/settings/studio-task-store.js'
import { UsageStore } from '../../src/main/settings/usage-store.js'
import { SkillStore } from '../../src/main/settings/skill-store.js'
import { AgentStore } from '../../src/main/settings/agent-store.js'
import { AgentGroupStore } from '../../src/main/settings/agent-group-store.js'
import { ScheduledTaskStore, type ScheduledTaskDefinition, type ScheduledTaskRunReport } from '../../src/main/settings/scheduled-task-store.js'
import { LongTermGoalStore } from '../../src/main/settings/long-term-goal-store.js'
import { ChannelBindingStore } from '../../src/main/im/channel-binding-store.js'
import { ImGatewayService } from '../../src/main/im/im-gateway-service.js'
import { AsyncTaskManager } from '../../src/main/ai-engine/agent/tools/async-task-manager.js'
import { DocumentStore } from '../../src/main/ai-engine/agent/tools/document-store.js'
import { MCPService, type MCPServerSnapshot, type MCPStateSnapshot } from '../../src/main/mcp/mcp-service.js'
import { ScheduledTaskService } from '../../src/main/scheduler/scheduled-task-service.js'
import { LongTermGoalService } from '../../src/main/long-term-goals/long-term-goal-service.js'
import { DailySuggestionStore } from '../../src/main/settings/daily-suggestion-store.js'
import { DailySuggestionService, type SuggestionProjectContext } from '../../src/main/suggestions/daily-suggestion-service.js'
import { getMainLocale } from '../../src/main/i18n/main-i18n.js'
import type { AppUpdateState } from '../../src/shared/app-update-types.js'
import type { BrowserAutomationAction, BrowserAutomationActionResult, BrowserAutomationSnapshot } from '../../src/shared/page-automation-types.js'
import type { MCPServerConfig } from '../../src/main/settings/settings-store.js'
import type { AgentDefinition, AgentGroupDefinition } from '../../src/shared/agent-workspace-types.js'
import { mainState } from './state.js'
import { applyActiveProviderToAiEngine, notifyAgentWorkspaceChanged, resolveProviderConfig } from './ai/agent-context.js'
import { getSelectedExecutionEngine, startSelectedRustHarness } from './ai/selected-execution-engine.js'

import { enqueueStudioImageTasks } from './media/image-studio-queue.js'
import { generateImGatewayReply } from './ai/im-replies.js'
import { normalizeRustAskUserQuestions, normalizeRustAskUserResponse } from './ai/rust-ask-user-contract.js'
import { broadcastToAppWindows, getActiveAiRequestWindow, getProjectsDir, getSnapshotsDir, requestPageAutomationFromRenderer } from './windows.js'
import { migrateUserDataForRename } from './user-data-migration.js'
import { RustHarnessClient, type JsonRpcResult, type RustHostRequest } from './rust-harness-client.js'
import { buildDocumentRenderPreview, readDocumentRenderAsset } from '../../src/main/document-preview/document-render-service.js'
import type { DocumentFileType } from '../../src/main/ai-engine/agent/tools/document-types.js'

let electronMcpParkedForRust = false

function recordsFromRustValue (value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
}

function optionalString (record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' && record[key].trim() ? record[key] : undefined
}

function optionalNumber (record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : undefined
}

/**
 * Project process state is native once Rust is selected. Electron still
 * samples host-only metrics in SystemService, but never consults the dormant
 * RuntimeManager/AppGateway for the project's part of that snapshot.
 */
async function resolveRustProjectRuntimeSnapshot (): Promise<HarnessProjectRuntimeSnapshot | null> {
  const engine = await startSelectedRustHarness()
  const client = engine ? mainState.rustHarness : null
  if (!client) return null

  const [rawServiceMap, rawProcessSnapshot] = await Promise.all([
    client.call<Record<string, unknown>>('project.gateway.serviceMap'),
    client.call<Record<string, unknown>>('project.process.snapshot')
  ])
  const serviceEntries: ServiceEntry[] = recordsFromRustValue(rawServiceMap.services).map(service => ({
    projectId: optionalString(service, 'projectId') || '',
    name: optionalString(service, 'name') || optionalString(service, 'projectId') || '',
    port: optionalNumber(service, 'port') || 0,
    status: optionalString(service, 'status') || 'not_started',
    pid: optionalNumber(service, 'pid'),
    startedAt: optionalString(service, 'startedAt'),
    framework: optionalString(service, 'framework'),
    restartPolicy: (service.restartPolicy === 'always' || service.restartPolicy === 'never'
      ? service.restartPolicy
      : 'on-failure') as RestartPolicy,
    restartCount: optionalNumber(service, 'restartCount') || 0
  })).filter(service => service.projectId)
  const projectProcesses = recordsFromRustValue(rawProcessSnapshot.managed).map(process => ({
    projectId: optionalString(process, 'projectId') || '',
    status: optionalString(process, 'status') || 'unknown',
    port: optionalNumber(process, 'port'),
    pid: optionalNumber(process, 'pid'),
    startedAt: optionalString(process, 'startedAt'),
    uptimeSeconds: optionalNumber(process, 'uptimeSeconds'),
    exitCode: typeof process.exitCode === 'number' || process.exitCode === null ? process.exitCode : undefined,
    error: optionalString(process, 'error')
  })).filter(process => process.projectId)

  return {
    services: {
      services: serviceEntries,
      totalRunning: serviceEntries.filter(service => service.status === 'running').length,
      totalStopped: serviceEntries.filter(service => service.status !== 'running' && service.status !== 'crashed' && service.status !== 'error').length,
      totalCrashed: serviceEntries.filter(service => service.status === 'crashed' || service.status === 'error').length
    },
    projectProcesses
  }
}

async function selectedRustMcpClient (): Promise<RustHarnessClient | null> {
  const engine = await startSelectedRustHarness()
  return engine ? mainState.rustHarness : null
}

async function parkElectronMcpForRust (): Promise<void> {
  if (electronMcpParkedForRust || !mainState.mcpService) return
  await mainState.mcpService.dispose()
  electronMcpParkedForRust = true
}

/**
 * Apply the durable Electron MCP catalog to the selected harness. Rust mode
 * owns configured transport connections; Electron's MCPService remains a
 * platform adapter for fixed host tools and the frozen TS compatibility path,
 * and its background connections are parked before Rust takes ownership.
 */
export async function applyMcpServersToService (): Promise<MCPServerConfig[]> {
  const servers = mainState.settingsStore!.getMcpServers()
  let rust: RustHarnessClient | null
  try {
    rust = await selectedRustMcpClient()
  } catch (error) {
    // Startup may continue far enough for the Settings screen to switch back
    // to TS, but a Rust-selected catalog must never reconnect Electron MCP.
    console.error('[main:mcp] Rust harness is unavailable; MCP remains unavailable:', error)
    return servers
  }
  if (rust) {
    await parkElectronMcpForRust()
    const client = rust
    try {
      await client.syncMcpServers()
      broadcastToAppWindows('settings:mcpStateChanged', await client.getMcpState())
    } catch (error) {
      // Do not reconnect Electron MCP clients here. Rust remains selected and
      // the Settings panel can surface its native connection error on refresh.
      console.error('[main:mcp] Failed to apply Rust MCP settings:', error)
    }
    // `mcp.status` only reports stored discovery metadata, and a fresh
    // `mcp.reload` clears it. Rediscover enabled servers in the background so
    // Settings fills in live tools/resources/prompts without a manual refresh,
    // mirroring the TS service's refreshEnabledServers() inside updateServers.
    void client.refreshMcpServer()
      .then(async (refreshed) => {
        const state = 'servers' in refreshed ? refreshed : await client.getMcpState()
        broadcastToAppWindows('settings:mcpStateChanged', state)
      })
      .catch((error) => {
        console.error('[main:mcp] Background MCP discovery failed:', error)
      })
    return servers
  }

  try {
    await mainState.mcpService!.updateServers(servers)
  } catch (error) {
    console.error('[main:mcp] Failed to apply MCP settings:', error)
  }
  return servers
}

export async function getMcpStateForSelectedHarness (): Promise<MCPStateSnapshot> {
  const rust = await selectedRustMcpClient()
  if (!rust) return mainState.mcpService!.getState()
  await parkElectronMcpForRust()
  return await rust.getMcpState()
}

export async function refreshMcpServerForSelectedHarness (serverId?: string): Promise<MCPStateSnapshot | MCPServerSnapshot> {
  const rust = await selectedRustMcpClient()
  if (!rust) {
    if (!serverId) {
      await mainState.mcpService!.refreshEnabledServers()
      return mainState.mcpService!.getState()
    }
    return await mainState.mcpService!.refreshServer(serverId)
  }

  await parkElectronMcpForRust()
  const snapshot = await rust.refreshMcpServer(serverId)
  const state = 'servers' in snapshot ? snapshot : await rust.getMcpState()
  broadcastToAppWindows('settings:mcpStateChanged', state)
  return snapshot
}

export async function disconnectMcpServerForSelectedHarness (serverId: string): Promise<MCPServerSnapshot> {
  const rust = await selectedRustMcpClient()
  if (!rust) return await mainState.mcpService!.disconnectServer(serverId)

  await parkElectronMcpForRust()
  const snapshot = await rust.disconnectMcpServer(serverId)
  broadcastToAppWindows('settings:mcpStateChanged', await rust.getMcpState())
  return snapshot
}

function recordFromUnknown (value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringFromRecord (record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function stringArrayFromRecord (record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key]
    if (!Array.isArray(value)) continue
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map(item => item.trim())
  }
  return []
}

function stringMapFromRecord (value: unknown): Record<string, string> {
  const record = recordFromUnknown(value)
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => key.trim().length > 0)
    .map(([key, item]) => [key.trim(), typeof item === 'string' ? item : String(item ?? '')]))
}

function optionalBooleanFromRecord (record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'boolean') return record[key] as boolean
  }
  return undefined
}

function saveRustNativeAgent (result: unknown): string | null {
  const container = recordFromUnknown(result)
  const agent = recordFromUnknown(container.agent)
  const id = stringFromRecord(agent, 'id')
  const name = stringFromRecord(agent, 'name')
  const systemPrompt = stringFromRecord(agent, 'systemPrompt', 'system_prompt')
  if (!id || !name || !systemPrompt || !mainState.agentStore) return null

  const reasoningStrength = stringFromRecord(agent, 'reasoningStrength', 'reasoning_strength')
  const saved = mainState.agentStore.save({
    id,
    name,
    icon: stringFromRecord(agent, 'icon') || undefined,
    description: stringFromRecord(agent, 'description'),
    systemPrompt,
    providerId: stringFromRecord(agent, 'providerId', 'provider_id') || undefined,
    modelId: stringFromRecord(agent, 'modelId', 'model_id') || undefined,
    reasoningStrength: reasoningStrength === 'low' || reasoningStrength === 'medium' || reasoningStrength === 'high' || reasoningStrength === 'max'
      ? reasoningStrength
      : undefined,
    skillIds: stringArrayFromRecord(agent, 'skillIds', 'skill_ids'),
    allowedTools: stringArrayFromRecord(agent, 'allowedTools', 'allowed_tools'),
    deniedTools: stringArrayFromRecord(agent, 'deniedTools', 'denied_tools'),
    memoryScopes: stringArrayFromRecord(agent, 'memoryScopes', 'memory_scopes') as AgentDefinition['memoryScopes'],
    memoryWritePolicy: {
      allowUserTraits: optionalBooleanFromRecord(recordFromUnknown(agent.memoryWritePolicy || agent.memory_write_policy), 'allowUserTraits', 'allow_user_traits') ?? true,
      allowAgentSkills: optionalBooleanFromRecord(recordFromUnknown(agent.memoryWritePolicy || agent.memory_write_policy), 'allowAgentSkills', 'allow_agent_skills') ?? true,
      allowSteps: optionalBooleanFromRecord(recordFromUnknown(agent.memoryWritePolicy || agent.memory_write_policy), 'allowSteps', 'allow_steps') ?? true,
      allowKnowledge: optionalBooleanFromRecord(recordFromUnknown(agent.memoryWritePolicy || agent.memory_write_policy), 'allowKnowledge', 'allow_knowledge') ?? true
    },
    autoReplyPolicy: {
      enabled: optionalBooleanFromRecord(recordFromUnknown(agent.autoReplyPolicy || agent.auto_reply_policy), 'enabled') ?? false,
      requireMention: optionalBooleanFromRecord(recordFromUnknown(agent.autoReplyPolicy || agent.auto_reply_policy), 'requireMention', 'require_mention') ?? true
    },
    createdAt: stringFromRecord(agent, 'createdAt', 'created_at') || undefined,
    updatedAt: stringFromRecord(agent, 'updatedAt', 'updated_at') || undefined
  } satisfies Partial<AgentDefinition>)
  notifyAgentWorkspaceChanged({ entity: 'agent', action: 'saved', id: saved.id })
  return saved.id
}

function saveRustNativeAgentGroup (result: unknown): string | null {
  const container = recordFromUnknown(result)
  const group = recordFromUnknown(container.group)
  const id = stringFromRecord(group, 'id')
  const name = stringFromRecord(group, 'name')
  const coordinatorAgentId = stringFromRecord(group, 'coordinatorAgentId', 'coordinator_agent_id')
  if (!id || !name || !coordinatorAgentId || !mainState.agentGroupStore) return null

  const visibility = stringFromRecord(group, 'visibility')
  const saved = mainState.agentGroupStore.save({
    id,
    name,
    icon: stringFromRecord(group, 'icon') || undefined,
    description: stringFromRecord(group, 'description') || undefined,
    coordinatorAgentId,
    memberAgentIds: stringArrayFromRecord(group, 'memberAgentIds', 'member_agent_ids'),
    maxRounds: Number(group.maxRounds ?? group.max_rounds) || undefined,
    maxParallelWorkers: Number(group.maxParallelWorkers ?? group.max_parallel_workers) || undefined,
    sharedMemoryScopes: stringArrayFromRecord(group, 'sharedMemoryScopes', 'shared_memory_scopes')
      .filter((scope): scope is AgentGroupDefinition['sharedMemoryScopes'][number] => scope === 'group' || scope === 'project' || scope === 'channel'),
    visibility: visibility === 'expandable_internal_transcript' ? visibility : undefined,
    createdAt: stringFromRecord(group, 'createdAt', 'created_at') || undefined,
    updatedAt: stringFromRecord(group, 'updatedAt', 'updated_at') || undefined
  } satisfies Partial<AgentGroupDefinition>)
  notifyAgentWorkspaceChanged({ entity: 'group', action: 'saved', id: saved.id })
  return saved.id
}

/**
 * Keep the legacy per-file group catalog current when Rust ownership ends.
 * Rust remains the source of truth while selected; this callback only makes
 * the explicit Rust -> TypeScript transition reversible.
 */
function mirrorRustAgentGroupsOnHandoff (groups: AgentGroupDefinition[]): void {
  const store = mainState.agentGroupStore
  if (!store) return
  const ids = new Set(groups.map(group => group.id))
  for (const existing of store.list()) {
    if (!ids.has(existing.id)) store.delete(existing.id)
  }
  for (const group of groups) store.save(group)
}

/** Persist the Rust agent catalog before a Rust -> TypeScript handoff. */
function mirrorRustAgentsOnHandoff (agents: AgentDefinition[]): void {
  const store = mainState.agentStore
  if (!store) return
  const ids = new Set(agents.map(agent => agent.id))
  for (const existing of store.list()) {
    if (!ids.has(existing.id) && existing.id !== 'agent_default') store.delete(existing.id)
  }
  for (const agent of agents) store.save(agent)
}

function saveRustNativeMcpServer (result: unknown): string | null {
  const container = recordFromUnknown(result)
  const server = recordFromUnknown(container.server)
  const id = stringFromRecord(container, 'server_id', 'serverId') || stringFromRecord(server, 'id', 'name')
  if (!id || !mainState.settingsStore) return null

  const existing = mainState.settingsStore.getMcpServers().find(candidate => candidate.id === id)
  const transport = stringFromRecord(server, 'transport')
  const normalizedTransport: MCPServerConfig['transport'] = transport === 'streamable-http' || transport === 'sse'
    ? transport
    : 'stdio'
  const target = stringFromRecord(server, 'target', normalizedTransport === 'stdio' ? 'command' : 'url')
  const timeout = Number(server.timeoutMs ?? server.timeout_ms)
  const next: MCPServerConfig = {
    id,
    name: stringFromRecord(server, 'displayName', 'display_name') || existing?.name || id,
    enabled: optionalBooleanFromRecord(server, 'enabled') ?? existing?.enabled ?? true,
    transport: normalizedTransport,
    command: normalizedTransport === 'stdio' ? target : '',
    args: stringArrayFromRecord(server, 'args'),
    cwd: stringFromRecord(server, 'cwd'),
    env: stringMapFromRecord(server.env),
    url: normalizedTransport === 'stdio' ? '' : target,
    headers: stringMapFromRecord(server.headers),
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? Math.floor(timeout) : (existing?.timeoutMs || 15_000)
  }
  const servers = mainState.settingsStore.getMcpServers()
    .filter(candidate => candidate.id !== id)
  servers.push(next)
  mainState.settingsStore.saveMcpServers(servers)
  return id
}

async function handleRustHostRequest (request: RustHostRequest): Promise<JsonRpcResult> {
  if (request.requestKind === 'page_automation') {
    const action = request.payload.action
    if (action === 'read') {
      return await requestPageAutomationFromRenderer<BrowserAutomationSnapshot>({ type: 'snapshot' }) as unknown as JsonRpcResult
    }
    const actions = Array.isArray(request.payload.actions) ? request.payload.actions : []
    let result: BrowserAutomationActionResult = { ok: true, type: 'wait', timeoutMs: 0 }
    for (const action of actions) {
      result = await requestPageAutomationFromRenderer<BrowserAutomationActionResult>({
        type: 'action',
        action: action as BrowserAutomationAction
      })
    }
    return result as unknown as JsonRpcResult
  }

  if (request.requestKind === 'ask_user') {
    const win = getActiveAiRequestWindow()
    if (!win || win.isDestroyed()) throw new Error('No active Electron window for ask_user')
    const questions = normalizeRustAskUserQuestions(request.payload, request.requestId)
    if (questions.length === 0) throw new Error('Rust ask_user request has no valid questions')
    return await new Promise<JsonRpcResult>((resolve) => {
      let settled = false
      const finish = (value: JsonRpcResult) => {
        if (settled) return
        settled = true
        ipcMain.removeListener('askUser:response', onResponse)
        clearTimeout(timeout)
        resolve(value)
      }
      const onResponse = (_event: unknown, payload: { requestId?: string; answers?: unknown }) => {
        if (payload?.requestId !== request.requestId) return
        finish(normalizeRustAskUserResponse(payload.answers ?? null, questions))
      }
      const timeout = setTimeout(() => finish(null), 300_000)
      ipcMain.on('askUser:response', onResponse)
      win.webContents.send('askUser:request', {
        requestId: request.requestId,
        sessionId: request.streamId,
        questions
      })
    })
  }

  if (request.requestKind === 'open_project_app') {
    const win = getActiveAiRequestWindow()
    if (!win || win.isDestroyed()) throw new Error('No active Electron window for open_project_app')
    const projectId = typeof request.payload.projectId === 'string' ? request.payload.projectId : ''
    if (!projectId) throw new Error('open_project_app requires projectId')
    const mode = request.payload.mode === 'window' ? 'window' : 'embed'
    if (win.isMinimized()) win.restore()
    win.focus()
    win.webContents.send('project:openInShell', { projectId, mode })
    return { success: true, project_id: projectId, mode, opened_via: 'shell_ui' }
  }

  if (request.requestKind === 'document.openOriginal') {
    const filePath = optionalString(request.payload, 'filePath') || optionalString(request.payload, 'file_path')
    if (!filePath) throw new Error('document.openOriginal requires filePath')
    const error = await shell.openPath(filePath)
    return error
      ? { success: false, supported: true, error }
      : { success: true, supported: true }
  }

  if (request.requestKind === 'document.preview.ensure') {
    const filePath = optionalString(request.payload, 'filePath') || optionalString(request.payload, 'file_path')
    const fileType = optionalString(request.payload, 'fileType') || optionalString(request.payload, 'file_type')
    if (!filePath || !fileType) throw new Error('document.preview.ensure requires filePath and fileType')
    const normalizedFileType = fileType.toLowerCase() === 'doc' ? 'docx' : fileType.toLowerCase()
    const render = await buildDocumentRenderPreview(filePath, normalizedFileType as DocumentFileType)
    const asset = await readDocumentRenderAsset(render)
    return {
      render,
      ...(asset ? { bytes: Array.from(asset.bytes) } : {})
    }
  }

  throw new Error(`Unsupported Rust host request: ${request.requestKind}`)
}

/**
 * Project list for daily-suggestion context: name, type and run state only.
 * Mirrors the `projects:list` IPC so the Rust harness owns the list when selected.
 */
async function listProjectsForSuggestions (): Promise<SuggestionProjectContext[]> {
  {
    const harness = await startSelectedRustHarness()
    const client = harness ? mainState.rustHarness : null
    if (client) {
      const native = await client.call<Record<string, unknown>>('project.list', {})
      const projects = recordsFromRustValue(native.projects)
      const list = await Promise.all(projects.map(async project => {
        const id = optionalString(project, 'id') || ''
        const context: SuggestionProjectContext = {
          id,
          name: optionalString(project, 'name') || id,
          type: optionalString(project, 'type') || 'unknown'
        }
        if (!id) return context
        try {
          const runtime = await client.call<Record<string, unknown>>('project.status', { projectId: id })
          context.status = optionalString(runtime, 'status')
          context.port = optionalNumber(runtime, 'port')
        } catch {
          context.status = 'unknown'
        }
        return context
      }))
      return list.filter(project => project.id)
    }
  }
  return []
}

async function handleRustPermissionRequest (request: { requestId: string; toolName: string; argsSummary: string; sessionId: string }): Promise<boolean> {
  const win = getActiveAiRequestWindow()
  if (!win || win.isDestroyed()) return false
  return await new Promise((resolve) => {
    let settled = false
    const finish = (approved: boolean) => {
      if (settled) return
      settled = true
      ipcMain.removeListener('auth:response', onResponse)
      clearTimeout(timeout)
      resolve(approved)
    }
    const onResponse = (_event: unknown, payload: { requestId?: string; approved?: boolean }) => {
      if (payload?.requestId !== request.requestId) return
      finish(payload.approved === true)
    }
    const timeout = setTimeout(() => finish(false), 300_000)
    ipcMain.on('auth:response', onResponse)
    win.webContents.send('auth:request', {
      requestId: request.requestId,
      sessionId: request.sessionId,
      title: 'Rust harness permission',
      detail: `${request.toolName}: ${request.argsSummary}`
    })
  })
}

export async function initializeServices (): Promise<void> {
  await migrateUserDataForRename()

  const projectsDir = getProjectsDir()
  const snapshotsDir = getSnapshotsDir()
  const userDataPath = app.getPath('userData')

  mainState.settingsStore = new SettingsStore(userDataPath)
  mainState.updateService = new UpdateService(mainState.settingsStore)
  mainState.updateService.on('stateChanged', (state: AppUpdateState) => {
    broadcastToAppWindows('appUpdate:stateChanged', state)
  })
  mainState.chatHistory = new ChatHistoryStore(userDataPath)
  mainState.aiLogStore = new AILogStore(userDataPath)
  mainState.skillStore = new SkillStore(userDataPath)
  mainState.agentStore = new AgentStore(userDataPath)
  mainState.agentGroupStore = new AgentGroupStore(userDataPath)
  mainState.channelBindingStore = new ChannelBindingStore(userDataPath)
  mainState.imGatewayService = new ImGatewayService({
    bindingStore: mainState.channelBindingStore!,
    generateReply: generateImGatewayReply
  })
  // Memory is owned by the Rust harness: the shared agent-memory databases, the
  // embedding pipeline, and recall all live in harness-rs (single source).
  mainState.scheduledTaskStore = new ScheduledTaskStore(userDataPath)
  mainState.longTermGoalStore = new LongTermGoalStore(userDataPath)
  mainState.dailySuggestionStore = new DailySuggestionStore(userDataPath)
  mainState.imageLibraryStore = new ImageLibraryStore(userDataPath)
  mainState.studioTaskStore = new StudioTaskStore(userDataPath)
  mainState.usageStore = new UsageStore(userDataPath)
  mainState.mcpService = new MCPService()
  mainState.mcpService.on('stateChanged', (state: MCPStateSnapshot) => {
    broadcastToAppWindows('settings:mcpStateChanged', state)
  })

  mainState.projectFS = new ProjectFS(projectsDir, snapshotsDir)
  mainState.runtimeManager = new RuntimeManager(projectsDir)
  mainState.builderService = new BuilderService(projectsDir)
  mainState.runtimeManager.setBuilderService(mainState.builderService)
  mainState.builderService.setRuntimeManager(mainState.runtimeManager)
  mainState.apiClient = new ProjectApiClient(mainState.runtimeManager)
  mainState.dataAccess = new ProjectDataAccess(projectsDir)
  mainState.projectPackageService = new ProjectPackageService(mainState.projectFS, mainState.dataAccess)
  mainState.asyncTaskManager = new AsyncTaskManager(mainState.builderService)

  // Wire up the external database delegate. The adapter uses Electron's
  // built-in node:sqlite implementation, keeping the data layer independent
  // from any native npm module and its Electron ABI.
  const sqliteDelegate = new SqliteAdapter()
  mainState.dataAccess.setDatabaseDelegate({
    query: (dbPath: string, sql: string, params?: unknown[]) => sqliteDelegate.query(dbPath, sql, params),
    execute: (dbPath: string, sql: string, params?: unknown[]) => sqliteDelegate.execute(dbPath, sql, params),
    listTables: (dbPath: string) => sqliteDelegate.listTables(dbPath),
    getSchema: (dbPath: string) => sqliteDelegate.getSchema(dbPath),
    close: (dbPath: string) => sqliteDelegate.close(dbPath),
    closeAll: () => sqliteDelegate.closeAll()
  })

  mainState.documentStore = new DocumentStore()

  // The frozen engine consumes this full Electron-domain service surface.
  // The Rust facade reuses it only as a platform adapter for host-owned tools,
  // UI callbacks, and notifications; it does not run a second Node Agent Loop.
  const aiEngineServices: AIEngineServices = {
    projectFS: mainState.projectFS!,
    runtimeManager: mainState.runtimeManager!,
    builderService: mainState.builderService!,
    apiClient: mainState.apiClient!,
    dataAccess: mainState.dataAccess!,
    asyncTaskManager: mainState.asyncTaskManager!,
    documentStore: mainState.documentStore!,
    skillStore: mainState.skillStore!,
    agentStore: mainState.agentStore!,
    agentGroupStore: mainState.agentGroupStore!,
    settingsStore: mainState.settingsStore!,
    imageLibraryStore: mainState.imageLibraryStore ?? undefined,
    usageStore: mainState.usageStore ?? undefined,
    enqueueStudioImageTasks,
    getMainWindow: () => getActiveAiRequestWindow(),
    readActivePage: async () => {
      return await requestPageAutomationFromRenderer<BrowserAutomationSnapshot>({ type: 'snapshot' })
    },
    interactWithActivePage: async (action: BrowserAutomationAction) => {
      return await requestPageAutomationFromRenderer<BrowserAutomationActionResult>({ type: 'action', action })
    },
    notifySkillsChanged: (event) => {
      broadcastToAppWindows('skills:changed', event)
    },
    notifyAgentWorkspaceChanged,
    notifyFolderWorkspaceChanged: (event) => {
      broadcastToAppWindows('folderWorkspace:changed', event)
    },
    mcpService: mainState.mcpService!,
    scheduledTaskService: undefined
  }

  // Start Rust lazily when the user selects it in Settings. The TS engine is
  // still initialized here because the rest of the Electron shell (runtime,
  // long-term goals, IM and legacy IPC) remains available during migration.
  mainState.rustHarness = new RustHarnessClient({
    workspace: projectsDir,
    dataDir: userDataPath,
    getProviders: () => mainState.settingsStore!.getProviders(),
    getAgents: () => mainState.agentStore!.list(),
    onAgentsHandoff: agents => mirrorRustAgentsOnHandoff(agents),
    getAgentGroups: () => mainState.agentGroupStore!.list(),
    onAgentGroupsHandoff: groups => mirrorRustAgentGroupsOnHandoff(groups),
    getMcpServers: () => mainState.settingsStore!.getMcpServers(),
    onEvent: () => {},
    onHostRequest: async (request) => await handleRustHostRequest(request),
    onPermissionRequest: async (request) => await handleRustPermissionRequest(request)
  })
  mainState.rustHarnessEngine = new RustHarnessEngine({
    client: mainState.rustHarness,
    services: aiEngineServices,
    usageStore: mainState.usageStore ?? undefined,
    onNativeToolResult: async (name, result, context) => {
      if (name === 'create_agent') {
        saveRustNativeAgent(result)
        return
      }
      if (name === 'create_agent_group') {
        saveRustNativeAgentGroup(result)
        return
      }
      if (name === 'install_mcp_server') {
        const serverId = saveRustNativeMcpServer(result)
        if (serverId) {
          await applyMcpServersToService()
        }
        return
      }
      if (name === 'generate_image' || name === 'edit_image') {
        const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
        const queued = typeof record.queued === 'number' && Number.isFinite(record.queued)
          ? Math.max(0, Math.floor(record.queued))
          : 0
        if (queued > 0) {
          // Native Rust image tools hand batch requests to the Rust-owned
          // queue; wake an open Studio so it drains them into its scheduler.
          broadcastToAppWindows('image:studio:tasksAdded', { count: queued, source: 'rust' })
        } else {
          // Backward-compatible single-request calls still write the gallery
          // directly and need the regular invalidation event.
          broadcastToAppWindows('image:library:changed', { source: 'rust' })
        }
        return
      }
      if (name === 'write_workspace_file' || name === 'edit_workspace_file' || name === 'patch_workspace_file' || name === 'delete_workspace_file') {
        const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
        const rootPath = typeof context.workspaceRoot === 'string' ? context.workspaceRoot.trim() : ''
        const filePath = typeof record.file_path === 'string' ? record.file_path.trim() : ''
        if (rootPath && filePath) {
          broadcastToAppWindows('folderWorkspace:changed', {
            action: name === 'write_workspace_file'
              ? (record.overwritten === true ? 'updated' : 'created')
              : name === 'delete_workspace_file' ? 'deleted' : 'updated',
            rootPath,
            filePath
          })
        }
        return
      }
      if (name.includes('project') || name === 'create_project') {
        const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
        const projectId = typeof record.project_id === 'string'
          ? record.project_id
          : typeof record.id === 'string' ? record.id : undefined
        broadcastToAppWindows('projects:changed', { action: 'updated', projectId, source: 'rust' })
      }
    }
  })
  mainState.scheduledTaskService = new ScheduledTaskService({
    store: mainState.scheduledTaskStore,
    aiEngine: mainState.rustHarnessEngine!,
    resolveAiEngine: getSelectedExecutionEngine,
    skillStore: mainState.skillStore!,
    getMainWindow: () => mainState.mainWindow,
    resolveProviderConfig: (task) => resolveProviderConfig(task?.providerId || undefined, task?.modelId || undefined),
    getNotificationPreference: () => mainState.settingsStore?.getAIExecutionPreferences().notifyOnTaskComplete ?? true,
    resolveTaskPrompt: (task) => mainState.longTermGoalService?.resolveScheduledTaskPrompt(task),
    resolveTaskOptions: (task) => mainState.longTermGoalService?.resolveScheduledTaskOptions(task),
    shouldNotifyReport: (report) => mainState.longTermGoalService?.shouldNotifyScheduledReport(report),
    onTasksChanged: (tasks: ScheduledTaskDefinition[]) => {
      broadcastToAppWindows('scheduler:tasksChanged', JSON.parse(JSON.stringify(tasks)))
    },
    onReportsChanged: (reports: ScheduledTaskRunReport[]) => {
      broadcastToAppWindows('scheduler:reportsChanged', JSON.parse(JSON.stringify(reports)))
      setTimeout(() => {
        mainState.longTermGoalService?.reconcileScheduledReports(mainState.scheduledTaskService?.listAllReports() || [])
      }, 0)
    },
    onReportNotificationClick: (report: ScheduledTaskRunReport) => {
      broadcastToAppWindows('scheduler:reportRequested', JSON.parse(JSON.stringify(report)))
    }
  })
  aiEngineServices.scheduledTaskService = mainState.scheduledTaskService
  mainState.scheduledTaskService.start()

  mainState.longTermGoalService = new LongTermGoalService({
    store: mainState.longTermGoalStore,
    scheduledTaskService: mainState.scheduledTaskService,
    aiEngine: mainState.rustHarnessEngine!,
    resolveAiEngine: getSelectedExecutionEngine,
    skillStore: mainState.skillStore!,
    projectFS: mainState.projectFS!,
    resolveProviderConfig: (providerId, modelId, reasoningEffort, temperature) => resolveProviderConfig(providerId || undefined, modelId || undefined, reasoningEffort, temperature),
    onGoalsChanged: (goals) => {
      broadcastToAppWindows('longTermGoals:goalsChanged', goals)
    },
    onSnapshotChanged: (snapshot) => {
      broadcastToAppWindows('longTermGoals:snapshotChanged', snapshot)
    },
    onInterventionRequested: (_goal, intervention) => {
      broadcastToAppWindows('longTermGoals:interventionRequested', intervention)
    },
    onRunProgress: (goalId, run) => {
      broadcastToAppWindows('longTermGoals:runProgress', { goalId, run })
    }
  })
  mainState.longTermGoalService.start()

  mainState.dailySuggestionService = new DailySuggestionService({
    store: mainState.dailySuggestionStore,
    resolveAiEngine: getSelectedExecutionEngine,
    resolveProviderConfig: (providerId, modelId) => resolveProviderConfig(providerId || undefined, modelId || undefined),
    listProjects: listProjectsForSuggestions,
    listConversations: async () => {
      const entries = await mainState.chatHistory!.list()
      return entries
        .slice()
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        .map(entry => ({ title: entry.title, updatedAt: entry.updatedAt, previewText: entry.previewText }))
    },
    getCapabilities: async () => ({
      skillNames: mainState.skillStore!.list().map(skill => skill.name),
      mcpServerNames: mainState.settingsStore!.getMcpServers().filter(server => server.enabled).map(server => server.name),
      scheduledTaskCount: mainState.scheduledTaskService!.listTasks().length,
      longTermGoalCount: mainState.longTermGoalService!.listGoals().length,
      agentGroupCount: mainState.agentGroupStore!.list().length
    }),
    getLocale: () => getMainLocale(),
    onChanged: (snapshot) => {
      broadcastToAppWindows('dailySuggestions:changed', JSON.parse(JSON.stringify(snapshot)))
    }
  })
  mainState.dailySuggestionService.start()

  // Apply saved AI settings on startup
  const providersConfig = applyActiveProviderToAiEngine()
  const activeProvider = providersConfig.providers.find(p => p.id === providersConfig.activeProviderId)
  if (activeProvider) {
    console.log('[main] Applied active AI provider settings')
  }

  // Apply saved cost settings on startup
  const savedCostSettings = mainState.settingsStore!.getCostSettings()
  if (savedCostSettings.modelPricing.length > 0) {
    const pricingMap: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }> = {}
    for (const entry of savedCostSettings.modelPricing) {
      pricingMap[entry.model] = {
        inputPerMillion: entry.inputPerMillion,
        outputPerMillion: entry.outputPerMillion,
        cacheReadPerMillion: entry.cacheReadPerMillion || undefined
      }
    }
    mainState.rustHarnessEngine.setCustomModelPricing(pricingMap)
  }
  if (savedCostSettings.budgetLimit != null) {
    mainState.rustHarnessEngine.setBudgetLimit(savedCostSettings.budgetLimit)
  }

  await applyMcpServersToService()

  mainState.appGateway = new AppGateway(mainState.runtimeManager, mainState.projectFS, mainState.builderService)
  mainState.processManagerService = new ProcessManagerService(mainState.runtimeManager, mainState.projectFS)
  // Rust owns project process state; there is no TS gateway fallback.
  try {
    await startSelectedRustHarness()
    console.log('[main] Rust project gateway health checks started')
  } catch (error) {
    console.error('[main] Rust harness is unavailable; project recovery is disabled:', error)
  }

  mainState.systemService = new SystemService(
    mainState.runtimeManager,
    mainState.appGateway,
    undefined,
    resolveRustProjectRuntimeSnapshot
  )

  mainState.lanServer = new LanServer({
    port: LAN_SERVER_PORT,
    projectFS: mainState.projectFS!,
    runtimeManager: mainState.runtimeManager!,
    apiClient: mainState.apiClient!,
    dataAccess: mainState.dataAccess!,
    aiEngine: mainState.rustHarnessEngine!,
    resolveAiEngine: getSelectedExecutionEngine,
    configureAiEngines: (config) => {
      mainState.rustHarnessEngine?.configure(config)
      mainState.rustHarnessEngine?.configure(config)
    },
    systemService: mainState.systemService!,
    settingsStore: mainState.settingsStore!,
    imGatewayService: mainState.imGatewayService!,
    resolveRustProjectControl: async (): Promise<LanProjectControl | null> => {
      const engine = await startSelectedRustHarness()
      return engine ? mainState.rustHarness : null
    }
  })

  await mainState.lanServer.start()
  console.log('[main] LAN server started on port 19527')
}
