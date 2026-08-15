import assert from 'node:assert/strict'
import test from 'node:test'
import { GroupSession, GroupSessionRegistry } from '../electron/main-process/ai/group-session.ts'

function createSession (overrides = {}) {
  return new GroupSession({
    groupId: 'group-1',
    groupName: 'Group 1',
    coordinatorId: 'coordinator',
    participantIds: ['coordinator', 'member-a', 'member-b'],
    injectionRecipientIds: ['member-a', 'member-b'],
    round: 1,
    messageTimeoutMs: 50,
    runPeerReply: async ({ request }) => `reply:${request}`,
    ...overrides
  })
}

test('broadcast injections are delivered once to every recipient', () => {
  const session = createSession()
  const injection = session.inject({ content: 'clarify this' })

  assert.equal(session.hasPendingInjections(), true)
  assert.deepEqual(session.drainInjections('member-a').map(item => item.id), [injection.id])
  assert.deepEqual(session.drainInjections('member-a'), [])
  assert.equal(session.hasPendingInjections(), true)
  assert.deepEqual(session.drainInjections('member-b').map(item => item.id), [injection.id])
  assert.equal(session.hasPendingInjections(), false)
})

test('targeted injections remain available until the target turn finishes', () => {
  const session = createSession()
  const injection = session.inject({ content: 'only b', targetAgentIds: ['member-b'] })

  assert.deepEqual(session.drainInjections('member-a'), [])
  assert.deepEqual(session.drainInjections('member-b').map(item => item.id), [injection.id])
  assert.equal(session.hasPendingInjections(), false)

  const followUp = session.inject({ content: 'still in progress', targetAgentIds: ['member-b'] })
  assert.deepEqual(session.drainInjections('member-b').map(item => item.id), [followUp.id])

  session.finishInjectionTurn('member-b')
  assert.throws(
    () => session.inject({ content: 'too late', targetAgentIds: ['member-b'] }),
    /has no pending turn/
  )
})

test('recipient changes preserve already queued broadcast recipients', () => {
  const session = createSession()
  const injection = session.inject({ content: 'before planning' })
  session.setInjectionRecipients(['member-a'])

  assert.deepEqual(session.drainInjections('member-a').map(item => item.id), [injection.id])
  assert.equal(session.hasPendingInjections(), true)
  assert.deepEqual(session.drainInjections('member-b').map(item => item.id), [injection.id])
  assert.equal(session.hasPendingInjections(), false)
})

test('injection listeners wake running members without consuming their rerun queue', () => {
  const session = createSession()
  const notifications = []
  session.onInjection('member-a', injection => notifications.push(injection))

  const injection = session.inject({ content: 'new context', targetAgentIds: ['member-a'] })

  assert.deepEqual(notifications.map(item => item.id), [injection.id])
  assert.deepEqual(session.getInjections().map(item => item.id), [injection.id])
  assert.deepEqual(session.drainInjections('member-a').map(item => item.id), [injection.id])
  assert.equal(session.hasPendingInjections(), false)
})

test('unsubscribed injection listeners stop receiving notifications without consuming the queue', () => {
  const session = createSession()
  const notifications = []
  const unsubscribe = session.onInjection('member-a', injection => notifications.push(injection))
  unsubscribe()

  const injection = session.inject({ content: 'after unsubscribe', targetAgentIds: ['member-a'] })

  assert.deepEqual(notifications, [])
  assert.deepEqual(session.drainInjections('member-a').map(item => item.id), [injection.id])
})

test('peer message completion updates both participants history', async () => {
  const session = createSession()
  const response = await session.sendMessage({
    fromAgentId: 'member-a',
    fromAgentName: 'Member A',
    toAgentId: 'member-b',
    toAgentName: 'Member B',
    request: 'question'
  })

  assert.equal(response, 'reply:question')
  for (const agentId of ['member-a', 'member-b']) {
    assert.deepEqual(session.getPeerMessages(agentId).map(message => ({
      status: message.status,
      response: message.response
    })), [{ status: 'completed', response: 'reply:question' }])
  }
})

test('peer message failures and timeouts update both participants history', async (t) => {
  await t.test('failure', async () => {
    const session = createSession({
      runPeerReply: async () => { throw new Error('peer failed') }
    })
    await assert.rejects(session.sendMessage({
      fromAgentId: 'member-a',
      fromAgentName: 'Member A',
      toAgentId: 'member-b',
      toAgentName: 'Member B',
      request: 'question'
    }), /peer failed/)

    for (const agentId of ['member-a', 'member-b']) {
      assert.equal(session.getPeerMessages(agentId)[0].status, 'failed')
      assert.match(session.getPeerMessages(agentId)[0].error, /peer failed/)
    }
  })

  await t.test('timeout', async () => {
    const keepAlive = setTimeout(() => {}, 100)
    let targetSignal
    const session = createSession({
      messageTimeoutMs: 10,
      runPeerReply: async ({ abortSignal }) => {
        targetSignal = abortSignal
        return await new Promise(() => {})
      }
    })
    try {
      await assert.rejects(session.sendMessage({
        fromAgentId: 'member-a',
        fromAgentName: 'Member A',
        toAgentId: 'member-b',
        toAgentName: 'Member B',
        request: 'question'
      }), /timed out/)

      assert.equal(targetSignal.aborted, true)
      for (const agentId of ['member-a', 'member-b']) {
        assert.equal(session.getPeerMessages(agentId)[0].status, 'timeout')
      }
    } finally {
      clearTimeout(keepAlive)
    }
  })
})

test('parent abort stops a pending peer request and records failure', async () => {
  const controller = new AbortController()
  const session = createSession({
    abortSignal: controller.signal,
    runPeerReply: async () => await new Promise(() => {})
  })
  const pending = session.sendMessage({
    fromAgentId: 'member-a',
    fromAgentName: 'Member A',
    toAgentId: 'member-b',
    toAgentName: 'Member B',
    request: 'question'
  })
  controller.abort(new Error('stopped'))

  await assert.rejects(pending, /stopped/)
  for (const agentId of ['member-a', 'member-b']) {
    assert.equal(session.getPeerMessages(agentId)[0].status, 'failed')
  }
})

test('registry isolates concurrent streams using the same group', () => {
  const registry = new GroupSessionRegistry()
  const first = createSession()
  const second = createSession()

  registry.register('stream-1', first)
  registry.register('stream-2', second)
  assert.equal(registry.get('stream-1'), first)
  assert.equal(registry.get('stream-2'), second)
  assert.equal(registry.release('stream-1', second), false)
  assert.equal(registry.get('stream-1'), first)
  assert.equal(registry.release('stream-1', first), true)
  assert.equal(registry.get('stream-1'), undefined)
  assert.equal(registry.get('stream-2'), second)
})

test('registry conditional release cannot delete a replacement session for the same stream', () => {
  const registry = new GroupSessionRegistry()
  const first = createSession()
  const replacement = createSession()

  registry.register('stream-1', first)
  registry.register('stream-1', replacement)

  assert.equal(registry.release('stream-1', first), false)
  assert.equal(registry.get('stream-1'), replacement)
  assert.equal(registry.release('stream-1', replacement), true)
  assert.equal(registry.get('stream-1'), undefined)
})

test('shared board field-level updates merge idempotently and audit', () => {
  const session = createSession()
  session.updateBoard({ agentId: 'member-a', agentName: 'A', field: 'goal', op: 'set', payload: 'ship feature X' })
  assert.equal(session.readBoard().goal, 'ship feature X')

  // add is idempotent across writers
  session.updateBoard({ agentId: 'member-a', agentName: 'A', field: 'assumptions', op: 'add', payload: 'api is stable' })
  session.updateBoard({ agentId: 'member-b', agentName: 'B', field: 'assumptions', op: 'add', payload: 'api is stable' })
  assert.deepEqual(session.readBoard().assumptions, ['api is stable'])

  // add + remove a different value
  session.updateBoard({ agentId: 'member-b', agentName: 'B', field: 'assumptions', op: 'add', payload: 'budget ok' })
  session.updateBoard({ agentId: 'member-a', agentName: 'A', field: 'assumptions', op: 'remove', payload: 'budget ok' })
  assert.deepEqual(session.readBoard().assumptions, ['api is stable'])

  // set replaces the whole list
  session.updateBoard({ agentId: 'member-a', agentName: 'A', field: 'assumptions', op: 'set', payload: ['a', 'b'] })
  assert.deepEqual(session.readBoard().assumptions, ['a', 'b'])

  // tasks: add (dedup by id) -> update (merge by id) -> remove (by id)
  session.updateBoard({ agentId: 'member-a', agentName: 'A', field: 'tasks', op: 'add', payload: { id: 't1', title: 'design', status: 'todo' } })
  session.updateBoard({ agentId: 'member-b', agentName: 'B', field: 'tasks', op: 'add', payload: { id: 't1', title: 'design', status: 'todo' } })
  assert.equal(session.readBoard().tasks.length, 1)
  session.updateBoard({ agentId: 'member-b', agentName: 'B', field: 'tasks', op: 'update', payload: { id: 't1', status: 'running', summary: 'started' } })
  assert.equal(session.readBoard().tasks[0].status, 'running')
  assert.equal(session.readBoard().tasks[0].title, 'design')
  session.updateBoard({ agentId: 'member-a', agentName: 'A', field: 'tasks', op: 'remove', payload: 't1' })
  assert.equal(session.readBoard().tasks.length, 0)

  // every update was audited
  assert.ok(session.snapshot().recentUpdates.length >= 8)
})

test('peer messaging rejects a deadlock cycle (A -> B -> A)', async () => {
  let session
  session = createSession({
    runPeerReply: async ({ targetAgentId }) => {
      // Member B, upon receiving A's request, tries to consult A -> must deadlock.
      if (targetAgentId === 'member-b') {
        return await session.sendMessage({
          fromAgentId: 'member-b',
          fromAgentName: 'Member B',
          toAgentId: 'member-a',
          toAgentName: 'Member A',
          request: 'reverse question'
        })
      }
      return 'ok'
    }
  })
  await assert.rejects(session.sendMessage({
    fromAgentId: 'member-a',
    fromAgentName: 'Member A',
    toAgentId: 'member-b',
    toAgentName: 'Member B',
    request: 'question'
  }), /deadlock/)
})

test('per-member tool budget gates calls and resets each round', () => {
  const session = createSession({ perMemberToolBudget: 2 })
  assert.equal(session.consumeToolBudget('member-a').allowed, true)
  assert.equal(session.consumeToolBudget('member-a').allowed, true)
  const over = session.consumeToolBudget('member-a')
  assert.equal(over.allowed, false)
  assert.equal(over.remaining, 0)
  // budgets are independent per member
  assert.equal(session.consumeToolBudget('member-b').allowed, true)
  // a new round resets the counter
  session.setRound(2)
  assert.equal(session.consumeToolBudget('member-a').allowed, true)
})
