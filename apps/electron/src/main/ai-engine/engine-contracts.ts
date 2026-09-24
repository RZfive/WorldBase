/**
 * Shared engine contracts.
 *
 * The TypeScript agent loop has been removed; the Rust harness is the only
 * execution backend. These interfaces describe the Electron-domain service
 * surface the Rust facade consumes (host tools, UI callbacks, stores) and
 * the provider-config/custom-tool shapes shared across call sites.
 */

import type { BrowserWindow } from 'electron'
import type { ToolDefinition } from './providers/openai-provider.js'
import type { ProgressCallback } from './agent/agent-core.js'
import type { ProjectFS } from '../project-fs/project-fs.js'
import type { RuntimeManager } from '../project-runtime/runtime-manager.js'
import type { BuilderService } from '../project-runtime/builder-service.js'
import type { ProjectApiClient } from '../project-api-bridge/api-client.js'
import type { ProjectDataAccess } from '../project-data-access/data-access.js'
import type { AsyncTaskManager } from './agent/tools/async-task-manager.js'
import type { DocumentStore } from './agent/tools/document-store.js'
import type { AIExecutionAuthMode, SettingsStore } from '../settings/settings-store.js'
import type { MCPService } from '../mcp/mcp-service.js'
import type { SkillStore } from '../settings/skill-store.js'
import type { ScheduledTaskService } from '../scheduler/scheduled-task-service.js'
import type { AgentStore } from '../settings/agent-store.js'
import type { AgentGroupStore } from '../settings/agent-group-store.js'
import type { ImageLibraryStore } from '../settings/image-library-store.js'
import type { UsageStore } from '../settings/usage-store.js'
import type { ImageStudioGenerateRequest } from '../../shared/image-studio-types.js'
import type { FolderWorkspaceChangeEvent } from '../../shared/folder-workspace-types.js'

export interface CustomToolRegistration {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
  /** Used by the Rust facade when this run is routed through app-server. */
  domain?: 'electron_host_override' | 'host'
}

export interface AIEngineServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  builderService: BuilderService
  apiClient: ProjectApiClient
  dataAccess: ProjectDataAccess
  asyncTaskManager: AsyncTaskManager
  documentStore?: DocumentStore
  skillStore?: SkillStore
  agentStore?: AgentStore
  agentGroupStore?: AgentGroupStore
  settingsStore?: SettingsStore
  imageLibraryStore?: ImageLibraryStore
  /** Hand image generation/edit requests to the drawing studio's task queue. */
  enqueueStudioImageTasks?: (requests: ImageStudioGenerateRequest[]) => void
  getMainWindow?: () => BrowserWindow | null
  readActivePage?: () => Promise<BrowserAutomationSnapshot>
  interactWithActivePage?: (action: BrowserAutomationAction) => Promise<BrowserAutomationActionResult>
  notifySkillsChanged?: (event: { action: string; count?: number; id?: string }) => void
  notifyAgentWorkspaceChanged?: (event: { entity: 'agent' | 'group' | 'binding'; action: string; id?: string }) => void
  notifyFolderWorkspaceChanged?: (event: FolderWorkspaceChangeEvent) => void
  mcpService?: MCPService
  scheduledTaskService?: ScheduledTaskService
  /** 持久化 token 用量统计；注入后每次 provider 调用会记录真实 token。 */
  usageStore?: UsageStore
}

import type { BrowserAutomationAction, BrowserAutomationActionResult, BrowserAutomationSnapshot } from '../../shared/page-automation-types.js'

export interface AIConfigInput {
  apiKey?: string
  baseUrl?: string
  model?: string
  /** Wire protocol: OpenAI-compatible chat/completions, OpenAI Responses (Rust harness only), or native Anthropic Messages API. */
  apiProtocol?: 'openai' | 'openai-chat' | 'openai-responses' | 'anthropic'
  /** 供应商 id（用于用量统计分组；不影响 provider 行为）。 */
  providerId?: string
  /** 供应商名称快照（用量统计展示用）。 */
  providerName?: string
  imageGeneration?: boolean
  imageEditing?: boolean
  enableThinking?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  contextWindow?: number
  /** Sampling temperature. Omit to use the coding-tuned default (low). */
  temperature?: number
}

export type { AIExecutionAuthMode }
