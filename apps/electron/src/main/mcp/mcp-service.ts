import { EventEmitter } from 'node:events'
import {
  Client,
  SSEClientTransport,
  StdioClientTransport,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'
import type { Prompt, Resource, Tool } from '@modelcontextprotocol/client'
import type { ProgressCallback } from '../ai-engine/agent/agent-core.js'
import type { ToolDefinition } from '../ai-engine/providers/openai-provider.js'
import type { MCPServerConfig } from '../settings/settings-store.js'
import { t } from '../i18n/main-i18n.js'

type MCPClientTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

export type MCPServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface MCPToolSummary {
  name: string
  localName: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface MCPResourceSummary {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface MCPPromptSummary {
  name: string
  description: string
  arguments: Array<{
    name: string
    description?: string
    required?: boolean
  }>
}

export interface MCPServerSnapshot {
  id: string
  name: string
  enabled: boolean
  transport: MCPServerConfig['transport']
  status: MCPServerStatus
  error?: string
  updatedAt: string | null
  tools: MCPToolSummary[]
  resources: MCPResourceSummary[]
  prompts: MCPPromptSummary[]
  capabilities: {
    tools: boolean
    resources: boolean
    prompts: boolean
  }
}

export interface MCPStateSnapshot {
  servers: MCPServerSnapshot[]
  updatedAt: string
}

interface MCPDynamicToolBinding {
  localName: string
  remoteName: string
  serverId: string
  definition: ToolDefinition
}

interface MCPServerSession {
  config: MCPServerConfig
  client?: Client
  transport?: MCPClientTransport
  status: MCPServerStatus
  error?: string
  updatedAt: string | null
  tools: Tool[]
  resources: Resource[]
  prompts: Prompt[]
  capabilities: {
    tools: boolean
    resources: boolean
    prompts: boolean
  }
  bindings: Map<string, MCPDynamicToolBinding>
  connectPromise?: Promise<void>
  notificationHandlersInstalled: boolean
}

const MCP_REMOTE_TOOL_PREFIX = 'mcp__'

function simpleHash (value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}

function sanitizeToolSegment (value: string, maxLength: number): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (!normalized) return 'tool'
  return normalized.slice(0, maxLength)
}

function buildLocalToolName (serverId: string, remoteName: string): string {
  const serverSegment = sanitizeToolSegment(serverId, 14)
  const toolSegment = sanitizeToolSegment(remoteName, 28)
  const hash = simpleHash(`${serverId}:${remoteName}`).slice(0, 6)
  return `${MCP_REMOTE_TOOL_PREFIX}${serverSegment}__${toolSegment}__${hash}`.slice(0, 64)
}

function normalizeToolSchema (value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {
    type: 'object',
    properties: {},
    additionalProperties: true
  }
}

function parsePromptArguments (prompt: Prompt): MCPPromptSummary['arguments'] {
  const rawArgs = (prompt as unknown as { arguments?: unknown }).arguments
  if (!Array.isArray(rawArgs)) return []

  const normalized: MCPPromptSummary['arguments'] = []
  for (const entry of rawArgs) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!name) continue
    normalized.push({
      name,
      description: typeof record.description === 'string' ? record.description : undefined,
      required: typeof record.required === 'boolean' ? record.required : undefined
    })
  }
  return normalized
}

function normalizePromptArgsMap (value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const normalized: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.trim()
    if (!normalizedKey) continue
    normalized[normalizedKey] = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue)
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

async function withTimeout<T> (promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(t('mainDialog.mcpOperationTimeout', { label, timeoutMs })))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizeAllowedServerIds (allowedServerIds?: Iterable<string>): Set<string> | null {
  if (!allowedServerIds) return null

  const normalized = new Set<string>()
  for (const serverId of allowedServerIds) {
    if (typeof serverId !== 'string') continue
    const trimmed = serverId.trim()
    if (trimmed) {
      normalized.add(trimmed)
    }
  }

  return normalized.size > 0 ? normalized : null
}

export class MCPService extends EventEmitter {
  private sessions = new Map<string, MCPServerSession>()

  constructor () {
    super()
  }

  async updateServers (configs: MCPServerConfig[]): Promise<void> {
    const nextIds = new Set(configs.map(config => config.id))

    for (const [serverId, session] of this.sessions.entries()) {
      if (!nextIds.has(serverId)) {
        await this.closeSession(session, true)
        this.sessions.delete(serverId)
      }
    }

    for (const config of configs) {
      const existing = this.sessions.get(config.id)
      if (!existing) {
        this.sessions.set(config.id, this.createSession(config))
        continue
      }

      const changed = JSON.stringify(existing.config) !== JSON.stringify(config)
      existing.config = config
      if (changed) {
        await this.closeSession(existing, false)
      }
    }

    await this.refreshEnabledServers()
    this.emitStateChanged()
  }

  getState (): MCPStateSnapshot {
    return {
      servers: Array.from(this.sessions.values())
        .map(session => this.buildSnapshot(session))
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
      updatedAt: new Date().toISOString()
    }
  }

  getCachedDynamicToolDefinitions (allowedServerIds?: Iterable<string>): ToolDefinition[] {
    const allowedServerIdSet = normalizeAllowedServerIds(allowedServerIds)
    return Array.from(this.sessions.values())
      .filter(session => session.config.enabled && (!allowedServerIdSet || allowedServerIdSet.has(session.config.id)))
      .flatMap(session => Array.from(session.bindings.values()).map(binding => binding.definition))
  }

  getBuiltinToolRegistrations (allowedServerIds?: Iterable<string>): Array<{
    definition: ToolDefinition
    handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
  }> {
    const allowedServerIdSet = normalizeAllowedServerIds(allowedServerIds)
    const assertServerAllowed = (serverId: string): void => {
      if (allowedServerIdSet && !allowedServerIdSet.has(serverId)) {
        throw new Error(`MCP 服务器 ${serverId} 未被当前任务授权`)
      }
    }
    const getFilteredState = (): MCPStateSnapshot => {
      const state = this.getState()
      if (!allowedServerIdSet) return state
      return {
        ...state,
        servers: state.servers.filter(server => allowedServerIdSet.has(server.id))
      }
    }

    return [
      {
        definition: {
          name: 'mcp_list_servers',
          description: '列出当前配置的 MCP 服务器及其连接状态、能力和已发现的工具数量。',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false
          }
        },
        handler: async () => {
          return getFilteredState()
        }
      },
      {
        definition: {
          name: 'mcp_list_resources',
          description: '列出一个或全部 MCP 服务器提供的资源。',
          parameters: {
            type: 'object',
            properties: {
              server_id: { type: 'string', description: '可选。指定要查看的 MCP 服务器 ID。' }
            },
            additionalProperties: false
          }
        },
        handler: async (args) => {
          const serverId = typeof args.server_id === 'string' ? args.server_id.trim() : ''
          if (serverId) {
            assertServerAllowed(serverId)
            const snapshot = await this.refreshServer(serverId)
            return {
              server: snapshot.name,
              server_id: snapshot.id,
              resources: snapshot.resources
            }
          }

          await this.refreshEnabledServers(allowedServerIdSet ?? undefined)
          return {
            servers: getFilteredState().servers.map(server => ({
              server_id: server.id,
              server: server.name,
              resources: server.resources
            }))
          }
        }
      },
      {
        definition: {
          name: 'mcp_read_resource',
          description: '读取 MCP 服务器上的资源内容。',
          parameters: {
            type: 'object',
            properties: {
              server_id: { type: 'string', description: 'MCP 服务器 ID。' },
              uri: { type: 'string', description: '资源 URI。' }
            },
            required: ['server_id', 'uri'],
            additionalProperties: false
          }
        },
        handler: async (args) => {
          const serverId = typeof args.server_id === 'string' ? args.server_id.trim() : ''
          const uri = typeof args.uri === 'string' ? args.uri.trim() : ''
          if (!serverId || !uri) {
            throw new Error('server_id 和 uri 为必填项')
          }

          assertServerAllowed(serverId)
          const session = await this.ensureConnected(serverId)
          const result = await withTimeout(session.client!.readResource({ uri }), session.config.timeoutMs, `读取 ${serverId} 资源`)
          return {
            server_id: serverId,
            uri,
            contents: (result as { contents?: unknown[] }).contents || []
          }
        }
      },
      {
        definition: {
          name: 'mcp_list_prompts',
          description: '列出一个或全部 MCP 服务器提供的提示模板。',
          parameters: {
            type: 'object',
            properties: {
              server_id: { type: 'string', description: '可选。指定要查看的 MCP 服务器 ID。' }
            },
            additionalProperties: false
          }
        },
        handler: async (args) => {
          const serverId = typeof args.server_id === 'string' ? args.server_id.trim() : ''
          if (serverId) {
            assertServerAllowed(serverId)
            const snapshot = await this.refreshServer(serverId)
            return {
              server: snapshot.name,
              server_id: snapshot.id,
              prompts: snapshot.prompts
            }
          }

          await this.refreshEnabledServers(allowedServerIdSet ?? undefined)
          return {
            servers: getFilteredState().servers.map(server => ({
              server_id: server.id,
              server: server.name,
              prompts: server.prompts
            }))
          }
        }
      },
      {
        definition: {
          name: 'mcp_get_prompt',
          description: '获取 MCP 服务器上的提示模板展开结果。',
          parameters: {
            type: 'object',
            properties: {
              server_id: { type: 'string', description: 'MCP 服务器 ID。' },
              name: { type: 'string', description: '提示模板名称。' },
              arguments: {
                type: 'object',
                description: '提示模板参数键值对。',
                additionalProperties: true
              }
            },
            required: ['server_id', 'name'],
            additionalProperties: false
          }
        },
        handler: async (args) => {
          const serverId = typeof args.server_id === 'string' ? args.server_id.trim() : ''
          const name = typeof args.name === 'string' ? args.name.trim() : ''
          if (!serverId || !name) {
            throw new Error('server_id 和 name 为必填项')
          }

          assertServerAllowed(serverId)
          const session = await this.ensureConnected(serverId)
          const promptArgs = normalizePromptArgsMap(args.arguments)
          const result = await withTimeout(session.client!.getPrompt({ name, arguments: promptArgs }), session.config.timeoutMs, `读取 ${serverId} Prompt`)

          return {
            server_id: serverId,
            name,
            description: (result as { description?: string }).description,
            messages: (result as { messages?: unknown[] }).messages || []
          }
        }
      }
    ]
  }

  async refreshEnabledServers (allowedServerIds?: Iterable<string>): Promise<void> {
    const allowedServerIdSet = normalizeAllowedServerIds(allowedServerIds)
    const enabledSessions = Array.from(this.sessions.values()).filter(session => {
      if (!session.config.enabled) return false
      return !allowedServerIdSet || allowedServerIdSet.has(session.config.id)
    })
    await Promise.allSettled(enabledSessions.map(async (session) => {
      await this.ensureConnected(session.config.id)
      await this.refreshSessionMetadata(session)
    }))
    this.emitStateChanged()
  }

  async refreshServer (serverId: string): Promise<MCPServerSnapshot> {
    const session = this.getSessionOrThrow(serverId)

    if (!session.config.enabled) {
      await this.closeSession(session, false)
      return this.buildSnapshot(session)
    }

    try {
      await this.ensureConnected(serverId)
      await this.refreshSessionMetadata(session)
    } catch (error) {
      session.status = 'error'
      session.error = (error as Error).message || String(error)
      this.emitStateChanged()
    }

    return this.buildSnapshot(session)
  }

  async disconnectServer (serverId: string): Promise<MCPServerSnapshot> {
    const session = this.getSessionOrThrow(serverId)
    await this.closeSession(session, false)
    return this.buildSnapshot(session)
  }

  async executeDynamicTool (localName: string, args: Record<string, unknown>, onProgress?: ProgressCallback, allowedServerIds?: Iterable<string>): Promise<unknown> {
    const binding = this.findBinding(localName)
    if (!binding) {
      throw new Error(`未知的 MCP 工具: ${localName}`)
    }

    return await this.executeServerTool(
      binding.serverId,
      binding.remoteName,
      args,
      onProgress,
      allowedServerIds,
      binding.localName
    )
  }

  /**
   * Execute an MCP tool by its Electron server id and remote name. Rust-selected
   * runs route the generic `mcp_call` here so it uses the live Electron server
   * catalog and the same authenticated connection as the legacy Node harness.
   */
  async executeServerTool (
    serverId: string,
    remoteName: string,
    args: Record<string, unknown>,
    onProgress?: ProgressCallback,
    allowedServerIds?: Iterable<string>,
    localName?: string
  ): Promise<unknown> {
    const normalizedServerId = serverId.trim()
    const normalizedRemoteName = remoteName.trim()
    if (!normalizedServerId || !normalizedRemoteName) {
      throw new Error('MCP server 和 tool 为必填项')
    }

    const allowedServerIdSet = normalizeAllowedServerIds(allowedServerIds)
    if (allowedServerIdSet && !allowedServerIdSet.has(normalizedServerId)) {
      throw new Error(`MCP 服务器 ${normalizedServerId} 未被当前任务授权`)
    }

    const session = await this.ensureConnected(normalizedServerId)
    onProgress?.('🔌 调用 MCP 工具', `${session.config.name}: ${normalizedRemoteName}`)
    const result = await withTimeout(
      session.client!.callTool({ name: normalizedRemoteName, arguments: args }),
      session.config.timeoutMs,
      `调用 MCP 工具 ${normalizedRemoteName}`
    )

    return {
      server_id: normalizedServerId,
      tool: normalizedRemoteName,
      local_name: localName,
      is_error: (result as { isError?: boolean }).isError === true,
      structured_content: (result as { structuredContent?: unknown }).structuredContent,
      content: Array.isArray((result as { content?: unknown[] }).content)
        ? (result as { content?: unknown[] }).content
        : []
    }
  }

  async dispose (): Promise<void> {
    const sessions = Array.from(this.sessions.values())
    await Promise.allSettled(sessions.map(async session => {
      await this.closeSession(session, true)
    }))
    this.emitStateChanged()
  }

  private createSession (config: MCPServerConfig): MCPServerSession {
    return {
      config,
      status: 'disconnected',
      updatedAt: null,
      tools: [],
      resources: [],
      prompts: [],
      capabilities: {
        tools: false,
        resources: false,
        prompts: false
      },
      bindings: new Map(),
      notificationHandlersInstalled: false
    }
  }

  private getSessionOrThrow (serverId: string): MCPServerSession {
    const session = this.sessions.get(serverId)
    if (!session) {
      throw new Error(t('mainDialog.mcpServerNotFound', { serverId }))
    }
    return session
  }

  private buildSnapshot (session: MCPServerSession): MCPServerSnapshot {
    return {
      id: session.config.id,
      name: session.config.name,
      enabled: session.config.enabled,
      transport: session.config.transport,
      status: session.status,
      error: session.error,
      updatedAt: session.updatedAt,
      tools: Array.from(session.bindings.values()).map(binding => ({
        name: binding.remoteName,
        localName: binding.localName,
        description: binding.definition.description,
        inputSchema: binding.definition.parameters
      })),
      resources: session.resources.map(resource => ({
        uri: resource.uri,
        name: resource.name || resource.uri,
        description: typeof resource.description === 'string' ? resource.description : undefined,
        mimeType: typeof resource.mimeType === 'string' ? resource.mimeType : undefined
      })),
      prompts: session.prompts.map(prompt => ({
        name: prompt.name,
        description: prompt.description || '',
        arguments: parsePromptArguments(prompt)
      })),
      capabilities: {
        ...session.capabilities
      }
    }
  }

  private findBinding (localName: string): MCPDynamicToolBinding | null {
    for (const session of this.sessions.values()) {
      const binding = session.bindings.get(localName)
      if (binding) return binding
    }
    return null
  }

  private async ensureConnected (serverId: string): Promise<MCPServerSession> {
    const session = this.getSessionOrThrow(serverId)
    if (!session.config.enabled) {
      throw new Error(t('mainDialog.mcpServerDisabled', { name: session.config.name }))
    }

    if (session.client && session.status === 'connected') {
      return session
    }

    if (!session.connectPromise) {
      session.connectPromise = this.connectSession(session)
        .finally(() => {
          session.connectPromise = undefined
        })
    }

    await session.connectPromise
    return session
  }

  private async connectSession (session: MCPServerSession): Promise<void> {
    session.status = 'connecting'
    session.error = undefined
    this.emitStateChanged()

    try {
      const transport = this.createTransport(session.config)
      const client = new Client({
        name: 'the-world',
        version: process.env.npm_package_version || '1.0.0'
      })

      await withTimeout(client.connect(transport), session.config.timeoutMs, t('mainDialog.mcpConnectServerLabel', { name: session.config.name }))

      session.client = client
      session.transport = transport
      session.status = 'connected'
      session.updatedAt = new Date().toISOString()
      this.installNotificationHandlers(session)
      await this.refreshSessionMetadata(session)
    } catch (error) {
      session.status = 'error'
      session.error = (error as Error).message || String(error)
      session.updatedAt = new Date().toISOString()
      await this.closeSession(session, false)
      session.status = 'error'
      session.error = (error as Error).message || String(error)
      throw error
    } finally {
      this.emitStateChanged()
    }
  }

  private createTransport (config: MCPServerConfig): MCPClientTransport {
    if (config.transport === 'streamable-http') {
      if (!config.url) throw new Error(t('mainDialog.mcpServerMissingUrl', { name: config.name }))
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: Object.keys(config.headers).length > 0
          ? { headers: config.headers }
          : undefined
      })
    }

    if (config.transport === 'sse') {
      if (!config.url) throw new Error(t('mainDialog.mcpServerMissingUrl', { name: config.name }))
      return new SSEClientTransport(new URL(config.url), {
        requestInit: Object.keys(config.headers).length > 0
          ? { headers: config.headers }
          : undefined
      })
    }

    if (!config.command) {
      throw new Error(t('mainDialog.mcpServerMissingCommand', { name: config.name }))
    }

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        env[key] = value
      }
    }

    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd || undefined,
      env: {
        ...env,
        ...config.env
      }
    })
  }

  private installNotificationHandlers (session: MCPServerSession): void {
    if (session.notificationHandlersInstalled || !session.client) return

    session.client.setNotificationHandler('notifications/tools/list_changed', async () => {
      await this.refreshServer(session.config.id)
    })
    session.client.setNotificationHandler('notifications/resources/list_changed', async () => {
      await this.refreshServer(session.config.id)
    })
    session.client.setNotificationHandler('notifications/prompts/list_changed', async () => {
      await this.refreshServer(session.config.id)
    })
    session.notificationHandlersInstalled = true
  }

  private async refreshSessionMetadata (session: MCPServerSession): Promise<void> {
    if (!session.client) return

    const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
      this.listToolsSafe(session),
      this.listResourcesSafe(session),
      this.listPromptsSafe(session)
    ])

    session.tools = toolsResult.items
    session.resources = resourcesResult.items
    session.prompts = promptsResult.items
    session.capabilities = {
      tools: toolsResult.supported,
      resources: resourcesResult.supported,
      prompts: promptsResult.supported
    }
    session.updatedAt = new Date().toISOString()
    this.rebuildBindings(session)
    this.emitStateChanged()
  }

  private rebuildBindings (session: MCPServerSession): void {
    session.bindings.clear()

    for (const tool of session.tools) {
      const localName = buildLocalToolName(session.config.id, tool.name)
      session.bindings.set(localName, {
        localName,
        remoteName: tool.name,
        serverId: session.config.id,
        definition: {
          name: localName,
          description: `[MCP:${session.config.name}] ${tool.description || tool.name}`,
          parameters: normalizeToolSchema((tool as unknown as { inputSchema?: unknown }).inputSchema)
        }
      })
    }
  }

  private async listToolsSafe (session: MCPServerSession): Promise<{ supported: boolean; items: Tool[] }> {
    try {
      const result = await withTimeout(
        session.client!.listTools() as Promise<{ tools?: Tool[] }>,
        session.config.timeoutMs,
        `列出 ${session.config.name} 工具`
      )
      return { supported: true, items: Array.isArray(result.tools) ? result.tools : [] }
    } catch {
      return { supported: false, items: [] }
    }
  }

  private async listResourcesSafe (session: MCPServerSession): Promise<{ supported: boolean; items: Resource[] }> {
    try {
      const result = await withTimeout(
        session.client!.listResources() as Promise<{ resources?: Resource[] }>,
        session.config.timeoutMs,
        `列出 ${session.config.name} 资源`
      )
      return { supported: true, items: Array.isArray(result.resources) ? result.resources : [] }
    } catch {
      return { supported: false, items: [] }
    }
  }

  private async listPromptsSafe (session: MCPServerSession): Promise<{ supported: boolean; items: Prompt[] }> {
    try {
      const result = await withTimeout(
        session.client!.listPrompts() as Promise<{ prompts?: Prompt[] }>,
        session.config.timeoutMs,
        `列出 ${session.config.name} Prompt`
      )
      return { supported: true, items: Array.isArray(result.prompts) ? result.prompts : [] }
    } catch {
      return { supported: false, items: [] }
    }
  }

  private async closeSession (session: MCPServerSession, clearMetadata: boolean): Promise<void> {
    try {
      await (session.client as unknown as { close?: () => Promise<void> } | undefined)?.close?.()
    } catch {
      // Best-effort shutdown
    }

    try {
      await session.transport?.close?.()
    } catch {
      // Best-effort shutdown
    }

    session.client = undefined
    session.transport = undefined
    session.status = 'disconnected'
    if (clearMetadata) {
      session.error = undefined
      session.updatedAt = null
      session.tools = []
      session.resources = []
      session.prompts = []
      session.capabilities = {
        tools: false,
        resources: false,
        prompts: false
      }
      session.bindings.clear()
    }
  }

  private emitStateChanged (): void {
    this.emit('stateChanged', this.getState())
  }
}
