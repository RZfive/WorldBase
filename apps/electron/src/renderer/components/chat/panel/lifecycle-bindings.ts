import type { Ref } from 'vue'
import { onAuthResolution, type AuthResolutionPayload } from '../../../utils/auth-events'
import type {
  LongTermGoalDefinition,
  LongTermGoalRun,
  LongTermGoalSnapshot
} from '../../../../shared/long-term-goal-types.js'
import {
  cleanupSharedChatPanelResources,
  sharedChatPanelLifecycle
} from './shared-state'
import type {
  AskUserRequestPayload,
  AuthRequestPayload,
  ProvidersConfig,
  SudoPasswordRequestPayload
} from './types'

interface ChatLifecycleBindingsOptions {
  activeProviderId: Ref<string>
  selectedModel: Ref<string>
  longTermGoals: Ref<LongTermGoalDefinition[]>
  longTermGoalSnapshot: Ref<LongTermGoalSnapshot | null>
  selectedLongTermGoalId: Ref<string | null>
  streamingRun: Ref<{ goalId: string; run: LongTermGoalRun } | null>
  applyProvidersConfig: (config: ProvidersConfig, preferredProviderId?: string | null, preferredModelId?: string | null) => Promise<void>
  handleAuthRequest: (request: AuthRequestPayload) => void
  handleSudoPasswordRequest: (request: SudoPasswordRequestPayload) => void
  handleAskUserRequest: (request: AskUserRequestPayload) => void
  handleAuthResolution: (payload: AuthResolutionPayload) => void
  loadSkills: () => Promise<void>
  loadAgentWorkspaceOptions: () => Promise<void>
  loadLongTermGoals: () => Promise<void>
  loadLongTermGoalSnapshot: (goalId?: string | null) => Promise<void>
  mergeGoalTitleState: (incomingGoal: LongTermGoalDefinition, existingGoal?: LongTermGoalDefinition) => LongTermGoalDefinition
}

export function ensureSharedChatPanelLifecycleBindings (options: ChatLifecycleBindingsOptions): void {
  const lifecycle = sharedChatPanelLifecycle
  if (lifecycle.bindingsReady) return

  const {
    activeProviderId,
    selectedModel,
    longTermGoals,
    longTermGoalSnapshot,
    selectedLongTermGoalId,
    streamingRun,
    applyProvidersConfig,
    handleAuthRequest,
    handleSudoPasswordRequest,
    handleAskUserRequest,
    handleAuthResolution,
    loadSkills,
    loadAgentWorkspaceOptions,
    loadLongTermGoals,
    loadLongTermGoalSnapshot,
    mergeGoalTitleState
  } = options

  lifecycle.bindingsReady = true
  try {
    if (window.electronAPI?.onProvidersChanged) {
      lifecycle.providerChangeCleanup = window.electronAPI.onProvidersChanged((config) => {
        void applyProvidersConfig(config, activeProviderId.value, selectedModel.value)
      })
    }

    if (window.electronAPI?.onAuthRequest) {
      lifecycle.authRequestCleanup = window.electronAPI.onAuthRequest(handleAuthRequest)
    }
    if (window.electronAPI?.onSudoPasswordRequest) {
      lifecycle.sudoPasswordRequestCleanup = window.electronAPI.onSudoPasswordRequest(handleSudoPasswordRequest)
    }
    if (window.electronAPI?.onAskUserRequest) {
      lifecycle.askUserRequestCleanup = window.electronAPI.onAskUserRequest(handleAskUserRequest)
    }
    if (window.electronAPI?.onAuthResolved) {
      lifecycle.authResolvedCleanup = window.electronAPI.onAuthResolved(handleAuthResolution)
    }

    if (window.electronAPI?.onSkillsChanged) {
      lifecycle.skillsChangedCleanup = window.electronAPI.onSkillsChanged(() => {
        void loadSkills()
      })
    }
    if (window.electronAPI?.onAgentWorkspaceChanged) {
      lifecycle.agentWorkspaceChangeCleanup = window.electronAPI.onAgentWorkspaceChanged(() => {
        void loadAgentWorkspaceOptions()
      })
    }

    if (window.electronAPI?.onLongTermGoalsChanged) {
      lifecycle.longTermGoalsCleanup = window.electronAPI.onLongTermGoalsChanged((goals) => {
        const existingGoalMap = new Map(longTermGoals.value.map(goal => [goal.id, goal]))
        longTermGoals.value = goals.map(goal => mergeGoalTitleState(goal, existingGoalMap.get(goal.id)))
      })
    }

    if (window.electronAPI?.onLongTermGoalSnapshotChanged) {
      lifecycle.longTermGoalSnapshotCleanup = window.electronAPI.onLongTermGoalSnapshotChanged((snapshot) => {
        if (selectedLongTermGoalId.value && !snapshot.goals.some(goal => goal.id === selectedLongTermGoalId.value)) return

        if (snapshot.goals.length > 0) {
          const snapshotGoalMap = new Map(snapshot.goals.map(goal => [goal.id, goal]))
          longTermGoals.value = longTermGoals.value.map((goal) => {
            const incomingGoal = snapshotGoalMap.get(goal.id)
            return incomingGoal ? mergeGoalTitleState(incomingGoal, goal) : goal
          })
          for (const goal of snapshot.goals) {
            if (!longTermGoals.value.some(item => item.id === goal.id)) {
              longTermGoals.value = [mergeGoalTitleState(goal), ...longTermGoals.value]
            }
          }
        }

        longTermGoalSnapshot.value = selectedLongTermGoalId.value
          ? {
              ...snapshot,
              goals: snapshot.goals.filter(goal => goal.id === selectedLongTermGoalId.value),
              runs: snapshot.runs.filter(run => run.goalId === selectedLongTermGoalId.value),
              reviews: snapshot.reviews.filter(review => review.goalId === selectedLongTermGoalId.value),
              activities: snapshot.activities.filter(activity => activity.goalId === selectedLongTermGoalId.value),
              memories: snapshot.memories.filter(memory => memory.goalId === selectedLongTermGoalId.value),
              conversations: snapshot.conversations.filter(turn => turn.goalId === selectedLongTermGoalId.value),
              changeSets: snapshot.changeSets.filter(change => change.goalId === selectedLongTermGoalId.value)
            }
          : snapshot
      })
    }

    if (window.electronAPI?.onLongTermGoalInterventionRequested) {
      lifecycle.longTermGoalInterventionCleanup = window.electronAPI.onLongTermGoalInterventionRequested((intervention) => {
        if (selectedLongTermGoalId.value === intervention.goalId) {
          void loadLongTermGoalSnapshot(intervention.goalId)
        }
        void loadLongTermGoals()
      })
    }

    if (window.electronAPI?.onLongTermGoalRunProgress) {
      lifecycle.longTermGoalRunProgressCleanup = window.electronAPI.onLongTermGoalRunProgress(({ goalId, run }) => {
        if (selectedLongTermGoalId.value !== goalId) return
        streamingRun.value = { goalId, run }
        if (run.status === 'completed' || run.status === 'failed') {
          void loadLongTermGoalSnapshot(goalId).then(() => {
            streamingRun.value = null
          })
        }
      })
    }

    lifecycle.authResponseCleanup = onAuthResolution(handleAuthResolution)

    if (!lifecycle.beforeUnloadCleanupRegistered) {
      window.addEventListener('beforeunload', cleanupSharedChatPanelResources)
      lifecycle.beforeUnloadCleanupRegistered = true
    }
  } catch (error) {
    lifecycle.bindingsReady = false
    throw error
  }
}
