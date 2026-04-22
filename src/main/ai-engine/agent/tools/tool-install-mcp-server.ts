import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { MCPService } from '../../../mcp/mcp-service.js'
import {
  DEFAULT_MCP_SERVER_TIMEOUT_MS,
  type MCPServerConfig,
  type MCPTransportType,
  type SettingsStore
} from '../../../settings/settings-store.js'

interface ToolServices {
  settingsStore?: SettingsStore
  mcpService?: MCPService
}

interface InstallMcpServerArgs {
  server_id?: string
  name: string
  enabled?: boolean
  transport: MCPTransportType
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, unknown>
  url?: string
  headers?: Record<string, unknown>
  timeout_ms?: number
  overwrite_existing?: boolean
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

function normalizeString (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeTransport (value: unknown): MCPTransportType | null {
  return value === 'stdio' || value === 'streamable-http' || value === 'sse'
    ? value
    : null
}

function normalizeStringArray (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

function normalizeStringMap (value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, rawValue]) => [key.trim(), rawValue == null ? '' : String(rawValue)])
      .filter(([key]) => key.length > 0)
  )
}

function slugifyServerId (value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  return normalized || 'server'
}

function buildUniqueServerId (requestedId: string, existingIds: Set<string>): string {
  const base = `mcp_${slugifyServerId(requestedId)}`
  if (!existingIds.has(base)) return base

  let index = 2
  while (existingIds.has(`${base}_${index}`)) {
    index += 1
  }
  return `${base}_${index}`
}

function resolveServerIndex (servers: MCPServerConfig[], serverId: string, name: string): number {
  const normalizedName = name.trim().toLowerCase()
  return servers.findIndex(server => {
    if (serverId && server.id === serverId) return true
    return server.name.trim().toLowerCase() === normalizedName
  })
}

export function toolInstallMcpServer (services: ToolServices): Tool {
  return {
    definition: {
      name: 'install_mcp_server',
      description: 'Install or update an MCP server configuration in the app settings. After user approval, the server entry is saved and enabled so the agent can use it without manual settings-page configuration.',
      parameters: {
        type: 'object',
        properties: {
          server_id: {
            type: 'string',
            description: 'Optional stable server ID. If omitted, one is generated from the server name.'
          },
          name: {
            type: 'string',
            description: 'Display name of the MCP server.'
          },
          enabled: {
            type: 'boolean',
            description: 'Whether the server should be enabled immediately. Defaults to true.'
          },
          transport: {
            type: 'string',
            enum: ['stdio', 'streamable-http', 'sse'],
            description: 'Transport type used by the MCP server.'
          },
          command: {
            type: 'string',
            description: 'Required for stdio transport. Command to launch the MCP server.'
          },
          args: {
            type: 'array',
            description: 'Optional command-line arguments for stdio transport.',
            items: { type: 'string' }
          },
          cwd: {
            type: 'string',
            description: 'Optional working directory for stdio transport.'
          },
          env: {
            type: 'object',
            description: 'Optional environment variables for stdio transport.',
            additionalProperties: true
          },
          url: {
            type: 'string',
            description: 'Required for streamable-http or sse transports.'
          },
          headers: {
            type: 'object',
            description: 'Optional request headers for HTTP/SSE transports.',
            additionalProperties: true
          },
          timeout_ms: {
            type: 'integer',
            description: `Optional connection timeout in milliseconds. Defaults to ${DEFAULT_MCP_SERVER_TIMEOUT_MS}.`
          },
          overwrite_existing: {
            type: 'boolean',
            description: 'Whether an existing server with the same ID or name should be replaced. Defaults to true.'
          }
        },
        required: ['name', 'transport']
      }
    },
    handler: async (args, onProgress) => {
      if (!services.settingsStore || !services.mcpService) {
        return { error: 'MCP configuration services are not available in this runtime.' }
      }

      const name = normalizeString(args.name)
      const transport = normalizeTransport(args.transport)
      const overwriteExisting = args.overwrite_existing !== false
      if (!name) {
        return { error: 'name is required to install an MCP server.' }
      }
      if (!transport) {
        return { error: 'transport must be one of stdio, streamable-http, or sse.' }
      }

      const command = normalizeString(args.command)
      const url = normalizeString(args.url)
      if (transport === 'stdio' && !command) {
        return { error: 'command is required for stdio MCP servers.' }
      }
      if ((transport === 'streamable-http' || transport === 'sse') && !url) {
        return { error: 'url is required for HTTP/SSE MCP servers.' }
      }

      const existingServers = services.settingsStore.getMcpServers()
      const requestedServerId = normalizeString(args.server_id)
      const existingIndex = resolveServerIndex(existingServers, requestedServerId, name)
      if (existingIndex >= 0 && !overwriteExisting) {
        return { error: `MCP server ${existingServers[existingIndex].name} already exists.` }
      }

      const existingIds = new Set(existingServers.map(server => server.id))
      const serverId = existingIndex >= 0
        ? existingServers[existingIndex].id
        : buildUniqueServerId(requestedServerId || name, existingIds)

      const timeoutMs = Math.max(1000, Math.floor(Number(args.timeout_ms) || DEFAULT_MCP_SERVER_TIMEOUT_MS))
      const nextServer: MCPServerConfig = {
        id: serverId,
        name,
        enabled: args.enabled !== false,
        transport,
        command,
        args: normalizeStringArray(args.args),
        cwd: normalizeString(args.cwd),
        env: normalizeStringMap(args.env),
        url,
        headers: normalizeStringMap(args.headers),
        timeoutMs
      }

      const nextServers = existingIndex >= 0
        ? existingServers.map((server, index) => index === existingIndex ? nextServer : server)
        : [...existingServers, nextServer]

      onProgress?.('🔌 Installing MCP server...', name)
      services.settingsStore.saveMcpServers(nextServers)
      await services.mcpService.updateServers(nextServers)

      const snapshot = nextServer.enabled
        ? await services.mcpService.refreshServer(nextServer.id)
        : services.mcpService.getState().servers.find(server => server.id === nextServer.id) || null

      onProgress?.('✅ MCP server installed', name)

      return {
        success: true,
        action: existingIndex >= 0 ? 'updated' : 'installed',
        server: nextServer,
        connection: snapshot,
        message: existingIndex >= 0
          ? `MCP 服务 ${name} 已更新。`
          : `MCP 服务 ${name} 已安装。`
      }
    }
  }
}