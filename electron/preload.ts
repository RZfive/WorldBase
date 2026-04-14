import { contextBridge, ipcRenderer } from 'electron'

interface ChatMessage {
  role: string
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
}

interface AISettings {
  apiKey: string
  baseUrl: string
  model: string
}

interface StreamEvent {
  type: 'token' | 'thinking' | 'tool_start' | 'tool_end' | 'progress' | 'file_preview_start' | 'file_preview_chunk' | 'file_preview_end' | 'reset' | 'done' | 'error' | 'stopped'
  content?: string
  name?: string
  message?: ChatMessage
  thinking?: string
  error?: string
  stage?: string
  detail?: string
  filePath?: string
  truncated?: boolean
}

interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  providerId?: string
  selectedModel?: string
  targetProjectId?: string
}

interface ToolProgressEntry {
  stage: string
  detail?: string
}

interface ToolRun {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  progress: ToolProgressEntry[]
}

interface Conversation extends ConversationSummary {
  messages: Array<ChatMessage & { thinking?: string; modelLabel?: string; toolRuns?: ToolRun[] }>
}

interface AIProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
  modelContextWindows?: Record<string, number>
  activeModel: string
  enableThinking?: boolean
}

interface AIProvidersConfig {
  providers: AIProvider[]
  activeProviderId: string
  enabledProviderIds: string[]
}

interface LaunchpadFolderLayout {
  id: string
  name: string
  projectIds: string[]
}

interface LaunchpadLayout {
  folders: LaunchpadFolderLayout[]
  topLevelOrder: string[]
}

interface WebAppShortcut {
  id: string
  kind: 'web'
  type: 'browser'
  name: string
  url: string
  icon?: string
  createdAt: string
  updatedAt: string
}

type ThemePreference = 'system' | 'light' | 'dark'
type AIExecutionAuthMode = 'strict' | 'auto'

interface AIExecutionPreferences {
  notifyOnTaskComplete: boolean
  enableAiLogging: boolean
}

interface AILogConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  sessionCount: number
  lastStatus?: 'running' | 'completed' | 'failed' | 'stopped'
  errorCount: number
}

interface AILogConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  sessions: Array<{
    id: string
    startedAt: string
    updatedAt: string
    finishedAt?: string
    status: 'running' | 'completed' | 'failed' | 'stopped'
    providerId?: string
    modelId?: string
    authMode?: AIExecutionAuthMode
    targetProjectId?: string | null
    uploadedMessages: Array<{ role: string; content: MessageContent; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string; reasoning_content?: string }>
    providerCalls: unknown[]
    toolExecutions: unknown[]
    errors: unknown[]
    finalAssistantMessage?: { role: string; content: MessageContent; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string; reasoning_content?: string }
  }>
}

interface ProjectLanUrlInfo {
  projectPort: number | null
  lanUrl: string | null
  proxyUrl: string
  localProxyUrl: string
  lanIp: string
}

interface ServiceEntry {
  projectId: string
  name: string
  port: number
  status: string
  pid?: number
  startedAt?: string
  framework?: string
  restartPolicy: 'always' | 'on-failure' | 'never'
  restartCount: number
}

interface ManagedProcessInfo {
  projectId: string
  projectName: string
  status: string
  pid?: number
  port?: number
  startedAt?: string
  uptimeSeconds?: number
  memoryRssBytes?: number
  exitCode?: number | null
  error?: string
}

interface OrphanProcessInfo {
  pid: number
  name: string
  memoryRssBytes: number
  commandLine: string
  listeningPort?: number
}

interface ProcessManagerSnapshot {
  managed: ManagedProcessInfo[]
  orphans: OrphanProcessInfo[]
  fetchedAt: string
}

interface SystemStatusSnapshot {
  fetchedAt: string
  refreshIntervalMs: number
  cacheAgeMs: number
  host: {
    platform: string
    release: string
    arch: string
    uptimeSeconds: number
    nodeVersion: string
    electronVersion: string | null
  }
  summary: {
    status: 'ok' | 'busy' | 'degraded'
    hostUptimeSeconds: number
    runningProjectCount: number
    trackedProjectProcessCount: number
    totalServiceCount: number
    crashedServiceCount: number
    cpuUsagePercent: number | null
    memoryUsagePercent: number
  }
  cpu: {
    model: string
    cores: number
    architecture: string
    loadAverage: number[]
    usagePercent: number | null
    sampleWindowMs: number | null
  }
  memory: {
    totalBytes: number
    freeBytes: number
    usedBytes: number
    usagePercent: number
    processRssBytes: number
    processHeapUsedBytes: number
    processHeapTotalBytes: number
    processExternalBytes: number
  }
  currentProcess: {
    pid: number
    uptimeSeconds: number
    platform: string
    arch: string
    memory: {
      rssBytes: number
      heapUsedBytes: number
      heapTotalBytes: number
      externalBytes: number
    }
  }
  projectProcesses: Array<{
    projectId: string
    status: string
    port?: number
    pid?: number
    startedAt?: string
    uptimeSeconds?: number
    exitCode?: number | null
    error?: string
  }>
  services: {
    services: ServiceEntry[]
    totalRunning: number
    totalStopped: number
    totalCrashed: number
  }
}

/**
 * API shape exposed to the renderer via contextBridge.
 * Must stay in sync with the ElectronAPI declaration in src/env.d.ts.
 */
export interface ElectronAPI {
  // AI
  chat: (messages: ChatMessage[]) => Promise<ChatMessage>
  chatStream: (messages: ChatMessage[], sessionId: string, conversationId?: string, providerId?: string, modelId?: string, targetProjectId?: string, authMode?: AIExecutionAuthMode) => Promise<{ ok: boolean }>
  stopChatStream: (sessionId: string) => Promise<{ ok: boolean; stopped: boolean }>
  onStreamEvent: (sessionId: string, callback: (event: StreamEvent) => void) => () => void

  // Conversations
  listConversations: () => Promise<ConversationSummary[]>
  getConversation: (id: string) => Promise<Conversation | null>
  saveConversation: (conversation: Conversation) => Promise<{ success: boolean }>
  deleteConversation: (id: string) => Promise<boolean>
  saveImageToFile: (imageUrl: string, defaultName?: string) => Promise<{ success?: boolean; canceled?: boolean; filePath?: string }>
  readUploadedOfficeFile: (filePath: string) => Promise<{ filePath: string; fileName: string; size: number; fileType: string; content: string }>

  // Projects
  listProjects: () => Promise<Array<Record<string, unknown>>>
  getProject: (projectId: string) => Promise<Record<string, unknown>>
  getFileTree: (projectId: string) => Promise<Array<Record<string, unknown>>>
  readFile: (projectId: string, filePath: string) => Promise<string>
  writeFile: (projectId: string, filePath: string, content: string) => Promise<{ success: boolean }>
  updateProjectAppearance: (projectId: string, updates: { name?: string; icon?: string }) => Promise<Record<string, unknown>>
  openProjectFolder: (projectId: string) => Promise<{ success: boolean }>
  deleteProject: (projectId: string) => Promise<{ success: boolean }>
  onProjectChanged: (callback: (event: { action: string; projectId: string; port?: number }) => void) => () => void

  // Runtime
  startProject: (projectId: string) => Promise<Record<string, unknown>>
  stopProject: (projectId: string) => Promise<Record<string, unknown>>
  getProjectStatus: (projectId: string) => Promise<Record<string, unknown>>
  openProjectWindow: (projectId: string) => Promise<{ success: boolean; reused?: boolean; error?: string }>
  getOpenWindows: () => Promise<string[]>
  focusProjectWindow: (projectId: string) => Promise<{ success: boolean }>
  onProjectWindowClosed: (callback: (event: { projectId: string }) => void) => () => void
  onBrowserOpenUrlInDock: (callback: (event: { url: string }) => void) => () => void
  getSystemStatus: () => Promise<SystemStatusSnapshot>

  // Process management
  getProcessSnapshot: () => Promise<ProcessManagerSnapshot>
  restartManagedProcess: (projectId: string) => Promise<{ success: boolean; error?: string }>
  stopManagedProcess: (projectId: string) => Promise<{ success: boolean; error?: string }>
  forceKillManagedProcess: (projectId: string) => Promise<{ success: boolean; error?: string }>
  killOrphanProcess: (pid: number) => Promise<{ success: boolean; error?: string }>

  // LAN
  getLanInfo: () => Promise<{ port: number; addresses: string[]; baseUrl: string }>
  getProjectLanUrl: (projectId: string) => Promise<ProjectLanUrlInfo>

  // Data
  queryData: (projectId: string, sql: string) => Promise<Record<string, unknown>>
  getDataSummary: (projectId: string) => Promise<Record<string, unknown>>
  listAllDatabases: () => Promise<Array<Record<string, unknown>>>
  queryTable: (projectId: string, tableName: string, page: number, pageSize: number) => Promise<{ rows: Record<string, unknown>[]; total: number }>
  getTableSchema: (projectId: string) => Promise<unknown[] | null>

  // Settings
  getAISettings: () => Promise<AISettings>
  saveAISettings: (config: AISettings) => Promise<{ success: boolean }>
  getProviders: () => Promise<AIProvidersConfig>
  saveProviders: (config: AIProvidersConfig) => Promise<{ success: boolean }>
  onProvidersChanged: (callback: (config: AIProvidersConfig) => void) => () => void
  getThemePreference: () => Promise<ThemePreference>
  saveThemePreference: (preference: ThemePreference) => Promise<{ success: boolean }>
  getAIExecutionPreferences: () => Promise<AIExecutionPreferences>
  saveAIExecutionPreferences: (preferences: AIExecutionPreferences) => Promise<{ success: boolean }>
  listAILogConversations: () => Promise<AILogConversationSummary[]>
  getAILogConversation: (conversationId: string) => Promise<AILogConversation | null>
  deleteAILogConversation: (conversationId: string) => Promise<boolean>
  exportAppConfig: () => Promise<{ success: boolean; canceled?: boolean; filePath?: string }>
  importAppConfig: () => Promise<{ success: boolean; canceled?: boolean; filePath?: string; importedAt?: string; requiresReload?: boolean }>
  getLaunchMode: (projectId: string) => Promise<'embed' | 'window'>
  saveLaunchMode: (projectId: string, mode: 'embed' | 'window') => Promise<{ success: boolean }>
  getLaunchpadLayout: () => Promise<LaunchpadLayout>
  saveLaunchpadLayout: (layout: LaunchpadLayout) => Promise<{ success: boolean }>
  getWebApps: () => Promise<WebAppShortcut[]>
  saveWebApps: (webApps: WebAppShortcut[]) => Promise<{ success: boolean }>

  // Skills
  listSkills: () => Promise<Array<{ id: string; name: string; description: string; content: string; createdAt: string; updatedAt: string }>>
  importSkills: () => Promise<Array<{ id: string; name: string; description: string }>>
  importSkillContent: (name: string, content: string, description?: string) => Promise<{ id: string; name: string }>
  deleteSkill: (id: string) => Promise<boolean>
  setActiveSkills: (skillIds: string[]) => Promise<{ success: boolean; count: number }>
  onSkillsChanged: (callback: (event: { action: string; count?: number; id?: string }) => void) => () => void

  // Window controls
  minimizeWindow: () => Promise<void>
  maximizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  isMaximized: () => Promise<boolean>

  // Auth (in-app authorization dialogs)
  onAuthRequest: (callback: (request: { requestId: string; title: string; detail: string }) => void) => () => void
  onAuthResolved: (callback: (payload: { requestId: string; approved: boolean }) => void) => () => void
  respondAuth: (requestId: string, approved: boolean) => void

  // Document import / preview / selection
  pickDocumentFiles: () => Promise<{ canceled: boolean; filePaths: string[] }>
  pickOfficeFiles: () => Promise<{ canceled: boolean; filePaths: string[] }>
  importDocument: (filePath: string) => Promise<{ artifact: unknown }>
  listDocuments: () => Promise<unknown[]>
  getDocument: (artifactId: string) => Promise<unknown | null>
  getDocumentRenderData: (artifactId: string) => Promise<{ mimeType: string; bytes: Uint8Array } | null>
  openDocumentOriginal: (artifactId: string) => Promise<{ success: boolean; error?: string }>
  removeDocument: (artifactId: string) => Promise<boolean>
  createDocumentSelection: (payload: { artifactId: string; nodeIds: string[]; label: string; color: string; excerpt?: string }) => Promise<unknown>
  removeDocumentSelection: (regionId: string) => Promise<boolean>
  updateDocumentSelectionLabel: (regionId: string, label: string) => Promise<unknown | null>
  getDocumentSelections: (artifactId: string) => Promise<unknown[]>
  buildDocumentSelectionsPrompt: (regionIds?: string[]) => Promise<string>
}

contextBridge.exposeInMainWorld('electronAPI', {
  // AI
  chat: (messages: ChatMessage[]) => ipcRenderer.invoke('ai:chat', messages),
  chatStream: (messages: ChatMessage[], sessionId: string, conversationId?: string, providerId?: string, modelId?: string, targetProjectId?: string, authMode?: AIExecutionAuthMode) => ipcRenderer.invoke('ai:chatStream', messages, sessionId, conversationId, providerId, modelId, targetProjectId, authMode),
  stopChatStream: (sessionId: string) => ipcRenderer.invoke('ai:stopStream', sessionId),
  onStreamEvent: (sessionId: string, callback: (event: StreamEvent) => void) => {
    const channel = `ai:stream-event:${sessionId}`
    const handler = (_e: Electron.IpcRendererEvent, event: StreamEvent) => callback(event)
    ipcRenderer.on(channel, handler)
    // Return cleanup function
    return () => { ipcRenderer.removeListener(channel, handler) }
  },

  // Conversations
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  getConversation: (id: string) => ipcRenderer.invoke('conversations:get', id),
  saveConversation: (conversation: Conversation) => ipcRenderer.invoke('conversations:save', conversation),
  deleteConversation: (id: string) => ipcRenderer.invoke('conversations:delete', id),
  saveImageToFile: (imageUrl: string, defaultName?: string) => ipcRenderer.invoke('media:saveImage', imageUrl, defaultName),
  readUploadedOfficeFile: (filePath: string) => ipcRenderer.invoke('chat:readUploadedOfficeFile', filePath),

  // Projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getProject: (projectId: string) => ipcRenderer.invoke('projects:get', projectId),
  getFileTree: (projectId: string) => ipcRenderer.invoke('projects:getFileTree', projectId),
  readFile: (projectId: string, filePath: string) => ipcRenderer.invoke('projects:readFile', projectId, filePath),
  writeFile: (projectId: string, filePath: string, content: string) => ipcRenderer.invoke('projects:writeFile', projectId, filePath, content),
  updateProjectAppearance: (projectId: string, updates: { name?: string; icon?: string }) => ipcRenderer.invoke('projects:updateAppearance', projectId, updates),
  openProjectFolder: (projectId: string) => ipcRenderer.invoke('projects:openFolder', projectId),
  deleteProject: (projectId: string) => ipcRenderer.invoke('projects:delete', projectId),
  onProjectChanged: (callback: (event: { action: string; projectId: string; port?: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { action: string; projectId: string; port?: number }) => callback(event)
    ipcRenderer.on('projects:changed', handler)
    return () => { ipcRenderer.removeListener('projects:changed', handler) }
  },

  // Runtime
  startProject: (projectId: string) => ipcRenderer.invoke('runtime:start', projectId),
  stopProject: (projectId: string) => ipcRenderer.invoke('runtime:stop', projectId),
  getProjectStatus: (projectId: string) => ipcRenderer.invoke('runtime:status', projectId),
  openProjectWindow: (projectId: string) => ipcRenderer.invoke('runtime:openWindow', projectId),
  getOpenWindows: () => ipcRenderer.invoke('runtime:getOpenWindows'),
  focusProjectWindow: (projectId: string) => ipcRenderer.invoke('runtime:focusWindow', projectId),
  onProjectWindowClosed: (callback: (event: { projectId: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { projectId: string }) => callback(event)
    ipcRenderer.on('project:windowClosed', handler)
    return () => { ipcRenderer.removeListener('project:windowClosed', handler) }
  },
  onBrowserOpenUrlInDock: (callback: (event: { url: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { url: string }) => callback(event)
    ipcRenderer.on('browser:openUrlInDock', handler)
    return () => { ipcRenderer.removeListener('browser:openUrlInDock', handler) }
  },
  getSystemStatus: () => ipcRenderer.invoke('system:getStatus'),

  // Process management
  getProcessSnapshot: () => ipcRenderer.invoke('process:getSnapshot'),
  restartManagedProcess: (projectId: string) => ipcRenderer.invoke('process:restart', projectId),
  stopManagedProcess: (projectId: string) => ipcRenderer.invoke('process:stop', projectId),
  forceKillManagedProcess: (projectId: string) => ipcRenderer.invoke('process:forceKill', projectId),
  killOrphanProcess: (pid: number) => ipcRenderer.invoke('process:killOrphan', pid),

  // LAN
  getLanInfo: () => ipcRenderer.invoke('lan:getInfo'),
  getProjectLanUrl: (projectId: string) => ipcRenderer.invoke('projects:getLanUrl', projectId),

  // Data
  queryData: (projectId: string, sql: string) => ipcRenderer.invoke('data:query', projectId, sql),
  getDataSummary: (projectId: string) => ipcRenderer.invoke('data:summary', projectId),
  listAllDatabases: () => ipcRenderer.invoke('data:listAll'),
  queryTable: (projectId: string, tableName: string, page: number, pageSize: number) => ipcRenderer.invoke('data:queryTable', projectId, tableName, page, pageSize),
  getTableSchema: (projectId: string) => ipcRenderer.invoke('data:getSchema', projectId),

  // Settings
  getAISettings: () => ipcRenderer.invoke('settings:getAI'),
  saveAISettings: (config: AISettings) => ipcRenderer.invoke('settings:saveAI', config),
  getProviders: () => ipcRenderer.invoke('settings:getProviders'),
  saveProviders: (config: AIProvidersConfig) => ipcRenderer.invoke('settings:saveProviders', config),
  onProvidersChanged: (callback: (config: AIProvidersConfig) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, config: AIProvidersConfig) => callback(config)
    ipcRenderer.on('settings:providersChanged', handler)
    return () => { ipcRenderer.removeListener('settings:providersChanged', handler) }
  },
  getThemePreference: () => ipcRenderer.invoke('settings:getThemePreference'),
  saveThemePreference: (preference: ThemePreference) => ipcRenderer.invoke('settings:saveThemePreference', preference),
  getAIExecutionPreferences: () => ipcRenderer.invoke('settings:getAIExecutionPreferences'),
  saveAIExecutionPreferences: (preferences: AIExecutionPreferences) => ipcRenderer.invoke('settings:saveAIExecutionPreferences', preferences),
  listAILogConversations: () => ipcRenderer.invoke('settings:listAILogConversations'),
  getAILogConversation: (conversationId: string) => ipcRenderer.invoke('settings:getAILogConversation', conversationId),
  deleteAILogConversation: (conversationId: string) => ipcRenderer.invoke('settings:deleteAILogConversation', conversationId),
  exportAppConfig: () => ipcRenderer.invoke('settings:exportConfig'),
  importAppConfig: () => ipcRenderer.invoke('settings:importConfig'),
  getLaunchMode: (projectId: string) => ipcRenderer.invoke('settings:getLaunchMode', projectId),
  saveLaunchMode: (projectId: string, mode: 'embed' | 'window') => ipcRenderer.invoke('settings:saveLaunchMode', projectId, mode),
  getLaunchpadLayout: () => ipcRenderer.invoke('settings:getLaunchpadLayout'),
  saveLaunchpadLayout: (layout: LaunchpadLayout) => ipcRenderer.invoke('settings:saveLaunchpadLayout', layout),
  getWebApps: () => ipcRenderer.invoke('settings:getWebApps'),
  saveWebApps: (webApps: WebAppShortcut[]) => ipcRenderer.invoke('settings:saveWebApps', webApps),

  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list'),
  importSkills: () => ipcRenderer.invoke('skills:import'),
  importSkillContent: (name: string, content: string, description?: string) => ipcRenderer.invoke('skills:importContent', name, content, description),
  deleteSkill: (id: string) => ipcRenderer.invoke('skills:delete', id),
  setActiveSkills: (skillIds: string[]) => ipcRenderer.invoke('skills:setActive', skillIds),
  onSkillsChanged: (callback: (event: { action: string; count?: number; id?: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { action: string; count?: number; id?: string }) => callback(event)
    ipcRenderer.on('skills:changed', handler)
    return () => { ipcRenderer.removeListener('skills:changed', handler) }
  },

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // Auth (in-app authorization dialogs)
  onAuthRequest: (callback: (request: { requestId: string; title: string; detail: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, request: { requestId: string; title: string; detail: string }) => callback(request)
    ipcRenderer.on('auth:request', handler)
    return () => { ipcRenderer.removeListener('auth:request', handler) }
  },
  onAuthResolved: (callback: (payload: { requestId: string; approved: boolean }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { requestId: string; approved: boolean }) => callback(payload)
    ipcRenderer.on('auth:resolved', handler)
    return () => { ipcRenderer.removeListener('auth:resolved', handler) }
  },
  respondAuth: (requestId: string, approved: boolean) => {
    ipcRenderer.send('auth:response', { requestId, approved })
  },

  // Document import / preview / selection
  pickDocumentFiles: () => ipcRenderer.invoke('document:pickFiles'),
  pickOfficeFiles: () => ipcRenderer.invoke('office:pickFiles'),
  importDocument: (filePath: string) => ipcRenderer.invoke('document:import', filePath),
  listDocuments: () => ipcRenderer.invoke('document:list'),
  getDocument: (artifactId: string) => ipcRenderer.invoke('document:get', artifactId),
  getDocumentRenderData: (artifactId: string) => ipcRenderer.invoke('document:getRenderData', artifactId),
  openDocumentOriginal: (artifactId: string) => ipcRenderer.invoke('document:openOriginal', artifactId),
  removeDocument: (artifactId: string) => ipcRenderer.invoke('document:remove', artifactId),
  createDocumentSelection: (payload: { artifactId: string; nodeIds: string[]; label: string; color: string; excerpt?: string }) => ipcRenderer.invoke('document:createSelection', payload),
  removeDocumentSelection: (regionId: string) => ipcRenderer.invoke('document:removeSelection', regionId),
  updateDocumentSelectionLabel: (regionId: string, label: string) => ipcRenderer.invoke('document:updateSelectionLabel', regionId, label),
  getDocumentSelections: (artifactId: string) => ipcRenderer.invoke('document:getSelections', artifactId),
  buildDocumentSelectionsPrompt: (regionIds?: string[]) => ipcRenderer.invoke('document:buildSelectionsPrompt', regionIds)
} satisfies ElectronAPI)
