import { computed, type Ref } from 'vue'
import { emitAuthResolution, type AuthResolutionPayload } from '../../../utils/auth-events'
import type {
  AskUserAnswerPayload,
  AskUserRequestPayload,
  AuthRequestPayload,
  BackgroundStreamState,
  ChatMessage,
  ChatMessageBlock,
  SudoPasswordRequestPayload
} from './types'

interface ChatAuthorizationStateOptions {
  currentConversationId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  activeStreamSessionIds: Map<string, string>
  backgroundStreamMessages: Map<string, BackgroundStreamState>
  pendingAuthRequestsByConversation: Map<string, AuthRequestPayload[]>
  pendingSudoPasswordRequestsByConversation: Map<string, SudoPasswordRequestPayload[]>
  pendingAskUserRequestsByConversation: Map<string, AskUserRequestPayload[]>
  unreadConversationIds: Set<string>
}

export function createChatAuthorizationState (options: ChatAuthorizationStateOptions) {
  const {
    currentConversationId,
    messages,
    activeStreamSessionIds,
    backgroundStreamMessages,
    pendingAuthRequestsByConversation,
    pendingSudoPasswordRequestsByConversation,
    pendingAskUserRequestsByConversation,
    unreadConversationIds
  } = options

  function resolveConversationId (request: { conversationId?: string; sessionId?: string }): string | null {
    if (request.conversationId) return request.conversationId
    if (!request.sessionId) return null

    for (const [conversationId, activeSessionId] of activeStreamSessionIds.entries()) {
      if (activeSessionId === request.sessionId) return conversationId
    }
    return null
  }

  function getPendingAuthRequests (conversationId?: string | null): AuthRequestPayload[] {
    return conversationId ? pendingAuthRequestsByConversation.get(conversationId) ?? [] : []
  }

  function getPendingAuthCount (conversationId?: string | null): number {
    return getPendingAuthRequests(conversationId).length
  }

  const currentPendingAuthCount = computed(() => getPendingAuthCount(currentConversationId.value))
  const currentPendingAuthRequest = computed<AuthRequestPayload | null>(() => {
    const list = getPendingAuthRequests(currentConversationId.value)
    return list[0] || null
  })

  function trackPendingAuthRequest (request: AuthRequestPayload): AuthRequestPayload | null {
    const conversationId = resolveConversationId(request)
    if (!conversationId) return null

    const normalizedRequest = { ...request, conversationId }
    const currentRequests = getPendingAuthRequests(conversationId)
    if (!currentRequests.some(item => item.requestId === normalizedRequest.requestId)) {
      pendingAuthRequestsByConversation.set(conversationId, [...currentRequests, normalizedRequest])
    }
    return normalizedRequest
  }

  function clearPendingAuthRequest (requestId: string): void {
    removeQueuedRequest(pendingAuthRequestsByConversation, requestId)
  }

  function getPendingSudoPasswordRequests (conversationId?: string | null): SudoPasswordRequestPayload[] {
    return conversationId ? pendingSudoPasswordRequestsByConversation.get(conversationId) ?? [] : []
  }

  const currentPendingSudoPasswordCount = computed(() => {
    return getPendingSudoPasswordRequests(currentConversationId.value).length
  })
  const currentSudoPasswordRequest = computed<SudoPasswordRequestPayload | null>(() => {
    const list = getPendingSudoPasswordRequests(currentConversationId.value)
    return list[0] || null
  })

  function trackPendingSudoPasswordRequest (request: SudoPasswordRequestPayload): SudoPasswordRequestPayload | null {
    const conversationId = resolveConversationId(request)
    if (!conversationId) return null

    const normalizedRequest = { ...request, conversationId }
    const currentRequests = getPendingSudoPasswordRequests(conversationId)
    if (!currentRequests.some(item => item.requestId === normalizedRequest.requestId)) {
      pendingSudoPasswordRequestsByConversation.set(conversationId, [...currentRequests, normalizedRequest])
    }
    return normalizedRequest
  }

  function getPendingAskUserRequests (conversationId?: string | null): AskUserRequestPayload[] {
    return conversationId ? pendingAskUserRequestsByConversation.get(conversationId) ?? [] : []
  }

  const currentAskUserRequest = computed<AskUserRequestPayload | null>(() => {
    const list = getPendingAskUserRequests(currentConversationId.value)
    return list[0] || null
  })

  function removeQueuedRequest<T extends { requestId: string }> (requestsByConversation: Map<string, T[]>, requestId: string): void {
    for (const [conversationId, requests] of requestsByConversation.entries()) {
      const nextRequests = requests.filter(item => item.requestId !== requestId)
      if (nextRequests.length === requests.length) continue

      if (nextRequests.length > 0) {
        requestsByConversation.set(conversationId, nextRequests)
      } else {
        requestsByConversation.delete(conversationId)
      }
      return
    }
  }

  function getTrackedMessageCollections (): ChatMessage[][] {
    const collections = [messages.value]
    for (const state of backgroundStreamMessages.values()) {
      if (!collections.includes(state.messages)) collections.push(state.messages)
    }
    return collections
  }

  function handleAuthRequest (request: AuthRequestPayload): void {
    if (!trackPendingAuthRequest(request)) {
      console.warn('[chat] Ignoring auth request that could not be routed to a conversation', request)
    }
  }

  function applyAuthResolution (requestId: string, approved: boolean): void {
    clearPendingAuthRequest(requestId)
    for (const chatMessages of getTrackedMessageCollections()) {
      for (const message of chatMessages) {
        if (!Array.isArray(message.blocks)) continue
        const block = message.blocks.find((item): item is Extract<ChatMessageBlock, { kind: 'auth_request' }> => {
          return item.kind === 'auth_request' && item.requestId === requestId
        })
        if (!block) continue
        block.status = approved ? 'approved' : 'denied'
        return
      }
    }
  }

  function handleAuthResolution (payload: AuthResolutionPayload): void {
    applyAuthResolution(payload.requestId, payload.approved)
  }

  function respondToAuthRequest (requestId: string, approved: boolean): void {
    emitAuthResolution({ requestId, approved })
    window.electronAPI?.respondAuth(requestId, approved)
  }

  function handleSudoPasswordRequest (request: SudoPasswordRequestPayload): void {
    if (!trackPendingSudoPasswordRequest(request)) {
      window.electronAPI?.respondSudoPassword(request.requestId, null)
    }
  }

  function respondToSudoPasswordRequest (requestId: string, password: string | null): void {
    removeQueuedRequest(pendingSudoPasswordRequestsByConversation, requestId)
    window.electronAPI?.respondSudoPassword(requestId, password)
  }

  function resolveAskUserConversationId (request: AskUserRequestPayload): string | null {
    return resolveConversationId(request) || currentConversationId.value || null
  }

  function handleAskUserRequest (request: AskUserRequestPayload): void {
    const conversationId = resolveAskUserConversationId(request)
    if (!conversationId) {
      window.electronAPI?.respondAskUser(request.requestId, null)
      return
    }

    const normalizedRequest = { ...request, conversationId }
    const currentRequests = getPendingAskUserRequests(conversationId)
    if (!currentRequests.some(item => item.requestId === normalizedRequest.requestId)) {
      pendingAskUserRequestsByConversation.set(conversationId, [...currentRequests, normalizedRequest])
    }
    if (currentConversationId.value !== conversationId) unreadConversationIds.add(conversationId)
  }

  function respondToAskUserRequest (requestId: string, answers: AskUserAnswerPayload[] | null): void {
    removeQueuedRequest(pendingAskUserRequestsByConversation, requestId)
    window.electronAPI?.respondAskUser(requestId, answers)
  }

  return {
    currentAskUserRequest,
    currentPendingAuthCount,
    currentPendingAuthRequest,
    currentPendingSudoPasswordCount,
    currentSudoPasswordRequest,
    getPendingAuthCount,
    handleAskUserRequest,
    handleAuthRequest,
    handleAuthResolution,
    handleSudoPasswordRequest,
    respondToAskUserRequest,
    respondToAuthRequest,
    respondToSudoPasswordRequest
  }
}
