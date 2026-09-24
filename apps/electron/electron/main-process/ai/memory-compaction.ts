import { randomUUID } from 'node:crypto'
import { createProvider } from '../../../src/main/ai-engine/providers/index.js'
import type { ChatProvider } from '../../../src/main/ai-engine/providers/index.js'
import type { ChatMessage } from '../../../src/main/ai-engine/providers/openai-provider.js'
import type { AIExecutionEngine } from '../../../src/main/ai-harness/types.js'
import type { MemoryCompactionPlan, MemoryCompactionResult, MemoryCompactionStatus, MemoryEntry } from '../../../src/shared/agent-workspace-types.js'
import { MEMORY_AI_COMPACTION_TIMEOUT_MS } from '../constants.js'
import { mainState } from '../state.js'
import { broadcastToAppWindows } from '../windows.js'
import { getMessageText } from '../chat-message-utils.js'
import { resolveProviderConfig } from './agent-context.js'
import { startSelectedRustHarness } from './selected-execution-engine.js'
import { t } from '../../../src/main/i18n/main-i18n.js'
import {
  buildModelOutputPreview,
  chunkMemoryEntriesForAiCompaction,
  mergeMemoryCompactionPlans,
  parseMemoryCompactionPlan,
  serializeMemoryEntryForAi
} from './memory-compaction-plan.js'

export {
  buildModelOutputPreview,
  chunkMemoryEntriesForAiCompaction,
  extractJsonObjectCandidate,
  mergeMemoryCompactionPlans,
  parseMemoryCompactionPlan,
  sanitizeMemoryPlanIdList,
  sanitizeMemoryPlanNumber,
  sanitizeMemoryPlanTags,
  sanitizeMemoryPlanText,
  serializeMemoryEntryForAi,
  sortMemoryEntriesForAiCompaction
} from './memory-compaction-plan.js'

export function cloneMemoryCompactionStatus (): MemoryCompactionStatus {
  return {
    ...mainState.memoryCompactionStatus,
    result: mainState.memoryCompactionStatus.result
      ? {
          ...mainState.memoryCompactionStatus.result,
          groups: mainState.memoryCompactionStatus.result.groups.map(group => ({
            ...group,
            mergedIds: [...group.mergedIds]
          }))
        }
      : undefined
  }
}

export function updateMemoryCompactionStatus (patch: Partial<MemoryCompactionStatus>): MemoryCompactionStatus {
  mainState.memoryCompactionStatus = {
    ...mainState.memoryCompactionStatus,
    ...patch,
    updatedAt: new Date().toISOString()
  }
  const snapshot = cloneMemoryCompactionStatus()
  broadcastToAppWindows('memory:compactionStatusChanged', snapshot)
  return snapshot
}

/** Provider/model selection for the plan builder; empty ids follow the active chat model. */
export interface MemoryCompactionModelSelection {
  providerId?: string
  modelId?: string
}

export function createMemoryCompactionProvider (selection?: MemoryCompactionModelSelection): ChatProvider {
  const providerConfig = resolveProviderConfig(selection?.providerId, selection?.modelId, 'low')
  if (!providerConfig?.apiKey || !providerConfig.baseUrl || !providerConfig.model) {
    throw new Error(t('mainDialog.memoryCompactionProviderIncomplete'))
  }

  const provider = createProvider({
    baseUrl: providerConfig.baseUrl,
    apiProtocol: providerConfig.apiProtocol
  })
  provider.setApiKey(providerConfig.apiKey)
  provider.setBaseUrl(providerConfig.baseUrl)
  provider.setModel(providerConfig.model)
  provider.setEnableThinking(false)
  provider.setTemperature(0.1)
  if (providerConfig.contextWindow) {
    provider.setContextWindow(providerConfig.contextWindow)
  }
  return provider
}

export async function requestMemoryCompactionPlanChunk (provider: ChatProvider, entries: MemoryEntry[], index: number, total: number): Promise<MemoryCompactionPlan> {
  const messages = buildMemoryCompactionMessages(entries, index, total)

  return await withSingleRetry(async () => {
    const response = await provider.chatCompletion(messages, [], undefined, { timeoutMs: MEMORY_AI_COMPACTION_TIMEOUT_MS })
    const text = getMessageText(response.content)
    if (!text) throw new Error(t('mainDialog.memoryCompactionEmptyResponse'))
    return parseMemoryCompactionPlan(text, entries)
  }, index, total)
}

function buildMemoryCompactionMessages (entries: MemoryEntry[], index: number, total: number): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是 WorldBase 的长期记忆整理器。你的任务是压缩整理用户、Agent、项目和频道记忆。',
        '只允许基于输入 JSON 中的记忆做判断，不得编造新事实，不得引用输入外的 ID。',
        '删除标准：空壳内容、Markdown 标题/表格碎片、无复用价值碎片、明显过时或与软件工程/当前 Agent 工作无关的知识。',
        '合并标准：同一 scope 且同一 type 下语义重复或高度近似的记忆。跨 scope 或跨 type 不要合并。',
        '置顶 pinned=true 的记忆不得放入 deleteIds；如果参与合并，优先作为 targetId。',
        'updates 用来改写仍有价值但表达松散的记忆，让 title/summary 更短、更准确。',
        '输出严格 JSON，不要 Markdown，不要解释。格式：',
        '{"deleteIds":["id"],"mergeGroups":[{"ids":["id1","id2"],"targetId":"id1","title":"短标题","summary":"合并后的完整事实","details":"可选详情","tags":["tag"]}],"updates":[{"id":"id","title":"短标题","summary":"整理后的事实","details":"可选详情","tags":["tag"],"importance":0.8,"confidence":0.8}]}'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `这是第 ${index + 1}/${total} 批记忆。请整理这一批。`,
        JSON.stringify(entries.map(serializeMemoryEntryForAi), null, 2)
      ].join('\n\n')
    }
  ]
}

async function requestMemoryCompactionPlanChunkWithEngine (engine: AIExecutionEngine, entries: MemoryEntry[], index: number, total: number, selection?: MemoryCompactionModelSelection): Promise<MemoryCompactionPlan> {
  const providerConfig = resolveProviderConfig(selection?.providerId, selection?.modelId, 'low')
  if (!providerConfig?.apiKey || !providerConfig.baseUrl || !providerConfig.model) {
    throw new Error(t('mainDialog.memoryCompactionProviderIncomplete'))
  }
  const messages = buildMemoryCompactionMessages(entries, index, total)
  return await withSingleRetry(async () => {
    const response = await engine.chat(messages, {
      providerConfig: {
        ...providerConfig,
        temperature: 0.1,
        // Compaction is a constrained JSON-only request. Provider-side thinking
        // burns the output budget on reasoning and can leave the final content
        // empty, which then fails plan parsing.
        enableThinking: false,
        reasoningEffort: 'low'
      },
      // The legacy compactor is a constrained JSON-only model request. Keep
      // that behavior while routing provider execution through Rust.
      allowedToolNames: ['__memory_compaction_no_tools__']
    })
    const text = getMessageText(response.content)
    if (!text) throw new Error(t('mainDialog.memoryCompactionEmptyResponse'))
    return parseMemoryCompactionPlan(text, entries)
  }, index, total)
}

/** Retry a chunk request once; a single malformed response must not fail the whole run. */
async function withSingleRetry (request: () => Promise<MemoryCompactionPlan>, index: number, total: number): Promise<MemoryCompactionPlan> {
  try {
    return await request()
  } catch (firstError) {
    console.warn(`[memory-compaction] Batch ${index + 1}/${total} failed once, retrying:`, firstError instanceof Error ? firstError.message : firstError)
    return await request()
  }
}

export async function buildMemoryCompactionPlanWithAi (
  entries: MemoryEntry[],
  onProgress?: (progress: { stage: string; detail?: string; totalChunks: number; completedChunks: number }) => void,
  engine?: AIExecutionEngine,
  selection?: MemoryCompactionModelSelection
): Promise<MemoryCompactionPlan> {
  if (entries.length === 0) return { deleteIds: [], mergeGroups: [], updates: [] }

  const provider = engine ? null : createMemoryCompactionProvider(selection)
  const chunks = chunkMemoryEntriesForAiCompaction(entries)
  const plans: MemoryCompactionPlan[] = []
  onProgress?.({
    stage: t('mainDialog.memoryCompactionPreparing'),
    detail: t('mainDialog.memoryCompactionBatchCount', { count: chunks.length }),
    totalChunks: chunks.length,
    completedChunks: 0
  })

  for (let index = 0; index < chunks.length; index++) {
    onProgress?.({
      stage: t('mainDialog.memoryCompactionAnalyzing'),
      detail: t('mainDialog.memoryCompactionAnalyzingBatch', { current: index + 1, total: chunks.length }),
      totalChunks: chunks.length,
      completedChunks: index
    })
    plans.push(engine
      ? await requestMemoryCompactionPlanChunkWithEngine(engine, chunks[index], index, chunks.length, selection)
      : await requestMemoryCompactionPlanChunk(provider!, chunks[index], index, chunks.length))
    onProgress?.({
      stage: t('mainDialog.memoryCompactionAnalyzing'),
      detail: t('mainDialog.memoryCompactionBatchDone', { current: index + 1, total: chunks.length }),
      totalChunks: chunks.length,
      completedChunks: index + 1
    })
  }

  return mergeMemoryCompactionPlans(plans)
}

export async function runMemoryCompactionWithStatus (selection?: MemoryCompactionModelSelection): Promise<MemoryCompactionResult> {
  const taskId = randomUUID()
  const startedAt = new Date().toISOString()
  updateMemoryCompactionStatus({
    id: taskId,
    status: 'running',
    stage: t('mainDialog.memoryCompactionScanning'),
    detail: t('mainDialog.memoryCompactionReadingAll'),
    scanned: 0,
    totalChunks: 0,
    completedChunks: 0,
    startedAt,
    finishedAt: undefined,
    result: undefined,
    error: undefined
  })

  try {
    // Rust is the single memory source; the scan and the apply both go
    // through harness RPC. The AI plan builder stays host-side.
    const rustHarness = await startSelectedRustHarness()
    const rustClient = rustHarness ? mainState.rustHarness : null
    if (!rustClient) throw new Error('Rust harness is required for memory compaction.')
    const entries = await rustClient.listMemory({ limit: 50000 })
    // The plan builder may still use the Rust harness as its analysis-model
    // backend; that is a chat-model role and independent of memory ownership.
    const analysisEngine = await startSelectedRustHarness()
    updateMemoryCompactionStatus({
      id: taskId,
      status: 'running',
      stage: entries.length > 0 ? t('mainDialog.memoryCompactionPreparing') : t('mainDialog.memoryCompactionNoop'),
      detail: entries.length > 0 ? t('mainDialog.memoryCompactionScannedCount', { count: entries.length }) : t('mainDialog.memoryCompactionNoEntries'),
      scanned: entries.length,
      totalChunks: entries.length > 0 ? mainState.memoryCompactionStatus.totalChunks : 0,
      completedChunks: 0
    })

    const plan = await buildMemoryCompactionPlanWithAi(entries, (progress) => {
      updateMemoryCompactionStatus({
        id: taskId,
        status: 'running',
        stage: progress.stage,
        detail: progress.detail,
        scanned: entries.length,
        totalChunks: progress.totalChunks,
        completedChunks: progress.completedChunks
      })
    }, analysisEngine || undefined, selection)

    updateMemoryCompactionStatus({
      id: taskId,
      status: 'running',
      stage: t('mainDialog.memoryCompactionApplying'),
      detail: t('mainDialog.memoryCompactionApplyingDetail'),
      scanned: entries.length,
      completedChunks: mainState.memoryCompactionStatus.totalChunks
    })

    // Unified ownership: compaction always applies to the Memory Service
    // store, regardless of the selected backend.
    const result = await rustClient.compactWorkspaceMemory(plan as unknown as Record<string, unknown>) as unknown as MemoryCompactionResult
    updateMemoryCompactionStatus({
      id: taskId,
      status: 'completed',
      stage: t('mainDialog.memoryCompactionDone'),
      detail: t('mainDialog.memoryCompactionDoneDetail', { scanned: result.scanned, removed: result.removedUseless, merged: result.merged, updated: result.updated }),
      scanned: result.scanned,
      completedChunks: mainState.memoryCompactionStatus.totalChunks,
      finishedAt: new Date().toISOString(),
      result,
      error: undefined
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateMemoryCompactionStatus({
      id: taskId,
      status: 'failed',
      stage: t('mainDialog.memoryCompactionFailedStage'),
      detail: message,
      finishedAt: new Date().toISOString(),
      error: message
    })
    throw error
  } finally {
    mainState.activeMemoryCompactionPromise = null
  }
}
