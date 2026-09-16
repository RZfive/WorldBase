import { ref, watch, type Ref } from 'vue'
import type { ComposerTranslation } from 'vue-i18n'
import type {
  LongTermGoalChangeSet,
  LongTermGoalDefinition,
  LongTermGoalMessageResult,
  LongTermGoalRun,
  LongTermGoalSnapshot
} from '../../../../shared/long-term-goal-types.js'
import {
  appendFinalContentBlock,
  createContentBlock,
  createToolBlock,
  createToolRun,
  createWebFetchBlock,
  createWebSearchBlock,
  closeOpenThinkingBlocks,
  ensureBlocks,
  ensureStreamingContentBlock,
  ensureThinkingBlock,
  findLastRunningToolRun,
  generateId,
  setAssistantErrorState,
  syncLegacyToolRuns
} from './message-blocks'
import { getMessageTextContent } from './message-runtime'
import type { ChatMessage, ToolRun, WebFetchResultEntry } from './types'

interface LongTermGoalMemoryCompactionProgress {
  goalId: string
  status: 'running' | 'completed' | 'failed'
  stage: string
  detail?: string
  percent: number
  error?: string
}

interface LongTermGoalStateOptions {
  t: ComposerTranslation
  longTermGoals: Ref<LongTermGoalDefinition[]>
  longTermGoalSnapshot: Ref<LongTermGoalSnapshot | null>
  selectedLongTermGoalId: Ref<string | null>
  activeProviderId: Ref<string>
  selectedModel: Ref<string>
  prepareGoalWorkspace: () => void
  startNewConversation: () => void
}

const pendingGoalTitleOverrides = new Map<string, string>()
const pendingGoalStatusOverrides = new Map<string, LongTermGoalDefinition['status']>()
const STREAM_RENDER_FLUSH_INTERVAL_MS = 50

export function createLongTermGoalState (options: LongTermGoalStateOptions) {
  const {
    t,
    longTermGoals,
    longTermGoalSnapshot,
    selectedLongTermGoalId,
    activeProviderId,
    selectedModel,
    prepareGoalWorkspace,
    startNewConversation
  } = options

  const streamingAdjust = ref<{ userContent: string; message: ChatMessage } | null>(null)
  const streamingCreate = ref<{ userContent: string; message: ChatMessage } | null>(null)
  const streamingRun = ref<{ goalId: string; run: LongTermGoalRun } | null>(null)
  const streamingReplan = ref<{ goalId: string; message: ChatMessage } | null>(null)
  const memoryCompaction = ref<LongTermGoalMemoryCompactionProgress | null>(null)
  const createConversationHistory = ref<ChatMessage[]>([])
  const pendingCreationConfirm = ref<{ changeSet: LongTermGoalChangeSet; proposal: NonNullable<LongTermGoalMessageResult['proposal']> } | null>(null)
  const goalAutoOpenRunId = ref<string | null>(null)

  watch(selectedLongTermGoalId, () => {
    streamingAdjust.value = null
    streamingRun.value = null
    streamingReplan.value = null
    memoryCompaction.value = null
    streamingCreate.value = null
    createConversationHistory.value = []
    pendingCreationConfirm.value = null
  })

  function mergeGoalTitleState (incomingGoal: LongTermGoalDefinition, existingGoal?: LongTermGoalDefinition): LongTermGoalDefinition {
    const pendingStatus = pendingGoalStatusOverrides.get(incomingGoal.id)
    const pendingTitle = pendingGoalTitleOverrides.get(incomingGoal.id)
    const mergedGoal = pendingStatus ? { ...incomingGoal, status: pendingStatus } : { ...incomingGoal }
    if (pendingTitle) mergedGoal.title = pendingTitle
    return mergedGoal
  }

  async function loadLongTermGoals () {
    if (!window.electronAPI?.listLongTermGoals) return
    try {
      longTermGoals.value = await window.electronAPI.listLongTermGoals()
      if (selectedLongTermGoalId.value && !longTermGoals.value.some(goal => goal.id === selectedLongTermGoalId.value)) {
        selectedLongTermGoalId.value = null
        longTermGoalSnapshot.value = null
      }
    } catch {
      /* ignore */
    }
  }

  async function loadLongTermGoalSnapshot (goalId?: string | null) {
    if (!window.electronAPI?.getLongTermGoalSnapshot) return
    try {
      longTermGoalSnapshot.value = await window.electronAPI.getLongTermGoalSnapshot(goalId || undefined)
    } catch {
      /* ignore */
    }
  }

  async function openLongTermGoal (goalId: string): Promise<void> {
    prepareGoalWorkspace()
    selectedLongTermGoalId.value = goalId
    await loadLongTermGoalSnapshot(goalId)
  }

  async function createLongTermGoal (seed?: string, options?: { providerId?: string | null; modelId?: string | null }): Promise<void> {
    if (!window.electronAPI?.streamLongTermGoalCreate) return
    const normalizedSeed = typeof seed === 'string' ? seed.trim() : ''
    if (!normalizedSeed) return

    const streamId = generateId()
    const message: ChatMessage = {
      role: 'assistant',
      content: '',
      speakerName: 'Long-Term Goal',
      blocks: [createContentBlock('')]
    }
    streamingCreate.value = { userContent: normalizedSeed, message }
    const result = await streamGoalConversation(message, streamId, () => window.electronAPI!.streamLongTermGoalCreate!(normalizedSeed, {
      providerId: options?.providerId || activeProviderId.value || null,
      modelId: options?.modelId || selectedModel.value || null
    }, streamId))
    streamingCreate.value = null
    if (!result) return

    // createGoalViaConversation no longer auto-saves — the goal stays a draft until the user
    // confirms via the ask-style gate. Append this turn to the create conversation history.
    const finalContent = result.assistantTurn?.content || (typeof message.content === 'string' ? message.content : '')
    createConversationHistory.value = [...createConversationHistory.value, {
      role: 'user',
      content: normalizedSeed,
      blocks: [{ id: `goal_create_user_${generateId()}`, kind: 'content', content: normalizedSeed }]
    }, {
      role: 'assistant',
      content: finalContent,
      speakerName: 'Long-Term Goal',
      blocks: [{ id: `goal_create_asst_${generateId()}`, kind: 'content', content: finalContent }]
    }]
    // If the AI produced a proposal, surface the confirmation gate; otherwise stay open for more input.
    pendingCreationConfirm.value = result.changeSet && result.proposal
      ? { changeSet: result.changeSet, proposal: result.proposal }
      : null
  }

  async function saveLongTermGoalPatch (goal: LongTermGoalDefinition, patch: Partial<LongTermGoalDefinition>): Promise<void> {
    if (!window.electronAPI?.saveLongTermGoal) return
    if (typeof patch.title === 'string' && patch.title.trim() && patch.title.trim() !== goal.title && Object.keys(patch).length === 1) {
      await renameLongTermGoal(goal, patch.title)
      return
    }
    // IPC 用 structured clone 序列化，Vue reactive proxy 的嵌套对象/数组无法被克隆，
    // 会抛 "An object could not be cloned."。这里深拷贝成纯对象再合并 patch。
    const plainGoal = JSON.parse(JSON.stringify(goal)) as LongTermGoalDefinition
    const saved = await window.electronAPI.saveLongTermGoal({
      ...plainGoal,
      ...patch,
      title: patch.title || plainGoal.title,
      objective: patch.objective || plainGoal.objective,
      schedule: patch.schedule || plainGoal.schedule
    })
    longTermGoals.value = longTermGoals.value.map(item => item.id === saved.id ? mergeGoalTitleState(saved, item) : item)
    if (!longTermGoals.value.some(item => item.id === saved.id)) {
      longTermGoals.value = [saved, ...longTermGoals.value]
    }
    if (longTermGoalSnapshot.value?.goals.some(item => item.id === saved.id)) {
      longTermGoalSnapshot.value = {
        ...longTermGoalSnapshot.value,
        goals: longTermGoalSnapshot.value.goals.map(item => item.id === saved.id ? mergeGoalTitleState(saved, item) : item)
      }
    }
    selectedLongTermGoalId.value = saved.id
    await loadLongTermGoalSnapshot(saved.id)
  }

  async function renameLongTermGoal (goal: LongTermGoalDefinition, titleInput: string): Promise<void> {
    const title = titleInput.trim()
    if (!title || title === goal.title) return
    const optimisticGoal: LongTermGoalDefinition = {
      ...goal,
      title,
      updatedAt: new Date().toISOString()
    }
    longTermGoals.value = longTermGoals.value.map(item => item.id === goal.id ? optimisticGoal : item)
    pendingGoalTitleOverrides.set(goal.id, title)
    if (longTermGoalSnapshot.value?.goals.some(item => item.id === goal.id)) {
      longTermGoalSnapshot.value = {
        ...longTermGoalSnapshot.value,
        goals: longTermGoalSnapshot.value.goals.map(item => item.id === goal.id ? optimisticGoal : item)
      }
    }
    selectedLongTermGoalId.value = goal.id
    if (!window.electronAPI?.renameLongTermGoal) {
      pendingGoalTitleOverrides.delete(goal.id)
      await loadLongTermGoals()
      return
    }
    let saved: LongTermGoalDefinition
    try {
      saved = await window.electronAPI.renameLongTermGoal(goal.id, title)
    } catch (error) {
      pendingGoalTitleOverrides.delete(goal.id)
      await loadLongTermGoals()
      await loadLongTermGoalSnapshot(goal.id)
      throw error
    }
    pendingGoalTitleOverrides.delete(goal.id)
    longTermGoals.value = longTermGoals.value.map(item => item.id === saved.id ? mergeGoalTitleState(saved, item) : item)
    if (!longTermGoals.value.some(item => item.id === saved.id)) {
      longTermGoals.value = [saved, ...longTermGoals.value]
    }
    if (longTermGoalSnapshot.value?.goals.some(item => item.id === saved.id)) {
      longTermGoalSnapshot.value = {
        ...longTermGoalSnapshot.value,
        goals: longTermGoalSnapshot.value.goals.map(item => item.id === saved.id ? mergeGoalTitleState(saved, item) : item)
      }
    }
    await loadLongTermGoalSnapshot(saved.id)
  }

  async function pauseLongTermGoal (goal: LongTermGoalDefinition): Promise<void> {
    await setLongTermGoalStatus(goal, 'paused')
  }

  async function resumeLongTermGoal (goal: LongTermGoalDefinition): Promise<void> {
    await setLongTermGoalStatus(goal, 'active')
  }

  async function archiveLongTermGoal (goal: LongTermGoalDefinition): Promise<void> {
    await setLongTermGoalStatus(goal, 'archived')
  }

  async function setLongTermGoalStatus (goal: LongTermGoalDefinition, status: LongTermGoalDefinition['status']): Promise<void> {
    const optimisticGoal: LongTermGoalDefinition = {
      ...goal,
      status,
      currentPhase: status === 'active'
        ? (goal.currentPhase === '已暂停' ? '持续推进' : goal.currentPhase)
        : status === 'paused'
          ? '已暂停'
          : goal.currentPhase,
      updatedAt: new Date().toISOString()
    }
    pendingGoalStatusOverrides.set(goal.id, status)
    longTermGoals.value = longTermGoals.value.map(item => item.id === goal.id ? optimisticGoal : item)
    if (longTermGoalSnapshot.value?.goals.some(item => item.id === goal.id)) {
      longTermGoalSnapshot.value = {
        ...longTermGoalSnapshot.value,
        goals: longTermGoalSnapshot.value.goals.map(item => item.id === goal.id ? optimisticGoal : item)
      }
    }
    selectedLongTermGoalId.value = goal.id
    if (!window.electronAPI?.setLongTermGoalStatus) {
      pendingGoalStatusOverrides.delete(goal.id)
      await saveLongTermGoalPatch(optimisticGoal, { status })
      return
    }
    let saved: LongTermGoalDefinition
    try {
      saved = await window.electronAPI.setLongTermGoalStatus(goal.id, status)
    } catch (error) {
      pendingGoalStatusOverrides.delete(goal.id)
      await loadLongTermGoals()
      await loadLongTermGoalSnapshot(goal.id)
      throw error
    }
    pendingGoalStatusOverrides.delete(goal.id)
    longTermGoals.value = longTermGoals.value.map(item => item.id === saved.id ? mergeGoalTitleState(saved, item) : item)
    if (longTermGoalSnapshot.value?.goals.some(item => item.id === saved.id)) {
      longTermGoalSnapshot.value = {
        ...longTermGoalSnapshot.value,
        goals: longTermGoalSnapshot.value.goals.map(item => item.id === saved.id ? mergeGoalTitleState(saved, item) : item)
      }
    }
    await loadLongTermGoalSnapshot(saved.id)
  }

  async function deleteLongTermGoal (goalOrId: LongTermGoalDefinition | string): Promise<void> {
    if (!window.electronAPI?.deleteLongTermGoal) return
    const goalId = typeof goalOrId === 'string' ? goalOrId : goalOrId.id
    await window.electronAPI.deleteLongTermGoal(goalId)
    longTermGoals.value = longTermGoals.value.filter(item => item.id !== goalId)
    if (selectedLongTermGoalId.value === goalId) {
      selectedLongTermGoalId.value = longTermGoals.value[0]?.id || null
      longTermGoalSnapshot.value = null
      if (selectedLongTermGoalId.value) {
        await openLongTermGoal(selectedLongTermGoalId.value)
      } else {
        startNewConversation()
      }
    }
    await loadLongTermGoals()
  }

  async function runLongTermGoalNow (goalId: string): Promise<void> {
    if (!window.electronAPI?.runLongTermGoalNow) return
    await window.electronAPI.runLongTermGoalNow(goalId)
    await loadLongTermGoals()
    await loadLongTermGoalSnapshot(goalId)
    // 自动打开运行对话框，展示实时执行流；运行进度通过 onLongTermGoalRunProgress 持续更新。
    const snapshot = longTermGoalSnapshot.value
    const runningRun = snapshot?.runs.find(run => run.goalId === goalId && run.status === 'running')
    if (runningRun) {
      streamingRun.value = { goalId, run: runningRun }
      goalAutoOpenRunId.value = runningRun.id
    }
  }

  function clearGoalAutoOpenRunId (): void {
    goalAutoOpenRunId.value = null
  }

  async function streamGoalConversation<T = LongTermGoalMessageResult> (
    message: ChatMessage,
    streamId: string,
    invoke: () => Promise<T>
  ): Promise<T | null> {
    if (!window.electronAPI?.onLongTermGoalStreamEvent) {
      return invoke()
    }
    const toolRuns: ToolRun[] = []
    let thinkingAccum = ''
    let contentAccum = ''
    let pendingThinkingText = ''
    let pendingContentText = ''
    let flushTimer: number | null = null
    let hadToolSinceLastThinking = false

    const syncToolRuns = () => syncLegacyToolRuns(message, toolRuns)
    const clearTimer = () => {
      if (flushTimer != null) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }
    }
    const flush = () => {
      clearTimer()
      if (pendingThinkingText) {
        if (hadToolSinceLastThinking) {
          thinkingAccum = ''
          hadToolSinceLastThinking = false
        }
        thinkingAccum += pendingThinkingText
        message.thinking = thinkingAccum
        ensureThinkingBlock(message).text = thinkingAccum
        pendingThinkingText = ''
      }
      if (pendingContentText) {
        contentAccum += pendingContentText
        message.content = contentAccum
        const contentBlock = ensureStreamingContentBlock(message)
        const existing = typeof contentBlock.content === 'string' ? contentBlock.content : ''
        contentBlock.content = existing + pendingContentText
        pendingContentText = ''
      }
    }
    const scheduleFlush = () => {
      if (flushTimer != null) return
      flushTimer = window.setTimeout(() => {
        flushTimer = null
        flush()
      }, STREAM_RENDER_FLUSH_INTERVAL_MS)
    }
    const ensureActiveToolRun = (name?: string) => {
      const existing = findLastRunningToolRun(toolRuns, name) || findLastRunningToolRun(toolRuns)
      if (existing) return existing
      const created = createToolRun(name || t('chatUi.toolStageRunning'))
      toolRuns.push(created)
      syncToolRuns()
      return created
    }

    const cleanup = window.electronAPI.onLongTermGoalStreamEvent(streamId, (event) => {
      try {
        if (event.type === 'thinking' && event.content) {
          pendingThinkingText += event.content
          scheduleFlush()
        } else if (event.type === 'token' && event.content) {
          pendingContentText += event.content
          scheduleFlush()
        } else if (event.type === 'tool_start' && event.name) {
          flush()
          hadToolSinceLastThinking = true
          const toolRun = createToolRun(event.name)
          toolRuns.push(toolRun)
          ensureBlocks(message).push(createToolBlock(toolRun))
          syncToolRuns()
        } else if (event.type === 'tool_end') {
          flush()
          const toolRun = findLastRunningToolRun(toolRuns, event.name) || findLastRunningToolRun(toolRuns)
          if (toolRun) {
            toolRun.status = 'completed'
            toolRun.endedAt = Date.now()
            syncToolRuns()
          }
        } else if (event.type === 'progress' && event.stage) {
          flush()
          const toolRun = ensureActiveToolRun()
          toolRun.progress.push({ stage: event.stage, detail: event.detail })
          syncToolRuns()
        } else if (event.type === 'web_search_result' && event.query) {
          flush()
          ensureBlocks(message).push(createWebSearchBlock(event.query, event.engine || 'web', Array.isArray(event.results) ? event.results : []))
        } else if (event.type === 'web_fetch_result' && event.result) {
          flush()
          ensureBlocks(message).push(createWebFetchBlock(event.result as unknown as WebFetchResultEntry, event.query))
        } else if (event.type === 'done') {
          flush()
          closeOpenThinkingBlocks(message)
          for (const toolRun of toolRuns) {
            if (toolRun.status === 'running') {
              toolRun.status = 'completed'
              toolRun.endedAt = Date.now()
            }
          }
          syncToolRuns()
          // service 在 done 里转发了剥离 JSON 元数据后的最终正文，直接覆盖流式累积的原始文本。
          if (event.message?.content) {
            contentAccum = event.message.content
            message.content = contentAccum
            appendFinalContentBlock(message, event.message.content)
          }
        } else if (event.type === 'error') {
          flush()
          closeOpenThinkingBlocks(message)
          const toolRun = findLastRunningToolRun(toolRuns)
          if (toolRun) {
            toolRun.status = 'failed'
            toolRun.endedAt = Date.now()
            toolRun.progress.push({ stage: t('chatUi.toolStageError'), detail: event.error })
            syncToolRuns()
          }
          setAssistantErrorState(message, event.error || t('chatUi.streamFailedUnknown'), getMessageTextContent)
        }
      } catch (err) {
        flush()
        console.error('[longTermGoal] stream event failed:', event, err)
      }
    })

    try {
      const result = await invoke()
      cleanup()
      return result
    } catch (err) {
      cleanup()
      setAssistantErrorState(message, (err as Error).message, getMessageTextContent)
      return null
    }
  }

  async function compactLongTermGoalMemory (goalId: string): Promise<void> {
    if (!window.electronAPI?.compactLongTermGoalMemory) return
    const streamId = generateId()
    let terminalEventReceived = false
    memoryCompaction.value = {
      goalId,
      status: 'running',
      stage: t('chatUi.goalMemoryCompactionPreparing'),
      detail: t('chatUi.goalMemoryCompactingDetail'),
      percent: 8
    }
    const stageFloors: Record<string, number> = {
      '准备整理记忆': 12,
      'AI 分析记忆': 32,
      '生成整理结果': 72,
      '整理长期目标记忆': 76,
      '应用整理结果': 88,
      '无需整理': 100,
      '整理未应用': 100,
      '整理完成': 100
    }
    const updateRunningProgress = (stage?: string, detail?: string): void => {
      const current = memoryCompaction.value
      const currentPercent = current?.goalId === goalId ? current.percent : 8
      const nextPercent = Math.min(
        94,
        Math.max(stage ? stageFloors[stage] || 0 : 0, currentPercent + 12)
      )
      memoryCompaction.value = {
        goalId,
        status: 'running',
        stage: stage || current?.stage || t('chatUi.goalMemoryCompactionPreparing'),
        detail: detail || current?.detail || t('chatUi.goalMemoryCompactingDetail'),
        percent: nextPercent
      }
    }
    const finishProgress = (status: LongTermGoalMemoryCompactionProgress['status'], error?: string): void => {
      terminalEventReceived = true
      memoryCompaction.value = {
        goalId,
        status,
        stage: status === 'failed' ? t('chatUi.goalMemoryCompactionFailed') : t('chatUi.goalMemoryCompactionDone'),
        detail: error || (status === 'failed' ? t('chatUi.streamFailedUnknown') : t('chatUi.goalMemoryCompactionDoneDetail')),
        error,
        percent: 100
      }
    }
    const unsubscribe = window.electronAPI.onLongTermGoalStreamEvent?.(streamId, (event) => {
      if (event.type === 'progress') {
        updateRunningProgress(event.stage, event.detail)
      } else if (event.type === 'done') {
        finishProgress('completed')
      } else if (event.type === 'error') {
        finishProgress('failed', event.error || t('chatUi.streamFailedUnknown'))
      }
    })
    try {
      const snapshot = await window.electronAPI.compactLongTermGoalMemory(goalId, streamId)
      longTermGoalSnapshot.value = snapshot
      if (!terminalEventReceived) finishProgress('completed')
      await loadLongTermGoals()
      await loadLongTermGoalSnapshot(goalId)
    } catch (err) {
      finishProgress('failed', (err as Error).message)
      console.error('[longTermGoal] memory compaction failed:', err)
    } finally {
      unsubscribe?.()
      window.setTimeout(() => {
        const current = memoryCompaction.value
        if (current?.goalId === goalId && current.status === 'completed') {
          memoryCompaction.value = null
        }
      }, 900)
    }
  }

  async function deleteLongTermGoalMemory (goalId: string, memoryId: string): Promise<void> {
    if (!window.electronAPI?.deleteLongTermGoalMemory) return
    const snapshot = await window.electronAPI.deleteLongTermGoalMemory(goalId, memoryId)
    longTermGoalSnapshot.value = snapshot
    await loadLongTermGoals()
    await loadLongTermGoalSnapshot(goalId)
  }

  async function sendLongTermGoalMessage (goalId: string, content: string): Promise<void> {
    if (!window.electronAPI?.streamLongTermGoalMessage) return
    const streamId = generateId()
    const message: ChatMessage = {
      role: 'assistant',
      content: '',
      speakerName: 'Long-Term Goal',
      blocks: [createContentBlock('')]
    }
    streamingAdjust.value = { userContent: content, message }
    const result = await streamGoalConversation(message, streamId, () => window.electronAPI!.streamLongTermGoalMessage!(goalId, content, streamId))
    if (result) {
      longTermGoals.value = longTermGoals.value.map(item => item.id === result.goal.id ? mergeGoalTitleState(result.goal, item) : item)
    }
    streamingAdjust.value = null
    await loadLongTermGoalSnapshot(goalId)
  }

  async function applyLongTermGoalChangeSet (changeSetId: string): Promise<void> {
    if (!window.electronAPI?.applyLongTermGoalChangeSet) return
    const change = await window.electronAPI.applyLongTermGoalChangeSet(changeSetId)
    await loadLongTermGoals()
    await loadLongTermGoalSnapshot(change.goalId)
  }

  async function cancelLongTermGoalChangeSet (changeSetId: string): Promise<void> {
    if (!window.electronAPI?.cancelLongTermGoalChangeSet) return
    const change = await window.electronAPI.cancelLongTermGoalChangeSet(changeSetId)
    await loadLongTermGoalSnapshot(change.goalId)
  }

  async function applyLongTermGoalCreation (changeSetId: string): Promise<void> {
    if (!window.electronAPI?.applyLongTermGoalCreation) return
    const savedGoal = await window.electronAPI.applyLongTermGoalCreation(changeSetId)
    pendingCreationConfirm.value = null
    createConversationHistory.value = []
    await loadLongTermGoals()
    await openLongTermGoal(savedGoal.id)
  }

  async function cancelLongTermGoalCreation (changeSetId: string): Promise<void> {
    if (!window.electronAPI?.cancelLongTermGoalCreation) return
    await window.electronAPI.cancelLongTermGoalCreation(changeSetId)
    pendingCreationConfirm.value = null
    // Reset history to the intro so the user can start a fresh creation attempt.
    createConversationHistory.value = []
  }

  function resetLongTermGoalCreation (): void {
    pendingCreationConfirm.value = null
    createConversationHistory.value = []
  }

  async function answerLongTermGoalIntervention (goalId: string, interventionId: string, answers: Array<{ questionId: string; selectedOption: string | null; customAnswer: string | null }>): Promise<void> {
    if (!window.electronAPI?.answerLongTermGoalIntervention) return
    const streamId = generateId()
    const message: ChatMessage = {
      role: 'assistant',
      content: '',
      speakerName: 'Long-Term Goal',
      blocks: [createContentBlock('')]
    }
    streamingReplan.value = { goalId, message }

    let thinkingAccum = ''
    let contentAccum = ''
    let pendingThinking = ''
    let pendingContent = ''
    let flushTimer: number | null = null
    const flush = () => {
      if (flushTimer != null) { window.clearTimeout(flushTimer); flushTimer = null }
      if (pendingThinking) {
        thinkingAccum += pendingThinking
        message.thinking = thinkingAccum
        ensureThinkingBlock(message).text = thinkingAccum
        pendingThinking = ''
      }
      if (pendingContent) {
        contentAccum += pendingContent
        message.content = contentAccum
        const block = ensureStreamingContentBlock(message)
        const existing = typeof block.content === 'string' ? block.content : ''
        block.content = existing + pendingContent
        pendingContent = ''
      }
    }
    const scheduleFlush = () => {
      if (flushTimer != null) return
      flushTimer = window.setTimeout(flush, STREAM_RENDER_FLUSH_INTERVAL_MS)
    }
    const unsubscribe = window.electronAPI.onLongTermGoalStreamEvent?.(streamId, (event) => {
      if (event.type === 'thinking' && event.content) { pendingThinking += event.content; scheduleFlush() }
      else if (event.type === 'token' && event.content) { pendingContent += event.content; scheduleFlush() }
      else if (event.type === 'done') {
        flush()
        const finalContent = typeof event.message?.content === 'string' ? event.message.content : contentAccum
        if (finalContent) {
          message.content = finalContent
          ensureStreamingContentBlock(message).content = finalContent
        }
      }
    })

    try {
      const goal = await window.electronAPI.answerLongTermGoalIntervention(goalId, interventionId, answers, streamId)
      flush()
      longTermGoals.value = longTermGoals.value.map(item => item.id === goal.id ? mergeGoalTitleState(goal, item) : item)
      await loadLongTermGoalSnapshot(goalId)
    } finally {
      unsubscribe?.()
      streamingReplan.value = null
    }
  }

  return {
    answerLongTermGoalIntervention,
    applyLongTermGoalChangeSet,
    applyLongTermGoalCreation,
    archiveLongTermGoal,
    cancelLongTermGoalChangeSet,
    cancelLongTermGoalCreation,
    clearGoalAutoOpenRunId,
    compactLongTermGoalMemory,
    createConversationHistory,
    createLongTermGoal,
    deleteLongTermGoal,
    deleteLongTermGoalMemory,
    goalAutoOpenRunId,
    loadLongTermGoals,
    loadLongTermGoalSnapshot,
    memoryCompaction,
    mergeGoalTitleState,
    openLongTermGoal,
    pauseLongTermGoal,
    pendingCreationConfirm,
    resetLongTermGoalCreation,
    resumeLongTermGoal,
    runLongTermGoalNow,
    saveLongTermGoalPatch,
    sendLongTermGoalMessage,
    streamingAdjust,
    streamingCreate,
    streamingReplan,
    streamingRun
  }
}

