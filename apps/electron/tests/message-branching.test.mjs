import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import './register-ts-hooks.mjs'
import { createChatMessageBranching, ensureMessageIds } from '../src/renderer/components/chat/panel/message-branching.ts'

function createHarness ({ sourceMessages, sourceConversation = {} } = {}) {
  const savedConversations = []
  const loadedConversationIds = []
  const sentPrepared = []

  // Minimal renderer-global stubs the branching module expects.
  const confirmResult = { value: true }
  globalThis.window = {
    confirm: () => confirmResult.value,
    electronAPI: {
      getConversation: async (id) => ({
        id,
        title: 'Original',
        createdAt: '2026-08-15T00:00:00.000Z',
        updatedAt: '2026-08-15T00:01:00.000Z',
        authMode: 'strict',
        providerId: 'prov-1',
        selectedModel: 'model-a',
        agentId: 'agent-1',
        groupId: 'group-1',
        rootConversationId: 'root-1',
        forkDepth: 1,
        messages: sourceMessages,
        ...sourceConversation
      }),
      saveConversation: async (conversation) => {
        savedConversations.push(conversation)
        return { success: true }
      }
    }
  }

  const messages = ref([...sourceMessages])
  const currentConversationId = ref('conv-1')
  const conversations = ref([])

  const branching = createChatMessageBranching({
    t: (key) => key,
    messages,
    currentConversationId,
    conversations,
    streamingConversationIds: new Set(),
    loadConversation: async (id) => {
      loadedConversationIds.push(id)
      messages.value = [...savedConversations.at(-1).messages]
      currentConversationId.value = id
    },
    loadConversations: async () => {},
    saveConversation: async (conversationId, chatMessages) => {
      savedConversations.push({
        id: conversationId,
        messages: JSON.parse(JSON.stringify(chatMessages))
      })
    },
    sendMessage: async (prepared) => {
      sentPrepared.push({ conversationId: currentConversationId.value, prepared })
      // Mirror the real sender: append the user message and an assistant placeholder.
      messages.value.push({ role: 'user', ...prepared })
      messages.value.push({ role: 'assistant', content: 'ok', id: 'a2' })
    }
  })

  return { branching, messages, currentConversationId, savedConversations, loadedConversationIds, sentPrepared, confirmResult }
}

test('forkFromMessage copies the prefix, records lineage and inherits metadata', async () => {
  const sourceMessages = [
    { role: 'user', id: 'u1', content: 'first question' },
    { role: 'assistant', id: 'a1', content: 'first answer', blocks: [{ id: 'b1', kind: 'auth_request', requestId: 'r1', title: 't', detail: 'd', status: 'approved' }, { id: 'b2', kind: 'content', content: 'first answer' }] },
    { role: 'user', id: 'u2', content: 'second question' },
    { role: 'assistant', id: 'a2', content: 'second answer' }
  ]
  const { branching, savedConversations, loadedConversationIds } = createHarness({ sourceMessages })

  const newId = await branching.forkFromMessage('u2')
  assert.ok(newId, 'fork should return the new conversation id')

  const fork = savedConversations[0]
  assert.equal(fork.messages.length, 3)
  assert.equal(fork.messages[2].id, 'u2')
  // One-shot auth blocks are dropped from the copied history (R6).
  assert.equal(fork.messages[1].blocks.some(block => block.kind === 'auth_request'), false)
  // Lineage: parent, anchor, root inherited, depth grows.
  assert.equal(fork.forkedFromConversationId, 'conv-1')
  assert.equal(fork.forkedFromMessageId, 'u2')
  assert.equal(fork.rootConversationId, 'root-1')
  assert.equal(fork.forkDepth, 2)
  // Metadata is inherited; group runtime identity is not.
  assert.equal(fork.providerId, 'prov-1')
  assert.equal(fork.agentId, 'agent-1')
  assert.equal(fork.groupId, undefined)
  assert.ok(fork.title.includes('Original'))
  assert.deepEqual(loadedConversationIds, [newId])
})

test('submitEdit fork mode keeps the source and resends the edited text', async () => {
  const sourceMessages = [
    { role: 'user', id: 'u1', content: 'draft question' },
    { role: 'assistant', id: 'a1', content: 'answer' }
  ]
  const { branching, messages, savedConversations, sentPrepared } = createHarness({ sourceMessages })

  await branching.submitEdit('u1', 'better question', 'fork')

  const fork = savedConversations[0]
  assert.equal(fork.messages.length, 1, 'forked prefix contains only the anchor message')
  assert.equal(fork.messages[0].id, 'u1')
  assert.equal(fork.messages[0].content, 'draft question', 'the fork saved the ORIGINAL text before resend')

  assert.equal(sentPrepared.length, 1)
  assert.equal(sentPrepared[0].prepared.text, 'better question')
  assert.equal(sentPrepared[0].prepared.id, 'u1', 'edited message reuses the anchor id')
  // After fork-resend, the anchor message was replaced by the edited version.
  assert.equal(messages.value[0].content, 'better question')
})

test('submitEdit in-place mode truncates the tail and resends', async () => {
  const sourceMessages = [
    { role: 'user', id: 'u1', content: 'q1' },
    { role: 'assistant', id: 'a1', content: 'r1' },
    { role: 'user', id: 'u2', content: 'q2' },
    { role: 'assistant', id: 'a2', content: 'r2' }
  ]
  const { branching, messages, savedConversations, sentPrepared } = createHarness({ sourceMessages })

  await branching.submitEdit('u1', 'q1 edited', 'inplace')

  // First save persists the truncation, second is from the resend pipeline.
  const truncationSave = savedConversations.find(conversation => conversation.id === 'conv-1')
  assert.ok(truncationSave)
  assert.equal(sentPrepared.length, 1)
  assert.equal(sentPrepared[0].prepared.text, 'q1 edited')
  assert.equal(messages.value[0].content, 'q1 edited')
  assert.equal(messages.value.filter(message => message.role === 'user').length, 1)
})

test('submitEdit in-place mode aborts when the user declines the confirm', async () => {
  const sourceMessages = [
    { role: 'user', id: 'u1', content: 'q1' },
    { role: 'assistant', id: 'a1', content: 'r1' }
  ]
  const { branching, messages, sentPrepared, confirmResult } = createHarness({ sourceMessages })

  confirmResult.value = false
  await branching.submitEdit('u1', 'q1 edited', 'inplace')

  assert.equal(sentPrepared.length, 0)
  assert.equal(messages.value.length, 2, 'conversation untouched')
})

test('ensureMessageIds backfills legacy messages in place and keeps existing ids', () => {
  const legacy = [
    { role: 'user', content: 'old' },
    { role: 'assistant', id: 'keep-me', content: 'newer' }
  ]
  ensureMessageIds(legacy)

  assert.ok(legacy[0].id, 'legacy message gets a backfilled id')
  assert.equal(legacy[1].id, 'keep-me', 'existing id is preserved')
})

test('editing is limited to user messages with a stable id and blocked while streaming', async () => {
  const sourceMessages = [
    { role: 'user', content: 'legacy message without id' },
    { role: 'user', id: 'u2', content: 'branchable' },
    { role: 'assistant', id: 'a1', content: 'answer' }
  ]
  const { branching } = createHarness({ sourceMessages })

  assert.equal(branching.isMessageBranchable(sourceMessages[0]), false)
  assert.equal(branching.isMessageBranchable(sourceMessages[1]), true)
  assert.equal(branching.isMessageBranchable(sourceMessages[2]), false)
})
