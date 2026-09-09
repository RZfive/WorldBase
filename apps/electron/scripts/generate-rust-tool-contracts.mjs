import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ElectronToolRegistry } from '../src/main/ai-harness/electron-tool-registry.ts'
import { MCPService } from '../src/main/mcp/mcp-service.ts'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const electronRoot = path.resolve(scriptDir, '..')
const outputPath = path.resolve(
  electronRoot,
  '../../harness-rs/crates/tools/electron-tool-contracts.json'
)

const noOp = async () => ({})
const services = {
  projectFS: {},
  runtimeManager: {},
  builderService: {},
  apiClient: {},
  dataAccess: {},
  asyncTaskManager: {},
  documentStore: {},
  skillStore: {},
  agentStore: {},
  agentGroupStore: {},
  settingsStore: {},
  imageLibraryStore: {},
  enqueueStudioImageTasks: () => {},
  readActivePage: noOp,
  interactWithActivePage: noOp,
  mcpService: new MCPService(),
  scheduledTaskService: {}
}

const registry = new ElectronToolRegistry({
  services,
  getNativeToolDefinitions: () => [],
  runSubagents: async () => []
})
const tools = registry
  .getToolDefinitions()
  .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

const names = tools.map(tool => tool.name)
if (new Set(names).size !== names.length) {
  throw new Error('Electron tool registry produced duplicate public tool names')
}
if (tools.length !== 68) {
  throw new Error(`Electron tool registry produced ${tools.length} public tools; expected exactly 68`)
}
for (const tool of tools) {
  if (!tool.name || !tool.description || tool.parameters?.type !== 'object') {
    throw new Error(`Invalid Electron tool contract: ${tool.name || '<unnamed>'}`)
  }
}

const document = {
  version: 1,
  source: 'apps/electron/src/main/ai-engine/agent/tools',
  tools
}
const serialized = `${JSON.stringify(document, null, 2)}\n`
if (process.argv.includes('--check')) {
  const current = await fs.readFile(outputPath, 'utf8').catch(() => '')
  if (current !== serialized) {
    throw new Error(
      'Rust tool contracts are stale. Run `pnpm generate:harness-tool-contracts`.'
    )
  }
  console.log(`Verified ${tools.length} Electron tool contracts`)
} else {
  await fs.writeFile(outputPath, serialized)
  console.log(`Wrote ${tools.length} Electron tool contracts to ${outputPath}`)
}
