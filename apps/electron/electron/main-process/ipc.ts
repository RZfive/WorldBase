import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { USER_ABORT_MESSAGE } from '../../src/main/ai-engine/abort-utils.js'
import { createProvider } from '../../src/main/ai-engine/providers/index.js'
import type { MessageContent } from '../../src/main/ai-engine/providers/openai-provider.js'
import { PROJECT_PACKAGE_EXTENSION } from '../../src/main/project-fs/project-package-service.js'
import { isOfficeFile, readOfficeFile, detectOfficeType } from '../../src/main/ai-engine/agent/tools/office-utils.js'
import { parseDocument, isSupportedDocument } from '../../src/main/ai-engine/agent/tools/document-parser.js'
import type { CreateSelectionPayload } from '../../src/main/ai-engine/agent/tools/document-types.js'
import { readDocumentRenderAsset } from '../../src/main/document-preview/document-render-service.js'
import { decryptPortableSettingsConfig, encryptPortableSettingsConfig, PORTABLE_SETTINGS_APP_ID, PORTABLE_SETTINGS_EXTENSION } from '../../src/main/settings/settings-transfer.js'
import { runImageStudioRequest } from '../../src/main/settings/image-generation-service.js'
import { fetchProviderModels } from '../../src/main/settings/provider-model-service.js'
import type { AIExecutionAuthMode, AIExecutionPreferences, AIProvidersConfig, ChatFontPreferences, LanguagePreference, LaunchpadLayout, PinnedDockApp, PortableSettingsConfig, WebAppShortcut } from '../../src/main/settings/settings-store.js'
import { setMainLocale, t } from '../../src/main/i18n/main-i18n.js'
import type { Conversation } from '../../src/main/settings/chat-history.js'
import { buildStudioImageUrl } from '../../src/main/settings/image-library-store.js'
import type { ImageLibraryData, ImageLibraryEntry, ImageLibraryFolderCard, ImageLibraryItem, ImageLibraryPage, ImageLibraryQuery } from '../../src/main/settings/image-library-store.js'
import type { ImageStudioGenerateRequest, ImageStudioGenerateResponse, ImageStudioTask } from '../../src/shared/image-studio-types.js'
import type { Skill } from '../../src/main/settings/skill-store.js'
import type { ScheduledTaskDefinition } from '../../src/main/settings/scheduled-task-store.js'
import type { UsageRecord, UsageSummary } from '../../src/main/settings/usage-store.js'
import type { LongTermGoalSaveInput, LongTermGoalStreamEvent } from '../../src/shared/long-term-goal-types.js'
import type { MCPServerConfig } from '../../src/main/settings/settings-store.js'
import type { AppUpdateChannel, AppUpdateConfig, AppUpdateWebsiteKind } from '../../src/shared/app-update-types.js'
import type { ActivePageAutomationContext, PageAutomationResponseEnvelope } from '../../src/shared/page-automation-types.js'
import type { AgentDefinition, AgentGroupDefinition, AgentMemoryScope, ChannelBinding, ChannelEvent, MemoryCompactionResult, MemoryCompactionStatus, MemoryEntry, MemorySearchScope, MemoryType } from '../../src/shared/agent-workspace-types.js'
import type { FolderWorkspacePickResult } from '../../src/shared/folder-workspace-types.js'
import type { DocumentEditExportRequest } from '../../src/shared/document-edit-types.js'
import { assertFolderWorkspaceRoot, getFolderWorkspaceRootName, listFolderWorkspaceFiles, readFolderWorkspaceFile } from '../../src/main/folder-workspace/folder-workspace-fs.js'
import { calculateDocumentSha256, exportDocumentCopy, readDocumentEditImage } from '../../src/main/document-edit/document-edit-service.js'
import { LAN_SERVER_PORT } from '../../src/main/constants.js'
import { mainState, activeChatSessions, pendingPageAutomationRequests, projectWindows, type EnsureWindowWidthOptions } from './state.js'
import { MAX_CHAT_UPLOADED_OFFICE_FILE_SIZE_BYTES, MAX_DOCUMENT_WORKBENCH_FILE_SIZE_BYTES, MAX_UPLOADED_OFFICE_CONTENT_LENGTH } from './constants.js'
import { readUploadedAttachmentFromBuffer, readUploadedAttachmentFromPath, type UploadedAttachmentBufferPayload } from './media/attachments.js'
import { ensureDocumentRenderPreview } from './media/document-preview.js'
import { applyActiveProviderToAiEngine, notifyAgentWorkspaceChanged, notifyAiTaskStatus, resolveAgentRuntimeContext } from './ai/agent-context.js'
import { startSelectedRustHarness } from './ai/selected-execution-engine.js'
import { transitionHarnessOwnership } from './ai/harness-ownership.js'
import type { JsonRpcResult } from './rust-harness-client.js'
import { getAllUserMessageTexts, getConversationTitleFromMessages, getLastUserMessageText, getMessageText } from './chat-message-utils.js'
import { buildDirectGroupReplyPromptSection, buildGroupDeliberationSection, parseGroupRouting, resolveDirectGroupReplyRoute, type GroupDeliberationProgressCallback } from './ai/group-deliberation.js'
import { buildNativeRustGroupDeliberation, hasNativeRustGroupSession, injectNativeRustGroup } from './ai/native-rust-group-deliberation.js'
import { groupSessionRegistry } from './ai/group-session.js'
import { cloneMemoryCompactionStatus, runMemoryCompactionWithStatus } from './ai/memory-compaction.js'
import {
  applyMcpServersToService,
  disconnectMcpServerForSelectedHarness,
  getMcpStateForSelectedHarness,
  refreshMcpServerForSelectedHarness
} from './services.js'
import { drainPendingStudioImageTasks } from './media/image-studio-queue.js'
import { attachProjectRuntimeLogForwarding, broadcastToAppWindows, buildActivePagePromptSection, buildRendererWindowUrl, createProjectPackageDefaultName, ensureWindowHasMinimumWidth, getPreferredLanIpv4Addresses, getProjectsDir, getSenderWindow, guessImageExtension, resolveImageBuffer, runWithAiRequestWindow, setWindowMinimumWidth } from './windows.js'
import { generateImGatewayReply } from './ai/im-replies.js'

const AGENT_WORKSPACE_TOOL_DESCRIPTION_KEYS: Record<string, string> = {
  run_skill: 'settings.agentWorkspace.toolDescriptionRunSkill',
  list_skills: 'settings.agentWorkspace.toolDescriptionListSkills',
  enter_plan_mode: 'settings.agentWorkspace.toolDescriptionEnterPlanMode',
  exit_plan_mode: 'settings.agentWorkspace.toolDescriptionExitPlanMode',
  ask_user: 'settings.agentWorkspace.toolDescriptionAskUser',
  generate_image: 'settings.agentWorkspace.toolDescriptionGenerateImage',
  edit_image: 'settings.agentWorkspace.toolDescriptionEditImage',
  mcp_list_servers: 'settings.agentWorkspace.toolDescriptionMcpListServers',
  mcp_list_resources: 'settings.agentWorkspace.toolDescriptionMcpListResources',
  mcp_read_resource: 'settings.agentWorkspace.toolDescriptionMcpReadResource',
  mcp_list_prompts: 'settings.agentWorkspace.toolDescriptionMcpListPrompts',
  mcp_get_prompt: 'settings.agentWorkspace.toolDescriptionMcpGetPrompt'
}

function getAgentWorkspaceToolDescription (name: string, fallback: string): string {
  const key = AGENT_WORKSPACE_TOOL_DESCRIPTION_KEYS[name]
  return key ? t(key) : fallback
}

function buildFolderWorkspacePromptSection (workspaceRoot: string | null): string | null {
  if (!workspaceRoot) return null
  const rootName = getFolderWorkspaceRootName(workspaceRoot)
  return [
    '## Conversation folder workspace',
    `The user selected a local folder workspace for this conversation: ${rootName}`,
    `Absolute folder path: ${workspaceRoot}`,
    '- For code development in this conversation, use the folder workspace tools instead of project tools unless the user explicitly asks for a managed project.',
    '- Use relative paths inside the selected folder. Do not use absolute paths as tool arguments.',
    '- Explore with list_workspace_files, read_workspace_file, grep_workspace, and glob_workspace.',
    '- Before editing an existing file, read it with read_workspace_file, then use edit_workspace_file for targeted exact replacements. Use write_workspace_file for new files or broad rewrites, and patch_workspace_file for line-range patches when appropriate.',
    '- Verify changes with run_workspace_command for short install, build, test, lint, type-check, or diagnostic commands. If a workspace command times out, check it with get_workspace_command_status before retrying.',
    '- Plan mode still applies: read/search tools are allowed, while workspace write/delete/run tools are blocked until planning exits.'
  ].join('\n')
}

async function resolveFolderWorkspaceRootForRequest (workspaceRoot?: string | null): Promise<string | null> {
  const requestedRoot = typeof workspaceRoot === 'string' ? workspaceRoot.trim() : ''
  if (!requestedRoot) return null
  try {
    return await assertFolderWorkspaceRoot(requestedRoot)
  } catch (error) {
    console.warn('[ai:chatStream] Ignoring invalid folder workspace root:', (error as Error).message)
    return null
  }
}

function stringFromUnknown (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Translate a native Rust Studio event record into Electron's durable index shape. */
function rustStudioImageEntry (value: unknown, request?: ImageStudioGenerateRequest): ImageLibraryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const meta = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)
    ? raw.meta as Record<string, unknown>
    : {}
  const id = stringFromUnknown(raw.id)
  const fileName = stringFromUnknown(raw.file)
  if (!id || !fileName) return null
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : request?.tags
  const mode = meta.mode === 'edit' || request?.mode === 'edit' ? 'edit' : 'generate'
  const quality = stringFromUnknown(meta.quality) || request?.quality
  const outputFormat = stringFromUnknown(meta.format) || stringFromUnknown(meta.outputFormat) || request?.outputFormat
  const sourceImageFileNames = Array.isArray(meta.sourceImageFileNames)
    ? meta.sourceImageFileNames.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    : Array.isArray(meta.source_image_file_names)
      ? meta.source_image_file_names.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      : undefined
  return {
    id,
    fileName,
    createdAt: stringFromUnknown(raw.createdAt) || new Date().toISOString(),
    mode,
    providerId: stringFromUnknown(raw.providerId) || request?.providerId || '',
    model: stringFromUnknown(raw.model) || request?.model || '',
    prompt: stringFromUnknown(raw.prompt) || request?.prompt || '',
    negativePrompt: stringFromUnknown(meta.negativePrompt) || request?.negativePrompt,
    aspectRatio: stringFromUnknown(meta.aspect) || stringFromUnknown(meta.aspectRatio) || request?.aspectRatio,
    size: stringFromUnknown(meta.size) || request?.size || '',
    quality: quality === 'auto' || quality === 'low' || quality === 'medium' || quality === 'high'
      ? quality
      : undefined,
    outputFormat: outputFormat === 'png' || outputFormat === 'jpeg' || outputFormat === 'webp'
      ? outputFormat
      : undefined,
    sourceImageFileNames: sourceImageFileNames?.length ? sourceImageFileNames : undefined,
    folder: stringFromUnknown(raw.folder) || request?.folder?.trim() || undefined,
    tags,
    width: typeof meta.width === 'number' ? meta.width : undefined,
    height: typeof meta.height === 'number' ? meta.height : undefined,
    thumbUrl: buildStudioImageUrl(id, 'thumb'),
    fullUrl: buildStudioImageUrl(id, 'full')
  }
}

function rustStudioImageItem (value: unknown): ImageLibraryItem | null {
  const entry = rustStudioImageEntry(value)
  if (!entry) return null
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    mode: entry.mode,
    providerId: entry.providerId,
    model: entry.model,
    prompt: entry.prompt,
    negativePrompt: entry.negativePrompt,
    aspectRatio: entry.aspectRatio,
    size: entry.size,
    quality: entry.quality,
    outputFormat: entry.outputFormat,
    folder: entry.folder,
    tags: entry.tags,
    width: entry.width,
    height: entry.height,
    thumbUrl: entry.thumbUrl || buildStudioImageUrl(entry.id, 'thumb'),
    fullUrl: entry.fullUrl || buildStudioImageUrl(entry.id, 'full')
  }
}

function rustStudioFolderCard (value: unknown): ImageLibraryFolderCard | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const name = stringFromUnknown(raw.name)
  if (!name) return null
  const count = typeof raw.count === 'number' && Number.isFinite(raw.count) ? Math.max(0, raw.count) : 0
  const coverIds = Array.isArray(raw.coverImageIds)
    ? raw.coverImageIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : []
  return {
    name,
    count,
    coverThumbUrls: coverIds.map(id => buildStudioImageUrl(id, 'thumb'))
  }
}

function rustStudioParams (request: ImageStudioGenerateRequest): Record<string, unknown> {
  return {
    prompt: request.prompt,
    mode: request.mode,
    negativePrompt: request.negativePrompt,
    aspect: request.aspectRatio,
    size: request.size,
    quality: request.quality,
    format: request.outputFormat,
    n: request.n,
    providerId: request.providerId,
    model: request.model,
    inputImages: request.inputImages,
    folder: request.folder,
    tags: request.tags
  }
}

function rustStudioError (request: ImageStudioGenerateRequest, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  return t('mainDialog.imageGenerationFailedWithContext', {
    provider: request.providerId || t('mainDialog.unknownProvider'),
    model: request.model || t('mainDialog.unknownModel'),
    reason
  })
}

export function setupIPC (): void {
  const getMainWindow = () => mainState.mainWindow
  const aiEngine = mainState.aiEngine!
  const projectFS = mainState.projectFS!
  const runtimeManager = mainState.runtimeManager!
  const builderService = mainState.builderService!
  const appGateway = mainState.appGateway!
  const processManagerService = mainState.processManagerService!
  const updateService = mainState.updateService!
  const systemService = mainState.systemService!
  const dataAccess = mainState.dataAccess!
  const projectPackageService = mainState.projectPackageService!
  const settingsStore = mainState.settingsStore!
  const chatHistory = mainState.chatHistory!
  const aiLogStore = mainState.aiLogStore
  const skillStore = mainState.skillStore!
  const agentStore = mainState.agentStore!
  const agentGroupStore = mainState.agentGroupStore!
  const channelBindingStore = mainState.channelBindingStore!
  const memoryStore = mainState.memoryStore!
  const memoryEngine = mainState.memoryEngine!
  const scheduledTaskService = mainState.scheduledTaskService!
  const longTermGoalService = mainState.longTermGoalService!
  const documentStore = mainState.documentStore!
  const imageLibraryStore = mainState.imageLibraryStore
  const studioTaskStore = mainState.studioTaskStore
  const usageStore = mainState.usageStore
  const selectedRustProjectClient = async () => {
    const harness = await startSelectedRustHarness()
    return harness ? mainState.rustHarness : null
  }
  ipcMain.on('pageAutomation:response', (_event, payload: PageAutomationResponseEnvelope) => {
    const pending = pendingPageAutomationRequests.get(payload.requestId)
    if (!pending) return

    pendingPageAutomationRequests.delete(payload.requestId)
    clearTimeout(pending.timeout)

    if (!payload.ok) {
      pending.reject(new Error(payload.error || t('mainDialog.pageAutomationFailed')))
      return
    }

    if (typeof payload.result === 'undefined') {
      pending.reject(new Error(t('mainDialog.pageAutomationEmptyResult')))
      return
    }

    pending.resolve(payload.result)
  })

  // AI chat (non-streaming, kept for backward compat)
  ipcMain.handle('ai:chat', async (event: IpcMainInvokeEvent, messages: Array<{ role: string; content: MessageContent }>, providerId?: string, modelId?: string, reasoningStrength?: 'low' | 'medium' | 'high' | 'max', agentId?: string, groupId?: string, channelBindingId?: string, targetProjectId?: string, activePageContext?: ActivePageAutomationContext, folderWorkspaceRoot?: string) => {
    const resolvedFolderWorkspaceRoot = await resolveFolderWorkspaceRootForRequest(folderWorkspaceRoot)
    const folderWorkspacePromptSection = buildFolderWorkspacePromptSection(resolvedFolderWorkspaceRoot)
    const baseRuntimeContext = resolveAgentRuntimeContext({
      messages,
      agentId,
      groupId,
      channelBindingId,
      requestedProviderId: providerId,
      requestedModelId: modelId,
      requestedTargetProjectId: targetProjectId,
      requestedReasoningStrength: reasoningStrength
    })
    const groupRouting = baseRuntimeContext.group
      ? parseGroupRouting(baseRuntimeContext.group, getLastUserMessageText(messages))
      : null
    const directGroupReply = resolveDirectGroupReplyRoute(baseRuntimeContext.group, messages, groupRouting)
    const routedAgentId = groupRouting?.mode === 'mentioned_agent_decides'
      ? groupRouting.plannerAgentId
      : directGroupReply?.targetAgentId
    const runtimeContext = routedAgentId
      ? resolveAgentRuntimeContext({
          messages,
          agentId: routedAgentId,
          groupId,
          channelBindingId,
          requestedProviderId: providerId,
          requestedModelId: modelId,
          requestedTargetProjectId: targetProjectId,
          requestedReasoningStrength: reasoningStrength
        })
      : baseRuntimeContext
    const directGroupReplyPromptSection = directGroupReply
      ? buildDirectGroupReplyPromptSection(directGroupReply)
      : null
    const activePagePromptSection = buildActivePagePromptSection(activePageContext)
    const rustHarness = await startSelectedRustHarness()
    const requestWindow = getSenderWindow(event) || getMainWindow()
    const group = runtimeContext.group
    const groupDeliberation = group && !directGroupReply
      ? await runWithAiRequestWindow(requestWindow, async () => {
          if (rustHarness) {
            const client = mainState.rustHarness
            if (!client) throw new Error('Rust harness client is not initialized.')
            return await buildNativeRustGroupDeliberation({
              client,
              planner: rustHarness,
              group,
              agents: Array.from(new Set([group.coordinatorAgentId, ...group.memberAgentIds]))
                .map(id => agentStore.get(id))
                .filter((agent): agent is AgentDefinition => Boolean(agent)),
              messages,
              routing: groupRouting || parseGroupRouting(group, getLastUserMessageText(messages)),
              sessionId: `rust-native-group-${randomUUID()}`,
              context: {
                workspaceRoot: resolvedFolderWorkspaceRoot,
                targetProjectId: runtimeContext.effectiveTargetProjectId,
                enableThinking: runtimeContext.providerConfig?.enableThinking,
                reasoningEffort: runtimeContext.providerConfig?.reasoningEffort,
                temperature: runtimeContext.providerConfig?.temperature,
                systemPromptSections: [
                  ...(folderWorkspacePromptSection ? [folderWorkspacePromptSection] : []),
                  ...(activePagePromptSection ? [activePagePromptSection] : [])
                ],
                activeSkillContents: runtimeContext.activeSkillContents,
                memoryScopes: runtimeContext.memoryScopes,
                memoryQuery: getLastUserMessageText(messages)
              }
            })
          }
          return await buildGroupDeliberationSection({
            messages,
            group,
            routing: groupRouting || undefined,
            channelBinding: runtimeContext.channelBinding,
            targetProjectId: runtimeContext.effectiveTargetProjectId,
            fallbackReasoningStrength: reasoningStrength,
            runtimeRequestContext: {
              workspaceRoot: resolvedFolderWorkspaceRoot,
              memoryScopes: runtimeContext.memoryScopes
            }
          })
        })
      : { promptSection: null, transcript: null }

    return await runWithAiRequestWindow(requestWindow, async () => {
      const requestOptions = {
        agentId: runtimeContext.agent?.id || agentId,
        targetProjectId: runtimeContext.effectiveTargetProjectId,
        workspaceRoot: resolvedFolderWorkspaceRoot,
        providerConfig: runtimeContext.providerConfig,
        activeSkillContents: runtimeContext.activeSkillContents,
        systemPromptSections: [
          ...runtimeContext.systemPromptSections,
          ...(folderWorkspacePromptSection ? [folderWorkspacePromptSection] : []),
          ...(activePagePromptSection ? [activePagePromptSection] : []),
          ...(directGroupReplyPromptSection ? [directGroupReplyPromptSection] : []),
          ...(groupDeliberation.promptSection ? [groupDeliberation.promptSection] : [])
        ],
        allowedToolNames: runtimeContext.allowedToolNames,
        deniedToolNames: runtimeContext.deniedToolNames,
        memoryScopes: runtimeContext.memoryScopes
      }
      if (rustHarness) return await rustHarness.chat(messages, requestOptions)
      return await aiEngine.chat(messages, requestOptions)
    })
  })

  // AI chat streaming — pushes events to renderer via per-session channel
  ipcMain.handle('ai:chatStream', async (event: IpcMainInvokeEvent, messages: Array<{ role: string; content: MessageContent }>, sessionId: string, conversationId?: string, providerId?: string, modelId?: string, targetProjectId?: string, authMode?: AIExecutionAuthMode, reasoningStrength?: 'low' | 'medium' | 'high' | 'max', agentId?: string, groupId?: string, channelBindingId?: string, activePageContext?: ActivePageAutomationContext, temperature?: number, folderWorkspaceRoot?: string) => {
    const sender = event.sender
    const senderWindow = getSenderWindow(event) || getMainWindow()
    const channel = `ai:stream-event:${sessionId}`
    const abortController = new AbortController()
    const authModeRef = { current: authMode ?? 'strict' }
    // Register before any asynchronous context resolution so a stop request
    // arriving immediately after invocation can always find this stream.
    activeChatSessions.set(sessionId, {
      abortController,
      authMode: authModeRef
    })
    const executionPreferences = settingsStore!.getAIExecutionPreferences()
    const resolvedFolderWorkspaceRoot = await resolveFolderWorkspaceRootForRequest(folderWorkspaceRoot)
    const folderWorkspacePromptSection = buildFolderWorkspacePromptSection(resolvedFolderWorkspaceRoot)
    const baseRuntimeContext = resolveAgentRuntimeContext({
      messages,
      agentId,
      groupId,
      channelBindingId,
      requestedProviderId: providerId,
      requestedModelId: modelId,
      requestedTargetProjectId: targetProjectId,
      requestedReasoningStrength: reasoningStrength,
      requestedTemperature: temperature
    })
    const groupRouting = baseRuntimeContext.group
      ? parseGroupRouting(baseRuntimeContext.group, getLastUserMessageText(messages))
      : null
    const directGroupReply = resolveDirectGroupReplyRoute(baseRuntimeContext.group, messages, groupRouting)
    const routedAgentId = groupRouting?.mode === 'mentioned_agent_decides'
      ? groupRouting.plannerAgentId
      : directGroupReply?.targetAgentId
    const runtimeContext = routedAgentId
      ? resolveAgentRuntimeContext({
          messages,
          agentId: routedAgentId,
          groupId,
          channelBindingId,
          requestedProviderId: providerId,
          requestedModelId: modelId,
          requestedTargetProjectId: targetProjectId,
          requestedReasoningStrength: reasoningStrength,
          requestedTemperature: temperature
        })
      : baseRuntimeContext
    const directGroupReplyPromptSection = directGroupReply
      ? buildDirectGroupReplyPromptSection(directGroupReply)
      : null
    const activePagePromptSection = buildActivePagePromptSection(activePageContext)
    const rustHarness = await startSelectedRustHarness()
    const conversationTitle = getConversationTitleFromMessages(messages)
    const executedToolNames: string[] = []
    const aiLogger = executionPreferences.enableAiLogging && aiLogStore && conversationId
      ? aiLogStore.createSessionLogger({
          conversationId,
          title: conversationTitle,
          sessionId,
          uploadedMessages: messages,
          providerId: providerId || runtimeContext.agent?.providerId,
          modelId: modelId || runtimeContext.agent?.modelId,
          authMode,
          targetProjectId: runtimeContext.effectiveTargetProjectId
        })
      : undefined
    const TEXT_STREAM_FLUSH_INTERVAL_MS = 33
    let pendingTokenContent = ''
    let pendingThinkingContent = ''
    let textFlushTimer: ReturnType<typeof setTimeout> | null = null

    const sendEventToRenderer = (event: Record<string, unknown>) => {
      if (sender.isDestroyed()) return

      try {
        sender.send(channel, event)
      } catch (serErr) {
        console.error('[ai:chatStream] Stream event serialization failed:', serErr)
        aiLogger?.logError('stream', serErr as Error, {
          streamEventType: typeof event.type === 'string' ? event.type : 'unknown'
        })

        try {
          const safe: Record<string, unknown> = { type: typeof event.type === 'string' ? event.type : 'unknown' }
          if ('content' in event) safe.content = String(event.content || '')
          if ('name' in event) safe.name = String(event.name || '')
          if ('error' in event) safe.error = String(event.error || '')
          if ('stage' in event) safe.stage = String(event.stage || '')
          if ('detail' in event) safe.detail = String(event.detail || '')
          if ('active' in event) safe.active = Boolean(event.active)
          if ('groupId' in event) safe.groupId = String(event.groupId || '')
          if ('totalCost' in event) safe.totalCost = Number(event.totalCost || 0)
          if ('inputTokens' in event) safe.inputTokens = Number(event.inputTokens || 0)
          if ('outputTokens' in event) safe.outputTokens = Number(event.outputTokens || 0)
          if ('items' in event) {
            try {
              safe.items = JSON.parse(JSON.stringify(event.items ?? []))
            } catch {
              safe.items = []
            }
          }
          if ('filePath' in event) safe.filePath = String(event.filePath || '')
          if ('truncated' in event) safe.truncated = Boolean(event.truncated)
          if ('lineCount' in event) safe.lineCount = Number(event.lineCount || 0)
          if ('added' in event) safe.added = Number(event.added || 0)
          if ('removed' in event) safe.removed = Number(event.removed || 0)
          if ('query' in event) safe.query = String(event.query || '')
          if ('engine' in event) safe.engine = String(event.engine || '')
          if ('results' in event) {
            try {
              safe.results = JSON.parse(JSON.stringify(event.results ?? []))
            } catch {
              safe.results = []
            }
          }
          if ('result' in event) {
            try {
              safe.result = JSON.parse(JSON.stringify(event.result))
            } catch {
              safe.result = String(event.result ?? '')
            }
          }
          if ('groupProgress' in event) {
            try {
              safe.groupProgress = JSON.parse(JSON.stringify(event.groupProgress))
            } catch {
              safe.groupProgress = null
            }
          }
          if ('sidechat' in event) {
            try {
              safe.sidechat = JSON.parse(JSON.stringify(event.sidechat))
            } catch {
              safe.sidechat = null
            }
          }
          if ('transcript' in event) {
            try {
              safe.transcript = JSON.parse(JSON.stringify(event.transcript))
            } catch {
              safe.transcript = null
            }
          }
          if ('plan' in event) {
            try {
              safe.plan = JSON.parse(JSON.stringify(event.plan))
            } catch {
              safe.plan = null
            }
          }
          if ('message' in event) {
            const msg = event.message as { role?: unknown; content?: unknown } | undefined
            if (msg) {
              safe.message = {
                role: typeof msg.role === 'string' ? msg.role : 'assistant',
                content: typeof msg.content === 'string' ? msg.content : ''
              }
            }
          }
          sender.send(channel, safe)
        } catch (fallbackErr) {
          console.error('[ai:chatStream] Fallback send also failed:', fallbackErr)
          aiLogger?.logError('stream', fallbackErr as Error, {
            phase: 'fallback-send',
            streamEventType: typeof event.type === 'string' ? event.type : 'unknown'
          })
        }
      }
    }

    const flushBufferedTextEvents = () => {
      if (textFlushTimer) {
        clearTimeout(textFlushTimer)
        textFlushTimer = null
      }

      if (pendingThinkingContent) {
        sendEventToRenderer({ type: 'thinking', content: pendingThinkingContent })
        pendingThinkingContent = ''
      }

      if (pendingTokenContent) {
        sendEventToRenderer({ type: 'token', content: pendingTokenContent })
        pendingTokenContent = ''
      }
    }

    const scheduleBufferedTextFlush = () => {
      if (textFlushTimer || sender.isDestroyed()) return

      textFlushTimer = setTimeout(() => {
        textFlushTimer = null
        flushBufferedTextEvents()
      }, TEXT_STREAM_FLUSH_INTERVAL_MS)
    }

    const enqueueBufferedTextEvent = (event: { type: 'token' | 'thinking'; content: string }) => {
      if (event.type === 'thinking') {
        pendingThinkingContent += event.content
      } else {
        pendingTokenContent += event.content
      }
      scheduleBufferedTextFlush()
    }
    // Progress callback: sends progress events directly to renderer in real-time
    const onProgress: GroupDeliberationProgressCallback = (stageOrEvent, detail) => {
      if (!sender.isDestroyed()) {
        flushBufferedTextEvents()
        if (typeof stageOrEvent === 'string') {
          sendEventToRenderer({ type: 'progress', stage: stageOrEvent, detail })
          return
        }
        sendEventToRenderer(stageOrEvent as unknown as Record<string, unknown>)
      }
    }
    let groupDeliberation = { promptSection: null, transcript: null } as Awaited<ReturnType<typeof buildGroupDeliberationSection>>
    let groupTranscriptSent = false
    const emitGroupTranscriptIfNeeded = () => {
      if (groupTranscriptSent || !groupDeliberation.transcript || sender.isDestroyed()) {
        return
      }

      flushBufferedTextEvents()
      sendEventToRenderer({
        type: 'group_transcript',
        transcript: groupDeliberation.transcript
      })
      groupTranscriptSent = true
    }
    try {
      if (abortController.signal.aborted) {
        throw abortController.signal.reason instanceof Error
          ? abortController.signal.reason
          : new Error(USER_ABORT_MESSAGE)
      }
      groupDeliberation = runtimeContext.group && !directGroupReply
        ? await runWithAiRequestWindow(senderWindow, async () => {
            const group = runtimeContext.group
            if (!group) {
              return { promptSection: null, transcript: null }
            }
            if (rustHarness) {
              const client = mainState.rustHarness
              if (!client) throw new Error('Rust harness client is not initialized.')
              return await buildNativeRustGroupDeliberation({
                client,
                planner: rustHarness,
                group,
                agents: Array.from(new Set([group.coordinatorAgentId, ...group.memberAgentIds]))
                  .map(id => agentStore.get(id))
                  .filter((agent): agent is AgentDefinition => Boolean(agent)),
                messages,
                routing: groupRouting || parseGroupRouting(group, getLastUserMessageText(messages)),
                sessionId,
                abortSignal: abortController.signal,
                onProgress,
                context: {
                  hostConversationId: conversationId,
                  authMode: authModeRef.current,
                  getAuthMode: () => authModeRef.current,
                  workspaceRoot: resolvedFolderWorkspaceRoot,
                  targetProjectId: runtimeContext.effectiveTargetProjectId,
                  enableThinking: runtimeContext.providerConfig?.enableThinking,
                  reasoningEffort: runtimeContext.providerConfig?.reasoningEffort,
                  temperature: runtimeContext.providerConfig?.temperature,
                  systemPromptSections: [
                    ...(folderWorkspacePromptSection ? [folderWorkspacePromptSection] : []),
                    ...(activePagePromptSection ? [activePagePromptSection] : [])
                  ],
                  activeSkillContents: runtimeContext.activeSkillContents,
                  memoryScopes: runtimeContext.memoryScopes,
                  memoryQuery: getLastUserMessageText(messages)
                }
              })
            }
            return await buildGroupDeliberationSection({
              messages,
              group,
              routing: groupRouting || undefined,
              channelBinding: runtimeContext.channelBinding,
              targetProjectId: runtimeContext.effectiveTargetProjectId,
              fallbackReasoningStrength: reasoningStrength,
              onProgress,
              sessionId,
              abortSignal: abortController.signal,
              runtimeRequestContext: {
                hostConversationId: conversationId,
                hostSessionId: sessionId,
                workspaceRoot: resolvedFolderWorkspaceRoot,
                authMode: authModeRef.current,
                getAuthMode: () => authModeRef.current,
                memoryScopes: runtimeContext.memoryScopes
              }
            })
          })
        : { promptSection: null, transcript: null }

      await runWithAiRequestWindow(senderWindow, async () => {
        const requestOptions = {
          agentId: runtimeContext.agent?.id || agentId,
          conversationId,
          sessionId,
          targetProjectId: runtimeContext.effectiveTargetProjectId,
          workspaceRoot: resolvedFolderWorkspaceRoot,
          providerConfig: runtimeContext.providerConfig,
          abortSignal: abortController.signal,
          authMode: authModeRef.current,
          getAuthMode: () => authModeRef.current,
          aiLogger,
          activeSkillContents: runtimeContext.activeSkillContents,
          systemPromptSections: [
            ...runtimeContext.systemPromptSections,
            ...(folderWorkspacePromptSection ? [folderWorkspacePromptSection] : []),
            ...(activePagePromptSection ? [activePagePromptSection] : []),
            ...(directGroupReplyPromptSection ? [directGroupReplyPromptSection] : []),
            ...(groupDeliberation.promptSection ? [groupDeliberation.promptSection] : [])
          ],
          allowedToolNames: runtimeContext.allowedToolNames,
          deniedToolNames: runtimeContext.deniedToolNames,
          memoryScopes: runtimeContext.memoryScopes
        }
        const stream = rustHarness
          ? rustHarness.chatStream(messages, onProgress, requestOptions)
          : aiEngine.chatStream(messages, onProgress, requestOptions)
        for await (const streamEvent of stream) {
          if (streamEvent.type === 'tool_start' && streamEvent.name) {
            executedToolNames.push(streamEvent.name)
          }

          if (streamEvent.type === 'done') {
            notifyAiTaskStatus(executionPreferences, messages, 'completed')
            aiLogger?.finish('completed', streamEvent.message)

            if (rustHarness && mainState.rustHarness) {
              try {
                await mainState.rustHarness.ingestMemory({
                  agent: runtimeContext.agent,
                  scopes: runtimeContext.memoryScopes,
                  userMessages: getAllUserMessageTexts(messages),
                  finalAssistantText: getMessageText(streamEvent.message.content),
                  toolNames: executedToolNames,
                  sourceConversationId: conversationId,
                  sourceSessionId: sessionId
                })
              } catch (memoryError) {
                console.error('[ai:chatStream] Failed to ingest Rust memory:', memoryError)
                aiLogger?.logError('session', memoryError as Error, { phase: 'rust-memory-ingest', sessionId, conversationId })
              }
            } else if (memoryEngine) {
              try {
                memoryEngine.ingestSessionMemory({
                  agent: runtimeContext.agent,
                  group: runtimeContext.group,
                  channelBinding: runtimeContext.channelBinding,
                  userMessages: getAllUserMessageTexts(messages),
                  finalAssistantText: getMessageText(streamEvent.message.content),
                  toolNames: executedToolNames,
                  targetProjectId: runtimeContext.effectiveTargetProjectId,
                  sourceConversationId: conversationId,
                  sourceSessionId: sessionId,
                  userId: 'local-user',
                  enabledScopeTypes: runtimeContext.memoryScopeTypes
                })
              } catch (memoryError) {
                console.error('[ai:chatStream] Failed to ingest memory:', memoryError)
                aiLogger?.logError('session', memoryError as Error, { phase: 'memory-ingest', sessionId, conversationId })
              }
            }
          }
          if (streamEvent.type === 'done' || streamEvent.type === 'error') {
            emitGroupTranscriptIfNeeded()
          }
          if (sender.isDestroyed()) break
          if ((streamEvent.type === 'token' || streamEvent.type === 'thinking') && streamEvent.content) {
            enqueueBufferedTextEvent(streamEvent)
            continue
          }

          flushBufferedTextEvents()
          sendEventToRenderer(streamEvent as unknown as Record<string, unknown>)
        }
      })
    } catch (err) {
      flushBufferedTextEvents()
      const errorMessage = (err as Error).message
      const finalStatus = errorMessage === USER_ABORT_MESSAGE ? 'stopped' : 'failed'
      notifyAiTaskStatus(
        executionPreferences,
        messages,
        finalStatus,
        errorMessage === USER_ABORT_MESSAGE ? t('mainDialog.userAbortedTask') : errorMessage
      )
      aiLogger?.logError('stream', err as Error, { sessionId, conversationId })
      aiLogger?.finish(finalStatus)
      if (!sender.isDestroyed()) {
        emitGroupTranscriptIfNeeded()
        sendEventToRenderer(errorMessage === USER_ABORT_MESSAGE
          ? { type: 'stopped' }
          : { type: 'error', error: errorMessage })
      }
    } finally {
      flushBufferedTextEvents()
      if (activeChatSessions.get(sessionId)?.abortController === abortController) {
        activeChatSessions.delete(sessionId)
      }
    }
    return { ok: true }
  })

  ipcMain.handle('ai:updateSessionAuthMode', async (_event: IpcMainInvokeEvent, sessionId: string, authMode: AIExecutionAuthMode) => {
    // Session ownership is more reliable than the current global preference:
    // a user can switch back to TS while an existing Rust stream is still
    // running.  Keep authorization updates flowing to that stream.
    const sessionState = activeChatSessions.get(sessionId)
    if (sessionState) sessionState.authMode.current = authMode
    const rustUpdated = mainState.rustHarness?.hasSession(sessionId) === true
    if (rustUpdated) {
      mainState.rustHarness?.setSessionAuthMode(sessionId, authMode)
    }
    if (!rustUpdated && !sessionState) {
      return { ok: true, updated: false }
    }
    return { ok: true, updated: true }
  })

  // R5 · Inject a user clarification into a running group deliberation.
  // The stream session id prevents concurrent conversations using the same
  // group from receiving each other's clarifications.
  ipcMain.handle('ai:groupInject', async (_event: IpcMainInvokeEvent, sessionId: string, groupId: string, content: string, targetAgentIds?: string[]) => {
    if (hasNativeRustGroupSession(sessionId)) {
      return await injectNativeRustGroup(sessionId, groupId, content, targetAgentIds)
    }
    const session = groupSessionRegistry.get(sessionId)
    if (!session) {
      return { ok: false, injected: false, error: 'No active group session for this stream.' }
    }
    if (session.groupId !== groupId) {
      return { ok: false, injected: false, error: 'The active group session does not match this conversation.' }
    }
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, injected: false, error: 'content is required.' }
    }
    try {
      const injection = session.inject({
        content: content.trim(),
        targetAgentIds: Array.isArray(targetAgentIds) ? targetAgentIds : undefined
      })
      return { ok: true, injected: true, injection }
    } catch (error) {
      return { ok: false, injected: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ai:stopStream', async (_event: IpcMainInvokeEvent, sessionId: string) => {
    const controller = activeChatSessions.get(sessionId)?.abortController
    if (!controller || controller.signal.aborted) {
      try {
        const rustStopped = await mainState.rustHarness?.stopSession(sessionId)
        return { ok: true, stopped: rustStopped === true }
      } catch (error) {
        // A harness process can exit between the renderer's stop request and
        // chat.abort. Stopping is best-effort; do not turn that race into an
        // unhandled renderer IPC rejection.
        console.warn('[ai:stopStream] Failed to stop Rust harness stream:', error)
        return { ok: true, stopped: false }
      }
    }
    controller.abort(new Error(USER_ABORT_MESSAGE))
    return { ok: true, stopped: true }
  })

  // Conversation history
  ipcMain.handle('conversations:list', async () => {
    return chatHistory!.list()
  })

  ipcMain.handle('conversations:get', async (_event: IpcMainInvokeEvent, id: string) => {
    return chatHistory!.get(id)
  })

  ipcMain.handle('conversations:save', async (_event: IpcMainInvokeEvent, conversation: Conversation) => {
    chatHistory!.save(conversation)
    return { success: true }
  })

  ipcMain.handle('conversations:rename', async (_event: IpcMainInvokeEvent, id: string, title: string) => {
    return { success: chatHistory!.rename(id, title) }
  })

  ipcMain.handle('conversations:delete', async (_event: IpcMainInvokeEvent, id: string) => {
    return chatHistory!.delete(id)
  })

  ipcMain.handle('agents:list', async () => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.listAgents()
    return agentStore!.list()
  })

  ipcMain.handle('agents:get', async (_event: IpcMainInvokeEvent, id: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.getAgent(id)
    return agentStore!.get(id)
  })

  ipcMain.handle('agents:save', async (_event: IpcMainInvokeEvent, agent: Partial<AgentDefinition>) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      const saved = await rustClient.saveAgent(agent, t('mainDialog.untitledAgent'))
      // Keep the TS files as a handoff mirror; Rust remains the active source.
      agentStore?.save(saved)
      notifyAgentWorkspaceChanged({ entity: 'agent', action: 'saved', id: saved.id })
      return saved
    }
    const saved = agentStore!.save(agent)
    notifyAgentWorkspaceChanged({ entity: 'agent', action: 'saved', id: saved.id })
    return saved
  })

  ipcMain.handle('agents:delete', async (_event: IpcMainInvokeEvent, id: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      const deleted = await rustClient.deleteAgent(id)
      if (deleted) {
        agentStore?.delete(id)
        notifyAgentWorkspaceChanged({ entity: 'agent', action: 'deleted', id })
      }
      return deleted
    }
    const deleted = agentStore!.delete(id)
    if (deleted) {
      notifyAgentWorkspaceChanged({ entity: 'agent', action: 'deleted', id })
    }
    return deleted
  })

  ipcMain.handle('agentWorkspace:listToolDefinitions', async () => {
    const selectedHarness = await startSelectedRustHarness()
    return (selectedHarness || aiEngine).getAvailableTools()
      .map(tool => ({
        name: tool.name,
        description: getAgentWorkspaceToolDescription(tool.name, tool.description)
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  })

  ipcMain.handle('agentGroups:list', async () => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.listAgentGroups()
    return agentGroupStore!.list()
  })

  ipcMain.handle('agentGroups:get', async (_event: IpcMainInvokeEvent, id: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.getAgentGroup(id)
    return agentGroupStore!.get(id)
  })

  ipcMain.handle('agentGroups:save', async (_event: IpcMainInvokeEvent, group: Partial<AgentGroupDefinition>) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      const saved = await rustClient.saveAgentGroup(group, t('mainDialog.untitledAgentGroup'))
      // Keep the legacy file catalog as a migration mirror.  It is never read
      // while Rust is selected, but makes a Rust -> TypeScript handoff lossless.
      agentGroupStore?.save(saved)
      notifyAgentWorkspaceChanged({ entity: 'group', action: 'saved', id: saved.id })
      return saved
    }
    const saved = agentGroupStore!.save(group)
    notifyAgentWorkspaceChanged({ entity: 'group', action: 'saved', id: saved.id })
    return saved
  })

  ipcMain.handle('agentGroups:delete', async (_event: IpcMainInvokeEvent, id: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      const deleted = await rustClient.deleteAgentGroup(id)
      if (deleted) {
        // Remove the handoff mirror as well; Rust remains the source of truth
        // for all reads until the user explicitly switches back to TypeScript.
        agentGroupStore?.delete(id)
        notifyAgentWorkspaceChanged({ entity: 'group', action: 'deleted', id })
      }
      return deleted
    }
    const deleted = agentGroupStore!.delete(id)
    if (deleted) {
      notifyAgentWorkspaceChanged({ entity: 'group', action: 'deleted', id })
    }
    return deleted
  })

  ipcMain.handle('im:listConnectors', async () => {
    return channelBindingStore!.listConnectors()
  })

  ipcMain.handle('im:listBindings', async () => {
    return channelBindingStore!.list()
  })

  ipcMain.handle('im:getBinding', async (_event: IpcMainInvokeEvent, id: string) => {
    return channelBindingStore!.get(id)
  })

  ipcMain.handle('im:saveBinding', async (_event: IpcMainInvokeEvent, binding: Partial<ChannelBinding>) => {
    const saved = channelBindingStore!.save(binding)
    notifyAgentWorkspaceChanged({ entity: 'binding', action: 'saved', id: saved.id })
    return saved
  })

  ipcMain.handle('im:deleteBinding', async (_event: IpcMainInvokeEvent, id: string) => {
    const deleted = channelBindingStore!.delete(id)
    if (deleted) {
      notifyAgentWorkspaceChanged({ entity: 'binding', action: 'deleted', id })
    }
    return deleted
  })

  ipcMain.handle('im:testBinding', async (_event: IpcMainInvokeEvent, id: string, text?: string) => {
    const binding = channelBindingStore!.get(id)
    if (!binding) {
      throw new Error(t('mainDialog.imBindingMissing'))
    }
    const messageText = typeof text === 'string' && text.trim()
      ? text.trim()
      : t('mainDialog.imBindingDefaultTestMessage')
    const event: ChannelEvent = {
      connectorType: binding.connectorType,
      channelId: binding.externalChannelId || 'test-channel',
      threadId: binding.externalThreadId,
      messageId: `test_${Date.now().toString(36)}`,
      senderId: 'test-user',
      senderName: t('mainDialog.imBindingTestSender'),
      text: messageText,
      createdAt: new Date().toISOString()
    }
    const reply = await generateImGatewayReply(binding, event)
    return { ok: true, reply }
  })

  ipcMain.handle('memory:list', async (_event: IpcMainInvokeEvent, options?: { query?: string; scopes?: MemorySearchScope[]; memoryTypes?: MemoryType[]; limit?: number; scopeType?: AgentMemoryScope; scopeId?: string }) => {
    const scopes = options?.scopes || (options?.scopeType && options?.scopeId
      ? [{ scopeType: options.scopeType, scopeId: options.scopeId }]
      : undefined)

    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      return await rustClient.listMemory({
        query: options?.query,
        scopes,
        memoryTypes: options?.memoryTypes,
        limit: options?.limit
      })
    }

    return memoryStore!.search({
      query: options?.query,
      scopes,
      memoryTypes: options?.memoryTypes,
      limit: options?.limit
    })
  })

  ipcMain.handle('memory:save', async (_event: IpcMainInvokeEvent, entry: Partial<MemoryEntry>) => {
    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    const summary = typeof entry.summary === 'string' ? entry.summary.trim() : ''
    const scopeType = entry.scopeType || 'user'
    const scopeId = typeof entry.scopeId === 'string' && entry.scopeId.trim() ? entry.scopeId.trim() : 'local-user'
    const memoryType = entry.memoryType || 'knowledge'

    if (!title) throw new Error(t('mainDialog.memoryTitleRequired'))
    if (!summary) throw new Error(t('mainDialog.memorySummaryRequired'))

    const normalizedEntry: MemoryEntry = {
      id: entry.id || `manual_${randomUUID()}`,
      scopeType,
      scopeId,
      memoryType,
      title,
      summary,
      details: typeof entry.details === 'string' && entry.details.trim() ? entry.details.trim() : undefined,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      sourceConversationId: entry.sourceConversationId,
      sourceSessionId: entry.sourceSessionId,
      sourceMessageIds: Array.isArray(entry.sourceMessageIds) ? entry.sourceMessageIds : [],
      importance: Number.isFinite(Number(entry.importance)) ? Math.max(0, Math.min(1, Number(entry.importance))) : 0.7,
      confidence: Number.isFinite(Number(entry.confidence)) ? Math.max(0, Math.min(1, Number(entry.confidence))) : 1,
      pinned: entry.pinned ?? true,
      lastUsedAt: entry.lastUsedAt,
      createdAt: entry.createdAt || new Date().toISOString(),
      updatedAt: entry.updatedAt || new Date().toISOString()
    }
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.saveMemory(normalizedEntry)
    return memoryStore!.upsert(normalizedEntry)
  })

  ipcMain.handle('memory:pin', async (_event: IpcMainInvokeEvent, id: string, pinned: boolean) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.pinMemory(id, pinned)
    return memoryEngine!.pinMemory(id, pinned)
  })

  ipcMain.handle('memory:delete', async (_event: IpcMainInvokeEvent, id: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.deleteWorkspaceMemory(id)
    return memoryEngine!.deleteMemory(id)
  })

  ipcMain.handle('memory:compact', async (): Promise<MemoryCompactionResult> => {
    if (mainState.activeMemoryCompactionPromise) return mainState.activeMemoryCompactionPromise
    mainState.activeMemoryCompactionPromise = runMemoryCompactionWithStatus()
    return mainState.activeMemoryCompactionPromise
  })

  ipcMain.handle('memory:compactStatus', async (): Promise<MemoryCompactionStatus> => {
    // Compaction status is a renderer-facing orchestration snapshot. The
    // actual scan/apply operation is Rust-owned in Rust mode, while this
    // process keeps the same progress events for both backends.
    return cloneMemoryCompactionStatus()
  })

  ipcMain.handle('media:saveImage', async (event: IpcMainInvokeEvent, imageUrl: string, defaultName?: string) => {
    const senderWindow = getSenderWindow(event) || getMainWindow()
    const { buffer, mimeType } = await resolveImageBuffer(imageUrl)
    const extension = guessImageExtension(mimeType)
    const safeDefaultName = (defaultName && defaultName.trim()) || `worldbase-image.${extension}`
    const finalDefaultName = safeDefaultName.includes('.') ? safeDefaultName : `${safeDefaultName}.${extension}`

    const dialogOptions = {
      title: t('mainDialog.saveImageTitle'),
      defaultPath: finalDefaultName,
      filters: [
        {
          name: 'Image',
          extensions: [extension]
        }
      ]
    }

    const result = senderWindow
      ? await dialog.showSaveDialog(senderWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)

    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }

    await fs.writeFile(result.filePath, buffer)
    return { success: true, filePath: result.filePath }
  })

  // --- Drawing studio (image generation / editing) ---
  ipcMain.handle('image:generate', async (_event: IpcMainInvokeEvent, req: ImageStudioGenerateRequest): Promise<ImageStudioGenerateResponse> => {
    if (!settingsStore) return { ok: false, error: t('mainDialog.settingsNotInitialized') }

    // A selected and successfully started Rust harness is the execution
    // authority for Studio too. Electron only indexes the image files Rust
    // wrote into the shared user-data/image-library directory.
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      try {
        const generated = await mainState.rustHarness.studioGenerate(rustStudioParams(req))
        const entries = generated.entries
          .map(entry => rustStudioImageEntry(entry, req))
          .filter((entry): entry is ImageLibraryEntry => Boolean(entry))
        if (entries.length === 0) {
          throw new Error('Rust Studio completed without image entries')
        }
        broadcastToAppWindows('image:library:changed', { source: 'rust' })
        return { ok: true, entries }
      } catch (error) {
        // Do not execute the same request again through TypeScript after Rust
        // accepted it; that would duplicate a billable generation/edit task.
        return { ok: false, error: rustStudioError(req, error) }
      }
    }

    if (!imageLibraryStore) return { ok: false, error: t('mainDialog.imageLibraryNotInitialized') }
    return runImageStudioRequest(req, {
      getProvidersConfig: () => settingsStore!.getProviders(),
      imageLibraryStore
    })
  })

  ipcMain.handle('image:library:query', async (_event: IpcMainInvokeEvent, opts: ImageLibraryQuery): Promise<ImageLibraryPage> => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      const page = await mainState.rustHarness.studioLibraryQuery({ ...(opts ?? {}) })
      const items = (page.images || [])
        .map(rustStudioImageItem)
        .filter((item): item is ImageLibraryItem => Boolean(item))
      const total = typeof page.total === 'number' && Number.isFinite(page.total) ? page.total : items.length
      return {
        items,
        total,
        nextOffset: typeof page.nextOffset === 'number' ? page.nextOffset : null
      }
    }
    return imageLibraryStore?.query(opts ?? {}) ?? { items: [], total: 0, nextOffset: null }
  })

  // Hand off any AI-agent-queued generation/edit tasks to the studio and clear the
  // buffer atomically, so two concurrent drains never double-enqueue.
  ipcMain.handle('image:studio:drainPendingTasks', async (): Promise<ImageStudioGenerateRequest[]> => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.studioTasksDrain()
    return drainPendingStudioImageTasks()
  })

  // Persist the studio task queue across app restarts so failed/queued tasks are
  // still there (and retryable) the next time the studio opens.
  ipcMain.handle('image:studio:loadTasks', async (): Promise<ImageStudioTask[]> => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.studioTasksLoad()
    return studioTaskStore?.load() ?? []
  })

  ipcMain.handle('image:studio:saveTasks', async (_event: IpcMainInvokeEvent, tasks: ImageStudioTask[]): Promise<void> => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      await rustClient.studioTasksSave(Array.isArray(tasks) ? tasks : [])
      // Keep a handoff mirror for an explicit Rust -> TypeScript transition;
      // Rust remains the source of truth while it is selected.
      studioTaskStore?.save(Array.isArray(tasks) ? tasks : [])
      return
    }
    studioTaskStore?.save(Array.isArray(tasks) ? tasks : [])
  })

  // --- Usage statistics (token usage per provider/model/day) ---
  ipcMain.handle('usage:getDaily', async (_event: IpcMainInvokeEvent, from?: string, to?: string): Promise<UsageRecord[]> => {
    return usageStore?.getDaily(from, to) ?? []
  })

  ipcMain.handle('usage:getSummary', async (_event: IpcMainInvokeEvent, from?: string, to?: string): Promise<UsageSummary[]> => {
    return usageStore?.getSummary(from, to) ?? []
  })

  ipcMain.handle('usage:clear', async (_event: IpcMainInvokeEvent, beforeDate?: string): Promise<{ removed: number }> => {
    return { removed: usageStore?.clear(beforeDate) ?? 0 }
  })

  ipcMain.handle('image:library:getData', async (_event: IpcMainInvokeEvent, id: string): Promise<ImageLibraryData | null> => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      const result = await mainState.rustHarness.studioLibraryRead(id)
      if (!result?.dataUrl) return null
      return {
        dataUrl: result.dataUrl,
        sourceDataUrls: Array.isArray(result.sourceDataUrls) && result.sourceDataUrls.length > 0
          ? result.sourceDataUrls
          : undefined
      }
    }
    return imageLibraryStore?.getImageData(id) ?? null
  })

  ipcMain.handle('image:library:delete', async (_event: IpcMainInvokeEvent, ids: string[]): Promise<{ removed: number }> => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      const result = await mainState.rustHarness.studioLibraryDeleteMany(Array.isArray(ids) ? ids : [])
      if (result.removed > 0) broadcastToAppWindows('image:library:changed', { source: 'rust' })
      return { removed: result.removed || 0 }
    }
    return { removed: imageLibraryStore?.deleteMany(ids ?? []) ?? 0 }
  })

  ipcMain.handle('image:library:setFolder', async (_event: IpcMainInvokeEvent, ids: string[], folder: string | undefined): Promise<{ updated: number }> => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      const result = await mainState.rustHarness.studioLibrarySetFolder(Array.isArray(ids) ? ids : [], folder)
      if (result.updated > 0) broadcastToAppWindows('image:library:changed', { source: 'rust' })
      return { updated: result.updated || 0 }
    }
    return { updated: imageLibraryStore?.setFolder(ids ?? [], folder) ?? 0 }
  })

  ipcMain.handle('image:library:setTags', async (_event: IpcMainInvokeEvent, id: string, tags: string[]): Promise<{ ok: boolean }> => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      const result = await mainState.rustHarness.studioLibrarySetTags(id, Array.isArray(tags) ? tags : [])
      if (result.updated) broadcastToAppWindows('image:library:changed', { source: 'rust' })
      return { ok: result.updated === true }
    }
    return { ok: imageLibraryStore?.setTags(id, tags ?? []) ?? false }
  })

  ipcMain.handle('image:library:listFolders', async (): Promise<ImageLibraryFolderCard[]> => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      return (await mainState.rustHarness.studioLibraryListFolders())
        .map(rustStudioFolderCard)
        .filter((folder): folder is ImageLibraryFolderCard => Boolean(folder))
    }
    return imageLibraryStore?.listFolders() ?? []
  })

  ipcMain.handle('image:library:createFolder', async (_event: IpcMainInvokeEvent, name: string): Promise<ImageLibraryFolderCard[]> => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      const folders = await mainState.rustHarness.studioLibraryCreateFolder(name ?? '')
      broadcastToAppWindows('image:library:changed', { source: 'rust' })
      return folders
        .map(rustStudioFolderCard)
        .filter((folder): folder is ImageLibraryFolderCard => Boolean(folder))
    }
    return imageLibraryStore?.createFolder(name ?? '') ?? []
  })

  ipcMain.handle('image:library:exportFolder', async (event: IpcMainInvokeEvent, folderName: string): Promise<{ success?: boolean; canceled?: boolean; filePath?: string; count?: number; error?: string }> => {
    try {
      const senderWindow = getSenderWindow(event) || getMainWindow()
      const rustHarness = await startSelectedRustHarness()
      const nativeRust = rustHarness ? mainState.rustHarness : null
      const filePaths = nativeRust
        ? []
        : imageLibraryStore?.folderImagePaths(folderName ?? '') ?? []
      if (nativeRust) {
        const page = await nativeRust.studioLibraryQuery({ folder: folderName ?? '', limit: 1, offset: 0 })
        if (!page.total) return { error: t('mainDialog.noImagesToExportInFolder') }
      } else if (filePaths.length === 0) {
        return { error: t('mainDialog.noImagesToExportInFolder') }
      }

      const safeFolderLabel = (folderName?.trim() || t('mainDialog.ungroupedFolder')).replace(/[\\/:*?"<>|]/g, '_')
      const dialogOptions = {
        title: t('mainDialog.exportFolderZipTitle'),
        defaultPath: `worldbase-${safeFolderLabel}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
      }
      const result = senderWindow
        ? await dialog.showSaveDialog(senderWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)
      if (result.canceled || !result.filePath) {
        return { canceled: true }
      }

      if (nativeRust) {
        const exported = await nativeRust.studioLibraryExport(folderName ?? '', result.filePath)
        return { success: true, filePath: exported.filePath || result.filePath, count: exported.count || 0 }
      }

      const JSZip = (await import('jszip')).default
      const archive = new JSZip()
      const usedNames = new Set<string>()
      for (const fp of filePaths) {
        let entryName = path.basename(fp)
        // Guard against duplicate basenames inside the archive.
        if (usedNames.has(entryName)) {
          const ext = path.extname(entryName)
          entryName = `${path.basename(entryName, ext)}-${usedNames.size}${ext}`
        }
        usedNames.add(entryName)
        archive.file(entryName, await fs.readFile(fp))
      }
      const buffer = await archive.generateAsync({ type: 'nodebuffer' })
      await fs.writeFile(result.filePath, buffer)
      return { success: true, filePath: result.filePath, count: filePaths.length }
    } catch (error) {
      return { error: error instanceof Error ? error.message : t('mainDialog.exportFailed') }
    }
  })

  ipcMain.handle('image:library:listTags', async (): Promise<string[]> => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) return await mainState.rustHarness.studioLibraryListTags()
    return imageLibraryStore?.listAllTags() ?? []
  })

  ipcMain.handle('image:library:renameFolder', async (_event: IpcMainInvokeEvent, oldName: string, newName: string): Promise<{ updated: number }> => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      const result = await mainState.rustHarness.studioLibraryRenameFolder(oldName, newName)
      // Empty folders produce `updated: 0`, but their registry still changed.
      // Notify every gallery window after any successful Rust mutation.
      broadcastToAppWindows('image:library:changed', { source: 'rust' })
      return { updated: result.updated || 0 }
    }
    const updated = imageLibraryStore?.renameFolder(oldName, newName) ?? 0
    broadcastToAppWindows('image:library:changed', { source: 'ts' })
    return { updated }
  })

  ipcMain.handle('image:library:deleteFolder', async (_event: IpcMainInvokeEvent, folderName: string): Promise<{ updated: number }> => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      const result = await mainState.rustHarness.studioLibraryDeleteFolder(folderName)
      // Deleting an empty folder is still a visible gallery change.
      broadcastToAppWindows('image:library:changed', { source: 'rust' })
      return { updated: result.updated || 0 }
    }
    const updated = imageLibraryStore?.deleteFolder(folderName) ?? 0
    broadcastToAppWindows('image:library:changed', { source: 'ts' })
    return { updated }
  })

  ipcMain.handle('image:prompt:optimize', async (_event: IpcMainInvokeEvent, req: { providerId: string; model: string; prompt: string; isNegative?: boolean }): Promise<{ ok: boolean; optimizedPrompt?: string; error?: string }> => {
    try {
      const providersConfig = settingsStore!.getProviders()
      const provider = providersConfig.providers.find(p => p.id === req.providerId)
      if (!provider) throw new Error(t('mainDialog.providerNotFound'))
      if (!provider.apiKey) throw new Error(t('mainDialog.providerApiKeyMissing'))
      const model = provider.models.includes(req.model) ? req.model : provider.activeModel
      if (!model) throw new Error(t('mainDialog.providerNoModels'))

      const systemPrompt = req.isNegative
        ? '你是一个专业的AI绘画提示词优化专家。用户会给你一段负向提示词（negative prompt），请优化它使其更加专业、精确、有效。负向提示词用于描述不希望在图片中出现的元素。请直接返回优化后的负向提示词文本，不要添加任何解释或前缀。保持与用户输入相同的语言。'
        : '你是一个专业的AI绘画提示词优化专家。用户会给你一段图片生成提示词（prompt），请优化它使其更加专业、详细、生动，能够帮助AI模型生成更高质量的图片。请直接返回优化后的提示词文本，不要添加任何解释或前缀。保持与用户输入相同的语言。'

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: req.prompt }
      ]

      // Prompt optimization is a model request too. Honor the selected
      // harness so the image workflow exercises Rust provider execution when
      // Rust is enabled, while retaining the legacy provider as startup
      // fallback during the migration.
      const rustHarness = await startSelectedRustHarness()
      let optimized = ''
      if (rustHarness) {
        optimized = getMessageText((await rustHarness.chat([
            { role: 'user', content: req.prompt }
          ], {
            providerConfig: {
              apiKey: provider.apiKey,
              baseUrl: provider.baseUrl,
              model,
              apiProtocol: provider.apiProtocol,
              providerId: provider.id,
              providerName: provider.name
            },
            systemPromptSections: [systemPrompt],
            // This is intentionally a JSON-free, tool-free completion.
            // Supplying an unmatched allow-list disables both native and
            // Electron-hosted tools in the Rust loop.
            allowedToolNames: ['__image_prompt_optimization_no_tools__']
          })).content).trim()
      } else {
        const aiProvider = createProvider({
          baseUrl: provider.baseUrl,
          apiProtocol: provider.apiProtocol
        })
        aiProvider.setApiKey(provider.apiKey)
        aiProvider.setBaseUrl(provider.baseUrl)
        aiProvider.setModel(model)
        const result = await aiProvider.chatCompletion(messages)
        optimized = typeof result.content === 'string' ? result.content.trim() : ''
      }
      if (!optimized) throw new Error(t('mainDialog.aiNoValidResult'))

      return { ok: true, optimizedPrompt: optimized }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : t('mainDialog.promptOptimizeFailed') }
    }
  })

  ipcMain.handle('media:saveMarkdown', async (event: IpcMainInvokeEvent, markdown: string, defaultName?: string) => {
    const senderWindow = getSenderWindow(event) || getMainWindow()
    const safeDefaultName = (defaultName && defaultName.trim()) || 'worldbase-ai-response.md'
    const finalDefaultName = safeDefaultName.toLowerCase().endsWith('.md') ? safeDefaultName : `${safeDefaultName}.md`

    const dialogOptions = {
      title: t('mainDialog.exportMarkdownTitle'),
      defaultPath: finalDefaultName,
      filters: [
        {
          name: 'Markdown',
          extensions: ['md']
        }
      ]
    }

    const result = senderWindow
      ? await dialog.showSaveDialog(senderWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)

    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }

    await fs.writeFile(result.filePath, markdown, 'utf-8')
    return { success: true, filePath: result.filePath }
  })

  ipcMain.handle('chat:readUploadedOfficeFile', async (_event: IpcMainInvokeEvent, filePath: string) => {
    const resolvedPath = path.resolve(filePath)
    const stat = await fs.stat(resolvedPath)

    if (!stat.isFile()) {
      throw new Error(t('mainDialog.notAFile', { path: resolvedPath }))
    }

    if (stat.size > MAX_CHAT_UPLOADED_OFFICE_FILE_SIZE_BYTES) {
      throw new Error(t('mainDialog.fileTooLargeTenMb', { size: (stat.size / 1024 / 1024).toFixed(1) }))
    }

    if (!isOfficeFile(resolvedPath)) {
      throw new Error(t('mainDialog.unsupportedOfficeFormat', { extension: path.extname(resolvedPath) || 'unknown' }))
    }

    const result = await readOfficeFile(resolvedPath)

    return {
      filePath: resolvedPath,
      fileName: path.basename(resolvedPath),
      size: stat.size,
      fileType: detectOfficeType(resolvedPath) || result.type,
      content: result.content.substring(0, MAX_UPLOADED_OFFICE_CONTENT_LENGTH)
    }
  })

  ipcMain.handle('chat:readUploadedAttachmentFile', async (_event: IpcMainInvokeEvent, filePath: string) => {
    return readUploadedAttachmentFromPath(filePath)
  })

  ipcMain.handle('chat:readUploadedAttachmentBuffer', async (_event: IpcMainInvokeEvent, payload: UploadedAttachmentBufferPayload) => {
    const bytes = payload?.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array()
    return readUploadedAttachmentFromBuffer(Buffer.from(bytes), {
      fileName: payload?.fileName || '',
      fileType: payload?.fileType
    })
  })

  // ─── Document import / preview / selection ───────────────────────────

  ipcMain.handle('document:import', async (_event: IpcMainInvokeEvent, filePath: string) => {
    const resolvedPath = path.resolve(filePath)
    const stat = await fs.stat(resolvedPath)
    if (!stat.isFile()) throw new Error(t('mainDialog.notAFile', { path: resolvedPath }))
    if (stat.size > MAX_DOCUMENT_WORKBENCH_FILE_SIZE_BYTES) {
      throw new Error(t('mainDialog.fileTooLargeDocumentWorkbench', { size: (stat.size / 1024 / 1024).toFixed(1) }))
    }
    if (!isSupportedDocument(resolvedPath)) {
      throw new Error(t('mainDialog.unsupportedDocumentFormat', { extension: path.extname(resolvedPath) || 'unknown' }))
    }
    const artifact = await parseDocument(resolvedPath)
    documentStore!.addArtifact(artifact)
    return { artifact }
  })

  ipcMain.handle('document:pickFiles', async (event: IpcMainInvokeEvent) => {
    const senderWindow = getSenderWindow(event) || getMainWindow()
    const dialogOptions = {
      title: t('mainDialog.importDocumentTitle'),
      filters: [
        { name: t('mainDialog.documentFilterName'), extensions: ['pdf', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt'] }
      ],
      properties: ['openFile' as const, 'multiSelections' as const]
    }
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, filePaths: [] }
    return { canceled: false, filePaths: result.filePaths }
  })

  ipcMain.handle('office:pickFiles', async (event: IpcMainInvokeEvent) => {
    const senderWindow = getSenderWindow(event) || getMainWindow()
    const dialogOptions = {
      title: t('mainDialog.uploadOfficeTitle'),
      filters: [
        { name: t('mainDialog.officeDocumentFilterName'), extensions: ['xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt'] }
      ],
      properties: ['openFile' as const, 'multiSelections' as const]
    }
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, filePaths: [] }
    return { canceled: false, filePaths: result.filePaths }
  })

  ipcMain.handle('document:list', async () => {
    return documentStore!.listSummaries()
  })

  ipcMain.handle('document:get', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    return documentStore!.getArtifact(artifactId)
  })

  ipcMain.handle('document:getRenderData', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    const artifact = documentStore!.getArtifact(artifactId)
    if (!artifact) return null
    return readDocumentRenderAsset(artifact.render)
  })

  ipcMain.handle('document:ensureRenderPreview', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    return ensureDocumentRenderPreview(artifactId)
  })

  ipcMain.handle('document:openOriginal', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    const artifact = documentStore!.getArtifact(artifactId)
    if (!artifact) {
      return { success: false, error: t('mainDialog.documentNotFound', { id: artifactId }) }
    }

    const error = await shell.openPath(artifact.filePath)
    if (error) {
      return { success: false, error }
    }

    return { success: true }
  })

  ipcMain.handle('document:getEditSourceState', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    const artifact = documentStore.getArtifact(artifactId)
    if (!artifact) throw new Error(t('mainDialog.documentNotFound', { id: artifactId }))
    const stat = await fs.stat(artifact.filePath)
    return {
      sha256: await calculateDocumentSha256(artifact.filePath),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    }
  })

  ipcMain.handle('document:pickEditImage', async (event: IpcMainInvokeEvent) => {
    const senderWindow = getSenderWindow(event) || getMainWindow()
    const options = {
      title: t('mainDialog.pickDocumentEditImageTitle'),
      filters: [{ name: t('mainDialog.imageFileFilterName'), extensions: ['png', 'jpg', 'jpeg'] }],
      properties: ['openFile' as const]
    }
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    return { canceled: false, image: await readDocumentEditImage(result.filePaths[0]) }
  })

  ipcMain.handle('document:exportEditCopy', async (event: IpcMainInvokeEvent, request: DocumentEditExportRequest) => {
    const artifact = documentStore.getArtifact(request.artifactId)
    if (!artifact) throw new Error(t('mainDialog.documentNotFound', { id: request.artifactId }))
    if (artifact.fileType !== 'pdf' && artifact.fileType !== 'docx') {
      throw new Error(t('mainDialog.documentEditingUnsupportedFormat', { fileType: artifact.fileType }))
    }

    const currentSha256 = await calculateDocumentSha256(artifact.filePath)
    if (currentSha256 !== request.sourceSha256) {
      throw new Error(t('mainDialog.documentSourceChanged'))
    }

    const extension = artifact.fileType === 'pdf' ? '.pdf' : '.docx'
    const parsedPath = path.parse(artifact.filePath)
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
    const defaultPath = path.join(parsedPath.dir, `${parsedPath.name}-edited-${timestamp}${extension}`)
    const senderWindow = getSenderWindow(event) || getMainWindow()
    const options = {
      title: t('mainDialog.saveDocumentCopyTitle'),
      defaultPath,
      filters: [{
        name: artifact.fileType === 'pdf' ? 'PDF' : 'Word',
        extensions: [extension.slice(1)]
      }]
    }
    const result = senderWindow
      ? await dialog.showSaveDialog(senderWindow, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }

    const outputPath = path.extname(result.filePath).toLowerCase() === extension
      ? result.filePath
      : `${result.filePath}${extension}`
    await exportDocumentCopy(artifact.filePath, outputPath, artifact.fileType, request.operations)

    const exportedArtifact = await parseDocument(outputPath)
    documentStore.addArtifact(exportedArtifact)
    const hydratedArtifact = await ensureDocumentRenderPreview(exportedArtifact.id)
    return {
      canceled: false,
      filePath: outputPath,
      artifact: hydratedArtifact || exportedArtifact
    }
  })

  ipcMain.handle('document:remove', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    return documentStore!.removeArtifact(artifactId)
  })

  ipcMain.handle('document:createSelection', async (_event: IpcMainInvokeEvent, payload: CreateSelectionPayload) => {
    return documentStore!.createSelection(payload)
  })

  ipcMain.handle('document:removeSelection', async (_event: IpcMainInvokeEvent, regionId: string) => {
    return documentStore!.removeSelection(regionId)
  })

  ipcMain.handle('document:updateSelectionLabel', async (_event: IpcMainInvokeEvent, regionId: string, label: string) => {
    return documentStore!.updateSelectionLabel(regionId, label)
  })

  ipcMain.handle('document:getSelections', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    return documentStore!.getSelectionsForArtifact(artifactId)
  })

  ipcMain.handle('document:buildSelectionsPrompt', async (_event: IpcMainInvokeEvent, regionIds?: string[]) => {
    return documentStore!.buildSelectionsPrompt(regionIds)
  })

  // ─── Folder workspace preview ────────────────────────────────────────

  ipcMain.handle('folderWorkspace:pickFolder', async (event: IpcMainInvokeEvent): Promise<FolderWorkspacePickResult> => {
    const senderWindow = getSenderWindow(event) || getMainWindow()
    const dialogOptions = {
      title: t('mainDialog.chooseCodeWorkspaceFolderTitle'),
      properties: ['openDirectory' as const]
    }
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }

    const rootPath = path.resolve(result.filePaths[0])
    return {
      canceled: false,
      rootPath,
      rootName: getFolderWorkspaceRootName(rootPath)
    }
  })

  ipcMain.handle('folderWorkspace:listFiles', async (_event: IpcMainInvokeEvent, rootPath: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('workspace.list', { rootPath })
    return listFolderWorkspaceFiles(rootPath)
  })

  ipcMain.handle('folderWorkspace:readFile', async (_event: IpcMainInvokeEvent, rootPath: string, filePath: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('workspace.read', { rootPath, filePath })
    return readFolderWorkspaceFile(rootPath, filePath)
  })

  // Project management
  ipcMain.handle('projects:list', async () => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      const native = await rustClient.call<Record<string, unknown>>('project.list', {})
      const projects = Array.isArray(native.projects)
        ? native.projects.filter((project): project is Record<string, unknown> => Boolean(project && typeof project === 'object' && !Array.isArray(project)))
        : []
      return await Promise.all(projects.map(async project => {
        const projectId = typeof project.id === 'string' ? project.id : ''
        if (!projectId) return project
        try {
          const runtime = await rustClient.call<Record<string, unknown>>('project.status', { projectId })
          return { ...project, runtime }
        } catch (error) {
          return {
            ...project,
            runtime: {
              projectId,
              status: 'error',
              error: error instanceof Error ? error.message : String(error)
            }
          }
        }
      }))
    }
    const projects = await projectFS!.listProjects()
    return projects.map(project => ({ ...project, runtime: runtimeManager!.getStatus(project.id) }))
  })

  ipcMain.handle('projects:get', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.get', { projectId })
    return projectFS!.getProjectMeta(projectId)
  })

  ipcMain.handle('projects:getFileTree', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Array<Record<string, unknown>>>('project.tree', { projectId })
    return projectFS!.getFileTree(projectId)
  })

  ipcMain.handle('projects:readFile', async (_event: IpcMainInvokeEvent, projectId: string, filePath: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      const native = await rustClient.call<Record<string, unknown>>('project.file.read', { projectId, filePath })
      if (typeof native.content !== 'string') throw new Error('Rust project read returned no content')
      return native.content
    }
    return projectFS!.readFile(projectId, filePath)
  })

  ipcMain.handle('projects:writeFile', async (_event: IpcMainInvokeEvent, projectId: string, filePath: string, content: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.file.write', { projectId, filePath, content })
    await projectFS!.writeFile(projectId, filePath, content)
    return { success: true }
  })

  ipcMain.handle('projects:updateAppearance', async (_event: IpcMainInvokeEvent, projectId: string, updates: { name?: string; icon?: string }) => {
    const rustClient = await selectedRustProjectClient()
    const meta = rustClient
      ? await rustClient.call<Record<string, unknown>>('project.meta.update', { projectId, updates })
      : await projectFS!.updateProjectMeta(projectId, updates)

    const projectWindow = projectWindows.get(projectId)
    if (projectWindow && !projectWindow.isDestroyed()) {
      projectWindow.setTitle((meta.name as string) || projectId)
    }

    broadcastToAppWindows('projects:changed', { action: 'updated', projectId })
    return meta
  })

  ipcMain.handle('projects:delete', async (_event: IpcMainInvokeEvent, projectId: string) => {
    if (!projectId || typeof projectId !== 'string') {
      throw new TypeError(`Invalid project ID: ${String(projectId)}`)
    }
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      await rustClient.call<Record<string, unknown>>('project.delete', { projectId })
    } else {
      // Stop the project first if running
      try { await runtimeManager!.stop(projectId) } catch { /* ignore */ }
      await projectFS!.deleteProject(projectId)
    }
    broadcastToAppWindows('projects:changed', { action: 'deleted', projectId })
    return { success: true }
  })

  ipcMain.handle('projects:exportPackage', async (event: IpcMainInvokeEvent, projectId: string) => {
    if (!projectId || typeof projectId !== 'string') {
      throw new TypeError(`Invalid project ID: ${String(projectId)}`)
    }

    const rustClient = await selectedRustProjectClient()
    const meta = rustClient
      ? await rustClient.call<Record<string, unknown>>('project.get', { projectId })
      : await projectFS!.getProjectMeta(projectId)
    const senderWindow = getSenderWindow(event) || getMainWindow()
    const dialogOptions = {
      title: t('mainDialog.exportAppPackageTitle'),
      defaultPath: createProjectPackageDefaultName((meta.name as string) || projectId, projectId),
      filters: [
        { name: t('mainDialog.appPackageFilterName'), extensions: [PROJECT_PACKAGE_EXTENSION] }
      ]
    }

    const result = senderWindow
      ? await dialog.showSaveDialog(senderWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true }
    }

    const exported = rustClient
      ? await rustClient.call<Record<string, unknown>>('project.package.export', { projectId, filePath: result.filePath })
      : await projectPackageService!.exportPackage(projectId, result.filePath)
    return {
      success: true,
      filePath: exported.filePath,
      projectId: exported.projectId,
      projectName: exported.projectName,
      includedBuildArtifacts: exported.includedBuildArtifacts
    }
  })

  ipcMain.handle('projects:importPackage', async (event: IpcMainInvokeEvent) => {
    const senderWindow = getSenderWindow(event) || getMainWindow()
    const dialogOptions = {
      title: t('mainDialog.importAppPackageTitle'),
      filters: [
        { name: t('mainDialog.appPackageFilterName'), extensions: [PROJECT_PACKAGE_EXTENSION] }
      ],
      properties: ['openFile' as const, 'multiSelections' as const]
    }

    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true, importedProjects: [] }
    }

    const rustClient = await selectedRustProjectClient()
    const importedProjects = [] as Array<{ projectId: string; name: string; filePath: string }>
    for (const filePath of result.filePaths) {
      const imported = rustClient
        ? await rustClient.call<Record<string, unknown>>('project.package.import', { filePath })
        : await projectPackageService!.importPackage(filePath)
      const importedMeta = imported.meta && typeof imported.meta === 'object' ? imported.meta as Record<string, unknown> : {}
      importedProjects.push({
        projectId: String(imported.projectId),
        name: (importedMeta.name as string) || String(imported.projectId),
        filePath: String(imported.filePath)
      })
      broadcastToAppWindows('projects:changed', { action: 'imported', projectId: String(imported.projectId), source: rustClient ? 'rust' : undefined })
    }

    return {
      success: true,
      filePaths: result.filePaths,
      importedProjects
    }
  })

  ipcMain.handle('projects:importPackageFromFile', async (_event: IpcMainInvokeEvent, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') {
      throw new TypeError(`Invalid package file path: ${String(filePath)}`)
    }

    const rustClient = await selectedRustProjectClient()
    const imported = rustClient
      ? await rustClient.call<Record<string, unknown>>('project.package.import', { filePath })
      : await projectPackageService!.importPackage(filePath)
    const importedMeta = imported.meta && typeof imported.meta === 'object' ? imported.meta as Record<string, unknown> : {}
    broadcastToAppWindows('projects:changed', { action: 'imported', projectId: String(imported.projectId), source: rustClient ? 'rust' : undefined })
    return {
      success: true,
      filePath: imported.filePath,
      importedProject: {
        projectId: String(imported.projectId),
        name: (importedMeta.name as string) || String(imported.projectId)
      }
    }
  })

  // Runtime management
  ipcMain.handle('runtime:start', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      const start = async (install: boolean): Promise<Record<string, unknown>> => {
        return await mainState.rustHarness!.call<Record<string, unknown>>('project.dev.start', {
          project: projectId,
          install
        })
      }
      let native: Record<string, unknown>
      try {
        native = await start(false)
      } catch (error) {
        // Match Electron RuntimeManager's first-start behavior without handing
        // the process to TS: Rust performs the install, then owns the retry.
        if (!/next not installed|node_modules/i.test(error instanceof Error ? error.message : String(error))) {
          throw error
        }
        await start(true)
        native = await start(false)
      }
      const port = typeof native.port === 'number' ? native.port : undefined
      const status = typeof native.status === 'string' && native.status.trim()
        ? native.status
        : 'starting'
      if (status === 'starting' || status === 'running' || status === 'already_running') {
        broadcastToAppWindows('projects:changed', { action: 'started', projectId, port, source: 'rust' })
      }
      return {
        ...native,
        projectId,
        port,
        status
      }
    }
    const result = await runtimeManager!.start(projectId)
    if (result.status === 'running' || result.status === 'already_running') {
      broadcastToAppWindows('projects:changed', { action: 'started', projectId, port: result.port })
    }
    return result
  })

  ipcMain.handle('runtime:stop', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      const native = await mainState.rustHarness.call<Record<string, unknown>>('project.dev.stop', { project: projectId })
      const stopped = native.stopped === true
      const status = stopped ? 'stopped' : 'not_running'
      if (stopped) {
        broadcastToAppWindows('projects:changed', { action: 'stopped', projectId, source: 'rust' })
      }
      return { ...native, projectId, status }
    }
    const result = await runtimeManager!.stop(projectId)
    if (result.status === 'stopped') {
      broadcastToAppWindows('projects:changed', { action: 'stopped', projectId })
    }
    return result
  })

  ipcMain.handle('runtime:status', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustHarness = await startSelectedRustHarness()
    if (rustHarness && mainState.rustHarness) {
      return await mainState.rustHarness.call<Record<string, unknown>>('project.status', { project: projectId })
    }
    return runtimeManager!.getStatus(projectId)
  })

  ipcMain.handle('system:getStatus', async () => {
    return systemService!.getStatus()
  })

  // Build management
  ipcMain.handle('build:run', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.build.run', { projectId })
    return builderService!.build(projectId)
  })

  ipcMain.handle('build:cleanup', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.build.cleanup', { projectId })
    return builderService!.cleanup(projectId)
  })

  ipcMain.handle('build:rebuild', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.build.rebuild', { projectId })
    return builderService!.rebuild(projectId)
  })

  ipcMain.handle('build:needsRebuild', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      const native = await rustClient.call<Record<string, unknown>>('project.build.needsRebuild', { projectId })
      return native.needsRebuild === true
    }
    return builderService!.needsRebuild(projectId)
  })

  // Gateway / service management
  ipcMain.handle('gateway:serviceMap', async () => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.gateway.serviceMap', {})
    return appGateway!.getServiceMap()
  })

  ipcMain.handle('gateway:startAll', async () => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.gateway.startAll', {})
    return appGateway!.startAll()
  })

  ipcMain.handle('gateway:stopAll', async () => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.gateway.stopAll', {})
    await appGateway!.stopAll()
    return { success: true }
  })

  ipcMain.handle('gateway:setRestartPolicy', async (_event: IpcMainInvokeEvent, projectId: string, policy: 'always' | 'on-failure' | 'never') => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.gateway.setRestartPolicy', { projectId, policy })
    appGateway!.setRestartPolicy(projectId, policy)
    return { success: true }
  })

  // Process management
  ipcMain.handle('process:getSnapshot', async () => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.process.snapshot', {})
    return processManagerService!.getSnapshot()
  })

  ipcMain.handle('process:restart', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      const result = await rustClient.call<Record<string, unknown>>('project.process.restart', { projectId })
      if (result.success) broadcastToAppWindows('projects:changed', { action: 'started', projectId, source: 'rust' })
      return result
    }
    const result = await processManagerService!.restartProject(projectId)
    if (result.success) {
      broadcastToAppWindows('projects:changed', { action: 'started', projectId })
    }
    return result
  })

  ipcMain.handle('process:stop', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      const result = await rustClient.call<Record<string, unknown>>('project.process.stop', { projectId })
      if (result.success) broadcastToAppWindows('projects:changed', { action: 'stopped', projectId, source: 'rust' })
      return result
    }
    const result = await processManagerService!.stopProject(projectId)
    if (result.success) {
      broadcastToAppWindows('projects:changed', { action: 'stopped', projectId })
    }
    return result
  })

  ipcMain.handle('process:forceKill', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      const result = await rustClient.call<Record<string, unknown>>('project.process.forceKill', { projectId })
      if (result.success) broadcastToAppWindows('projects:changed', { action: 'stopped', projectId, source: 'rust' })
      return result
    }
    const result = await processManagerService!.forceKillProject(projectId)
    if (result.success) {
      broadcastToAppWindows('projects:changed', { action: 'stopped', projectId })
    }
    return result
  })

  ipcMain.handle('process:killOrphan', async (_event: IpcMainInvokeEvent, pid: number) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.process.killOrphan', { pid })
    return processManagerService!.killOrphanProcess(pid)
  })

  // Data access
  ipcMain.handle('data:query', async (_event: IpcMainInvokeEvent, projectId: string, sql: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Array<Record<string, unknown>>>('project.data.query', { projectId, sql })
    return dataAccess!.queryDatabase(projectId, sql)
  })

  ipcMain.handle('data:summary', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.data.summary', { projectId })
    return dataAccess!.getDataSummary(projectId)
  })

  // List all databases across all projects (for the settings DB viewer)
  ipcMain.handle('data:listAll', async () => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Array<Record<string, unknown>>>('project.data.listAll', {})
    return dataAccess!.listAllDatabases()
  })

  // Query a table for the DB viewer with pagination
  ipcMain.handle('data:queryTable', async (_event: IpcMainInvokeEvent, projectId: string, tableName: string, page: number, pageSize: number) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<Record<string, unknown>>('project.data.queryTable', { projectId, tableName, page, pageSize })
    return dataAccess!.queryTableForViewer(projectId, tableName, { page, pageSize })
  })

  // Get table schema for a project
  ipcMain.handle('data:getSchema', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) return await rustClient.call<JsonRpcResult>('project.data.schema', { projectId })
    return dataAccess!.getTableSchema(projectId)
  })

  // Settings — legacy flat AI settings
  ipcMain.handle('settings:getAI', async () => {
    return settingsStore!.getAISettings()
  })

  ipcMain.handle('settings:saveAI', async (_event: IpcMainInvokeEvent, config: { apiKey?: string; baseUrl?: string; model?: string }) => {
    settingsStore!.saveAISettings(config)
    aiEngine.configure(config)
    mainState.rustHarnessEngine?.configure(config)
    return { success: true }
  })

  // Settings — multi-provider
  ipcMain.handle('settings:getProviders', async () => {
    return settingsStore!.getProviders()
  })

  ipcMain.handle('settings:fetchProviderModels', async (_event: IpcMainInvokeEvent, input: { baseUrl: string; apiKey: string; apiProtocol?: 'openai' | 'anthropic' }) => {
    return { models: await fetchProviderModels(input) }
  })

  ipcMain.handle('settings:saveProviders', async (_event: IpcMainInvokeEvent, config: AIProvidersConfig) => {
    settingsStore!.saveProviders(config)
    const normalizedConfig = applyActiveProviderToAiEngine()
    if (settingsStore!.getAIExecutionPreferences().harnessBackend === 'rust' && mainState.rustHarness?.isAvailable()) {
      try {
        await mainState.rustHarness.syncProviders()
      } catch (error) {
        // Provider settings are already durable in Electron. A transient Rust
        // startup failure must not make the settings UI report a failed save;
        // chatStream retries this sync before its next Rust request.
        console.warn('[settings:saveProviders] Rust harness sync deferred:', error)
      }
    }
    broadcastToAppWindows('settings:providersChanged', normalizedConfig)
    return { success: true }
  })

  ipcMain.handle('settings:getMcpServers', async () => {
    return settingsStore!.getMcpServers()
  })

  ipcMain.handle('settings:saveMcpServers', async (_event: IpcMainInvokeEvent, servers: MCPServerConfig[]) => {
    settingsStore!.saveMcpServers(servers)
    await applyMcpServersToService()
    return { success: true }
  })

  ipcMain.handle('settings:getMcpState', async () => {
    return await getMcpStateForSelectedHarness()
  })

  ipcMain.handle('settings:refreshMcpServer', async (_event: IpcMainInvokeEvent, serverId?: string) => {
    return await refreshMcpServerForSelectedHarness(serverId)
  })

  ipcMain.handle('settings:disconnectMcpServer', async (_event: IpcMainInvokeEvent, serverId: string) => {
    return await disconnectMcpServerForSelectedHarness(serverId)
  })

  ipcMain.handle('settings:getThemePreference', async () => {
    return settingsStore!.getThemePreference()
  })

  ipcMain.handle('app:getAboutInfo', async () => {
    return updateService!.getAboutInfo()
  })

  ipcMain.handle('appUpdate:getState', async () => {
    return updateService!.getState()
  })

  ipcMain.handle('appUpdate:getConfig', async () => {
    return updateService!.getConfig()
  })

  ipcMain.handle('appUpdate:check', async (_event: IpcMainInvokeEvent, options?: { channel?: AppUpdateChannel }) => {
    return updateService!.checkForUpdates(options?.channel)
  })

  ipcMain.handle('appUpdate:saveConfig', async (_event: IpcMainInvokeEvent, config: AppUpdateConfig) => {
    const saved = updateService!.saveConfig(config)
    return { success: true, config: saved }
  })

  ipcMain.handle('appUpdate:download', async () => {
    return updateService!.downloadUpdate()
  })

  ipcMain.handle('appUpdate:install', async () => {
    return updateService!.installDownloadedUpdate()
  })

  ipcMain.handle('appUpdate:openWebsite', async (_event: IpcMainInvokeEvent, kind: AppUpdateWebsiteKind) => {
    return updateService!.openWebsitePage(kind)
  })

  ipcMain.handle('settings:saveThemePreference', async (_event: IpcMainInvokeEvent, preference: 'system' | 'light' | 'dark') => {
    settingsStore!.saveThemePreference(preference)
    return { success: true }
  })

  ipcMain.handle('settings:getLanguagePreference', async () => {
    return settingsStore!.getLanguagePreference()
  })

  ipcMain.handle('settings:saveLanguagePreference', async (_event: IpcMainInvokeEvent, preference: LanguagePreference) => {
    settingsStore!.saveLanguagePreference(preference)
    setMainLocale(preference)
    return { success: true }
  })

  ipcMain.handle('settings:getAIExecutionPreferences', async () => {
    return settingsStore!.getAIExecutionPreferences()
  })

  ipcMain.handle('settings:saveAIExecutionPreferences', async (_event: IpcMainInvokeEvent, preferences: AIExecutionPreferences) => {
    const previous = settingsStore!.getAIExecutionPreferences()
    settingsStore!.saveAIExecutionPreferences(preferences)
    const next = settingsStore!.getAIExecutionPreferences()
    try {
      await transitionHarnessOwnership(
        previous.harnessBackend,
        next.harnessBackend,
        mainState.rustHarness?.isRunning() ?? false,
        {
          stopTypeScriptHealthChecks: async () => await appGateway.stopHealthChecks(),
          startTypeScriptHealthChecks: () => appGateway.startHealthChecks(),
          startRustHarness: async () => { await startSelectedRustHarness() },
          stopTypeScriptProjects: async () => await runtimeManager.stopAll(),
          handoffRustToTypeScript: async () => {
            // Native Rust image tools may have handed requests to the Rust
            // queue while no Studio window was mounted. Move those requests
            // into Electron's transient handoff buffer before disposing Rust,
            // otherwise a TS selection would strand them in the old process.
            const pendingImageTasks = await mainState.rustHarness?.studioTasksDrain() ?? []
            if (pendingImageTasks.length > 0) {
              mainState.pendingStudioImageTasks.push(...pendingImageTasks)
              broadcastToAppWindows('image:studio:tasksAdded', {
                count: pendingImageTasks.length,
                source: 'rust-to-ts'
              })
            }
            await mainState.rustHarness?.handoffToTypeScript()
          },
          rebuildTypeScriptImageLibrary: () => imageLibraryStore?.rebuildIndexFromMirrors(),
          notifyImageLibraryChanged: () => broadcastToAppWindows('image:library:changed', { source: 'rust-to-ts' }),
          onRustHandoffError: error => console.warn('[settings] Rust harness handoff did not complete cleanly:', error)
        }
      )
      await applyMcpServersToService()
    } catch (error) {
      // Do not persist a UI choice that says Rust while the process could not
      // start. The ownership helper has already restored TS health checks for
      // this TS -> Rust transaction; now restore the durable preference and
      // its MCP catalog as well.
      if (previous.harnessBackend === 'ts' && next.harnessBackend === 'rust') {
        settingsStore!.saveAIExecutionPreferences(previous)
        await applyMcpServersToService()
      }
      throw error
    }
    return { success: true }
  })

  ipcMain.handle('settings:getChatFontPreferences', async () => {
    return settingsStore!.getChatFontPreferences()
  })

  ipcMain.handle('settings:saveChatFontPreferences', async (_event: IpcMainInvokeEvent, preferences: ChatFontPreferences) => {
    settingsStore!.saveChatFontPreferences(preferences)
    return { success: true }
  })

  ipcMain.handle('settings:listAILogConversations', async () => {
    return aiLogStore!.listConversations()
  })

  ipcMain.handle('settings:getAILogConversation', async (_event: IpcMainInvokeEvent, conversationId: string) => {
    return aiLogStore!.getConversation(conversationId)
  })

  ipcMain.handle('settings:deleteAILogConversation', async (_event: IpcMainInvokeEvent, conversationId: string) => {
    return aiLogStore!.deleteConversation(conversationId)
  })

  ipcMain.handle('settings:exportConfig', async (event: IpcMainInvokeEvent) => {
    const senderWindow = getSenderWindow(event) || getMainWindow()
    const now = new Date()
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    const dialogOptions = {
      title: t('mainDialog.exportEncryptedConfigTitle'),
      defaultPath: `worldbase-config-${stamp}.${PORTABLE_SETTINGS_EXTENSION}`,
      filters: [
        { name: t('mainDialog.configPackageFilterName'), extensions: [PORTABLE_SETTINGS_EXTENSION] }
      ]
    }

    const result = senderWindow
      ? await dialog.showSaveDialog(senderWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true }
    }

    const serialized = encryptPortableSettingsConfig(settingsStore!.exportPortableConfig(), PORTABLE_SETTINGS_APP_ID)
    await fs.writeFile(result.filePath, serialized, 'utf-8')
    return { success: true, filePath: result.filePath }
  })

  ipcMain.handle('settings:importConfig', async (event: IpcMainInvokeEvent) => {
    const senderWindow = getSenderWindow(event) || getMainWindow()
    const dialogOptions = {
      title: t('mainDialog.importEncryptedConfigTitle'),
      filters: [
        { name: t('mainDialog.configPackageFilterName'), extensions: [PORTABLE_SETTINGS_EXTENSION] }
      ],
      properties: ['openFile' as const]
    }

    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }

    const filePath = result.filePaths[0]
    const serialized = await fs.readFile(filePath, 'utf-8')
    const payload = decryptPortableSettingsConfig(serialized, PORTABLE_SETTINGS_APP_ID)
    const normalizedConfig = settingsStore!.importPortableConfig(payload.config as PortableSettingsConfig)
    const providersConfig = applyActiveProviderToAiEngine()
    await applyMcpServersToService()

    broadcastToAppWindows('settings:providersChanged', providersConfig)

    return {
      success: true,
      filePath,
      importedAt: payload.exportedAt,
      requiresReload: true,
      importedConfig: normalizedConfig
    }
  })

  // Window controls
  ipcMain.handle('window:minimize', (event: IpcMainInvokeEvent) => {
    getSenderWindow(event)?.minimize()
  })

  ipcMain.handle('window:maximize', (event: IpcMainInvokeEvent) => {
    const targetWindow = getSenderWindow(event)
    if (!targetWindow) return

    if (targetWindow.isMaximized()) {
      targetWindow.unmaximize()
    } else {
      targetWindow.maximize()
    }
  })

  ipcMain.handle('window:close', (event: IpcMainInvokeEvent) => {
    getSenderWindow(event)?.close()
  })

  ipcMain.handle('window:isMaximized', (event: IpcMainInvokeEvent) => {
    return getSenderWindow(event)?.isMaximized() ?? false
  })

  ipcMain.handle('window:getBounds', (event: IpcMainInvokeEvent) => {
    return getSenderWindow(event)?.getBounds() ?? null
  })

  ipcMain.handle('window:ensureWidth', async (event: IpcMainInvokeEvent, width: number, options?: EnsureWindowWidthOptions) => {
    const targetWindow = getSenderWindow(event)
    if (!targetWindow) {
      return { applied: false, width: 0 }
    }

    return await ensureWindowHasMinimumWidth(targetWindow, width, options)
  })

  ipcMain.handle('window:setMinimumWidth', (event: IpcMainInvokeEvent, width: number) => {
    const targetWindow = getSenderWindow(event)
    if (!targetWindow) {
      return { success: false, width: 0 }
    }

    return setWindowMinimumWidth(targetWindow, width)
  })

  // Open project folder in system file explorer
  ipcMain.handle('projects:openFolder', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    if (rustClient) {
      // Validate the project through the Rust-owned catalog before Electron
      // performs its host-only shell action.
      await rustClient.call<Record<string, unknown>>('project.get', { projectId })
    }
    const projectDir = path.join(getProjectsDir(), projectId)
    await shell.openPath(projectDir)
    return { success: true }
  })

  // Get LAN server info (local IP and port)
  ipcMain.handle('lan:getInfo', async () => {
    const addresses = getPreferredLanIpv4Addresses()
    return {
      port: LAN_SERVER_PORT,
      addresses,
      baseUrl: addresses.length > 0 ? `http://${addresses[0]}:${LAN_SERVER_PORT}` : `http://127.0.0.1:${LAN_SERVER_PORT}`
    }
  })

  // Get project LAN URL for QR code generation
  ipcMain.handle('projects:getLanUrl', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const rustClient = await selectedRustProjectClient()
    const native = rustClient
      ? await rustClient.call<Record<string, unknown>>('project.status', { projectId })
      : null
    const port = rustClient
      ? (typeof native?.port === 'number' ? native.port : undefined)
      : runtimeManager!.getPort(projectId)
    const addresses = getPreferredLanIpv4Addresses()
    const lanIp = addresses.length > 0 ? addresses[0] : '127.0.0.1'
    const encodedProjectId = encodeURIComponent(projectId)
    return {
      projectPort: port,
      lanUrl: port ? `http://${lanIp}:${port}` : null,
      proxyUrl: `http://${lanIp}:${LAN_SERVER_PORT}/tool/${encodedProjectId}`,
      localProxyUrl: `http://127.0.0.1:${LAN_SERVER_PORT}/tool/${encodedProjectId}`,
      lanIp
    }
  })

  // --- Skill management ---
  ipcMain.handle('skills:list', async () => {
    const skills = skillStore!.list()
    return skills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      fileCount: s.files.length,
      files: s.files,
      scripts: s.scripts,
      tools: s.tools,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    }))
  })

  ipcMain.handle('skills:import', async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      title: t('mainDialog.importSkillTitle'),
      filters: [{ name: t('mainDialog.skillFileFilterName'), extensions: ['md', 'txt', 'zip'] }],
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    const imported: Skill[] = []
    for (const filePath of result.filePaths) {
      imported.push(await skillStore!.importFromFile(filePath))
    }
    if (imported.length > 0) broadcastToAppWindows('skills:changed', { action: 'imported', count: imported.length })
    return imported
  })

  ipcMain.handle('skills:importContent', async (_event: IpcMainInvokeEvent, name: string, content: string, description?: string) => {
    const skill = skillStore!.importFromContent(name, content, description)
    broadcastToAppWindows('skills:changed', { action: 'imported', count: 1 })
    return skill
  })

  ipcMain.handle('skills:delete', async (_event: IpcMainInvokeEvent, id: string) => {
    const deleted = skillStore!.delete(id)
    if (deleted) broadcastToAppWindows('skills:changed', { action: 'deleted', id })
    return deleted
  })

  ipcMain.handle('skills:setActive', async (_event: IpcMainInvokeEvent, skillIds: string[]) => {
    const contents: string[] = []
    for (const id of skillIds) {
      const skill = skillStore!.get(id)
      if (skill) contents.push(skill.content)
    }
    aiEngine.setActiveSkills(contents)
    mainState.rustHarnessEngine?.setActiveSkills(contents)
    return { success: true, count: contents.length }
  })

  // --- Launch mode preferences ---
  ipcMain.handle('settings:getLaunchMode', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return settingsStore!.getLaunchMode(projectId)
  })

  ipcMain.handle('settings:saveLaunchMode', async (_event: IpcMainInvokeEvent, projectId: string, mode: 'embed' | 'window') => {
    settingsStore!.saveLaunchMode(projectId, mode)
    return { success: true }
  })

  ipcMain.handle('settings:getLaunchpadLayout', async () => {
    return settingsStore!.getLaunchpadLayout()
  })

  ipcMain.handle('settings:saveLaunchpadLayout', async (_event: IpcMainInvokeEvent, layout: LaunchpadLayout) => {
    settingsStore!.saveLaunchpadLayout(layout)
    return { success: true }
  })

  ipcMain.handle('settings:getWebApps', async () => {
    const webApps = settingsStore!.getWebApps()
    console.info('[main:web-apps] getWebApps', webApps.map(app => ({
      id: app.id,
      name: app.name,
      url: app.url
    })))
    return webApps
  })

  ipcMain.handle('settings:saveWebApps', async (_event: IpcMainInvokeEvent, webApps: WebAppShortcut[]) => {
    console.info('[main:web-apps] saveWebApps', webApps.map(app => ({
      id: app.id,
      name: app.name,
      url: app.url
    })))
    settingsStore!.saveWebApps(webApps)
    return { success: true }
  })

  ipcMain.handle('settings:getPinnedDockApps', async () => {
    return settingsStore!.getPinnedDockApps()
  })

  ipcMain.handle('settings:savePinnedDockApps', async (_event: IpcMainInvokeEvent, apps: PinnedDockApp[]) => {
    settingsStore!.savePinnedDockApps(apps)
    return { success: true }
  })

  // --- Plan Mode ---
  ipcMain.handle('ai:setPlanMode', async (_event: IpcMainInvokeEvent, active: boolean) => {
    aiEngine.setPlanMode(active)
    mainState.rustHarnessEngine?.setPlanMode(active)
    return { success: true }
  })

  // --- Cost Settings ---
  ipcMain.handle('settings:getCostSettings', async () => {
    return settingsStore!.getCostSettings()
  })

  ipcMain.handle('settings:saveCostSettings', async (_event: IpcMainInvokeEvent, costSettings: { modelPricing: Array<{ model: string; inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }>; budgetLimit: number | null }) => {
    settingsStore!.saveCostSettings(costSettings)
    // Keep both backends in sync so switching does not discard run settings.
    const pricingMap: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }> = {}
    for (const entry of costSettings.modelPricing) {
      pricingMap[entry.model] = {
        inputPerMillion: entry.inputPerMillion,
        outputPerMillion: entry.outputPerMillion,
        cacheReadPerMillion: entry.cacheReadPerMillion || undefined
      }
    }
    aiEngine.setCustomModelPricing(pricingMap)
    aiEngine.setBudgetLimit(costSettings.budgetLimit)
    mainState.rustHarnessEngine?.setCustomModelPricing(pricingMap)
    mainState.rustHarnessEngine?.setBudgetLimit(costSettings.budgetLimit)
    return { success: true }
  })

  ipcMain.handle('scheduler:listTasks', async () => {
    return scheduledTaskService!.listTasks()
  })

  ipcMain.handle('scheduler:saveTask', async (_event: IpcMainInvokeEvent, task: ScheduledTaskDefinition) => {
    return scheduledTaskService!.saveTask(task)
  })

  ipcMain.handle('scheduler:deleteTask', async (_event: IpcMainInvokeEvent, taskId: string) => {
    return scheduledTaskService!.deleteTask(taskId)
  })

  ipcMain.handle('scheduler:runNow', async (_event: IpcMainInvokeEvent, taskId: string) => {
    return scheduledTaskService!.runNow(taskId)
  })

  ipcMain.handle('scheduler:listReports', async (_event: IpcMainInvokeEvent, taskId?: string) => {
    return scheduledTaskService!.listReports(taskId)
  })

  ipcMain.handle('scheduler:getReport', async (_event: IpcMainInvokeEvent, reportId: string) => {
    return scheduledTaskService!.getReport(reportId)
  })

  ipcMain.handle('longTermGoals:list', async () => {
    return longTermGoalService!.listGoals()
  })

  ipcMain.handle('longTermGoals:getSnapshot', async (_event: IpcMainInvokeEvent, goalId?: string) => {
    return longTermGoalService!.getSnapshot(goalId)
  })

  ipcMain.handle('longTermGoals:save', async (_event: IpcMainInvokeEvent, goal: LongTermGoalSaveInput) => {
    return longTermGoalService!.saveGoal(goal)
  })

  ipcMain.handle('longTermGoals:rename', async (_event: IpcMainInvokeEvent, goalId: string, title: string) => {
    return longTermGoalService!.renameGoal(goalId, title)
  })

  ipcMain.handle('longTermGoals:setStatus', async (_event: IpcMainInvokeEvent, goalId: string, status: LongTermGoalSaveInput['status']) => {
    return longTermGoalService!.setGoalStatus(goalId, status || 'active')
  })

  ipcMain.handle('longTermGoals:delete', async (_event: IpcMainInvokeEvent, goalId: string) => {
    return longTermGoalService!.deleteGoal(goalId)
  })

  ipcMain.handle('longTermGoals:deleteMemory', async (_event: IpcMainInvokeEvent, goalId: string, memoryId: string) => {
    return longTermGoalService!.deleteGoalMemory(goalId, memoryId)
  })

  ipcMain.handle('longTermGoals:runNow', async (_event: IpcMainInvokeEvent, goalId: string) => {
    return longTermGoalService!.runGoalNow(goalId)
  })

  ipcMain.handle('longTermGoals:compactMemory', async (event: IpcMainInvokeEvent, goalId: string, streamId?: string) => {
    const sender = event.sender
    const channel = streamId ? `longTermGoals:stream-event:${streamId}` : null
    const onEvent = channel
      ? (goalStreamEvent: LongTermGoalStreamEvent) => {
          if (sender.isDestroyed()) return
          try {
            sender.send(channel, goalStreamEvent)
          } catch (sendErr) {
            console.error('[longTermGoals:compactMemory] Failed to forward stream event:', sendErr)
          }
        }
      : undefined
    return await longTermGoalService!.compactGoalMemoryWithAI(goalId, onEvent)
  })

  ipcMain.handle('longTermGoals:message', async (_event: IpcMainInvokeEvent, goalId: string, content: string) => {
    return longTermGoalService!.appendGoalMessage(goalId, content)
  })

  ipcMain.handle('longTermGoals:streamMessage', async (event: IpcMainInvokeEvent, goalId: string, content: string, streamId: string) => {
    const sender = event.sender
    const channel = `longTermGoals:stream-event:${streamId}`
    const onEvent = (goalStreamEvent: LongTermGoalStreamEvent) => {
      if (sender.isDestroyed()) return
      try {
        sender.send(channel, goalStreamEvent)
      } catch (sendErr) {
        console.error('[longTermGoals:streamMessage] Failed to forward stream event:', sendErr)
      }
    }
    return await longTermGoalService!.appendGoalMessage(goalId, content, onEvent)
  })

  ipcMain.handle('longTermGoals:streamCreate', async (event: IpcMainInvokeEvent, content: string, options: { providerId?: string | null; modelId?: string | null; selectedMcpServerIds?: string[] } | undefined, streamId: string) => {
    const sender = event.sender
    const channel = `longTermGoals:stream-event:${streamId}`
    const onEvent = (goalStreamEvent: LongTermGoalStreamEvent) => {
      if (sender.isDestroyed()) return
      try {
        sender.send(channel, goalStreamEvent)
      } catch (sendErr) {
        console.error('[longTermGoals:streamCreate] Failed to forward stream event:', sendErr)
      }
    }
    return await longTermGoalService!.createGoalViaConversation(content, options, onEvent)
  })

  ipcMain.handle('longTermGoals:applyChangeSet', async (_event: IpcMainInvokeEvent, changeSetId: string) => {
    return longTermGoalService!.applyChangeSet(changeSetId)
  })

  ipcMain.handle('longTermGoals:cancelChangeSet', async (_event: IpcMainInvokeEvent, changeSetId: string) => {
    return longTermGoalService!.cancelChangeSet(changeSetId)
  })

  ipcMain.handle('longTermGoals:applyCreation', async (_event: IpcMainInvokeEvent, changeSetId: string) => {
    return longTermGoalService!.applyGoalCreation(changeSetId)
  })

  ipcMain.handle('longTermGoals:cancelCreation', async (_event: IpcMainInvokeEvent, changeSetId: string) => {
    longTermGoalService!.cancelGoalCreation(changeSetId)
    return true
  })

  ipcMain.handle('longTermGoals:answerIntervention', async (event: IpcMainInvokeEvent, goalId: string, interventionId: string, answers: Array<{ questionId: string; selectedOption?: string | null; customAnswer?: string | null }>, streamId?: string) => {
    const sender = event.sender
    const channel = streamId ? `longTermGoals:stream-event:${streamId}` : null
    const onEvent = channel
      ? (goalStreamEvent: LongTermGoalStreamEvent) => {
          if (sender.isDestroyed()) return
          try {
            sender.send(channel, goalStreamEvent)
          } catch (sendErr) {
            console.error('[longTermGoals:answerIntervention] Failed to forward stream event:', sendErr)
          }
        }
      : undefined
    return longTermGoalService!.answerIntervention(goalId, interventionId, answers, onEvent)
  })

  // --- Open project in standalone window ---
  ipcMain.handle('runtime:openWindow', async (_event: IpcMainInvokeEvent, projectId: string) => {
    // Check if a window already exists for this project
    const existing = projectWindows.get(projectId)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      return { success: true, reused: true }
    }

    const rustClient = await selectedRustProjectClient()
    const nativeStatus = rustClient
      ? await rustClient.call<Record<string, unknown>>('project.status', { projectId })
      : null
    const port = rustClient
      ? (typeof nativeStatus?.port === 'number' ? nativeStatus.port : undefined)
      : runtimeManager!.getPort(projectId)
    if (!port) return { success: false, error: 'Project not running' }

    const meta = rustClient
      ? await rustClient.call<Record<string, unknown>>('project.get', { projectId })
      : await projectFS!.getProjectMeta(projectId)
    const projectName = (meta?.name as string) || projectId

    const win = new BrowserWindow({
      width: 1024,
      height: 768,
      title: projectName,
      minWidth: 760,
      minHeight: 480,
      frame: false,
      backgroundColor: '#081018',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    const target = buildRendererWindowUrl(projectId)
    if (target.devUrl) {
      win.loadURL(target.devUrl)
    } else if (target.filePath) {
      win.loadFile(target.filePath, { query: target.query })
    }

    attachProjectRuntimeLogForwarding(win)

    projectWindows.set(projectId, win)

    win.on('closed', () => {
      projectWindows.delete(projectId)
      const currentMainWindow = getMainWindow()
      if (currentMainWindow && !currentMainWindow.isDestroyed()) {
        currentMainWindow.webContents.send('project:windowClosed', { projectId })
      }
      void (async () => {
        try {
          const activeRustClient = await selectedRustProjectClient()
          if (activeRustClient) {
            const result = await activeRustClient.call<Record<string, unknown>>('project.dev.stop', { projectId })
            if (result.stopped === true) {
              broadcastToAppWindows('projects:changed', { action: 'stopped', projectId, source: 'rust' })
            }
          } else {
            const result = await runtimeManager.stop(projectId)
            if (result.status === 'stopped') {
              broadcastToAppWindows('projects:changed', { action: 'stopped', projectId })
            }
          }
        } catch (error) {
          console.warn(`[runtime] Failed to stop ${projectId} after window close:`, error)
        }
      })()
    })

    return { success: true }
  })

  // --- Check which projects have standalone windows ---
  ipcMain.handle('runtime:getOpenWindows', async () => {
    const result: string[] = []
    for (const [id, win] of projectWindows) {
      if (!win.isDestroyed()) result.push(id)
    }
    return result
  })

  // --- Focus a standalone project window ---
  ipcMain.handle('runtime:focusWindow', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const win = projectWindows.get(projectId)
    if (win && !win.isDestroyed()) {
      win.focus()
      return { success: true }
    }
    return { success: false }
  })
}
