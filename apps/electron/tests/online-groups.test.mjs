import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { OnlineGroupService } from '../src/main/online-groups/online-group-service.ts'
import { onlineGroupsRouter } from '../src/main/lan-server/routes/online-groups.ts'
import { mapOnlineMessages } from '../src/renderer/components/chat/panel/online-group-chat.ts'
import { mergeAgentGroupCatalog, onlineGroupConversationId } from '../src/renderer/components/chat/panel/online-group-catalog.ts'

function listen (server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function reservePort () {
  const probe = net.createServer()
  await listen(probe, 0)
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}

function request (port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'undefined' ? undefined : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function agent (id, name) {
  return {
    id,
    name,
    icon: '🤖',
    description: `${name} description`,
    systemPrompt: 'Help the group.',
    skillIds: [],
    memoryScopes: [],
    memoryWritePolicy: {
      allowUserTraits: true,
      allowAgentSkills: true,
      allowSteps: true,
      allowKnowledge: true
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

async function waitFor (predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for online-group state')
}

test('LAN online groups support invites, chat, files, and owner-approved agent delegation', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldbase-online-groups-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const portA = await reservePort()
  const portB = await reservePort()
  const agents = {
    agent_b: agent('agent_b', 'Analyst B')
  }
  const executed = []

  const serviceA = new OnlineGroupService({
    userDataPath: path.join(root, 'a'),
    port: portA,
    baseUrl: `http://127.0.0.1:${portA}`,
    resolveHarness: async () => null,
    getAgent: id => agents[id] || null
  })
  const serviceB = new OnlineGroupService({
    userDataPath: path.join(root, 'b'),
    port: portB,
    baseUrl: `http://127.0.0.1:${portB}`,
    resolveHarness: async () => null,
    getAgent: id => agents[id] || null
  })
  serviceB.setAgentExecutor(async input => {
    executed.push(input)
    return `Agent ${input.agentId} completed: ${input.task}`
  })

  const appA = express()
  appA.use(express.json({ limit: '12mb' }))
  appA.use('/api/online-groups', onlineGroupsRouter(serviceA))
  const appB = express()
  appB.use(express.json({ limit: '12mb' }))
  appB.use('/api/online-groups', onlineGroupsRouter(serviceB))

  const serverA = http.createServer(appA)
  const serverB = http.createServer(appB)
  await listen(serverA, portA)
  await listen(serverB, portB)
  context.after(async () => {
    serviceA.stop()
    serviceB.stop()
    await new Promise(resolve => serverA.close(resolve))
    await new Promise(resolve => serverB.close(resolve))
  })

  await serviceA.saveIdentity({
    displayName: 'Mac A',
    role: '产品',
    avatar: '🧑‍🚀',
    background: 'aurora',
    tags: ['产品', 'AI'],
    discoveryEnabled: false
  })
  await serviceB.saveIdentity({
    displayName: 'Mac B',
    role: '研发',
    avatar: '👩‍💻',
    background: 'ocean',
    tags: ['研发'],
    discoveryEnabled: false
  })

  const created = await serviceA.createGroup({
    name: 'Lan product room',
    icon: '🧪',
    description: 'Cross-device collaboration',
    role: '产品'
  })
  const groupRecord = JSON.parse(fs.readFileSync(
    path.join(root, 'a', 'online-groups', 'groups', `${created.id}.json`),
    'utf8'
  ))

  const invite = await request(portB, 'POST', '/api/online-groups/invitations', {
    invitationId: 'invite-1',
    groupId: created.id,
    groupName: created.name,
    groupIcon: created.icon,
    groupDescription: created.description,
    inviterPeerId: serviceA.getIdentity().instanceId,
    inviterName: 'Mac A',
    inviterRole: '产品',
    inviterAvatar: '🧑‍🚀',
    inviterBackground: 'aurora',
    inviterTags: ['产品', 'AI'],
    role: '研发',
    inviteToken: groupRecord.inviteToken,
    baseUrl: `http://127.0.0.1:${portA}`,
    createdAt: new Date().toISOString()
  }, { 'x-worldbase-peer-id': serviceA.getIdentity().instanceId })
  assert.equal(invite.status, 200, JSON.stringify(invite.body))

  const inbox = (await serviceB.getState()).inbox
  const invitation = inbox.find(item => item.type === 'invitation' && item.groupId === created.id)
  assert.ok(invitation)
  assert.equal(invitation.fromAvatar, '🧑‍🚀')
  assert.deepEqual(invitation.fromTags, ['产品', 'AI'])
  const joined = await serviceB.acceptInvitation(invitation.id, '研发')
  assert.equal(joined.members.filter(member => member.kind === 'human').length, 2)
  assert.deepEqual(
    joined.members.find(member => member.kind === 'human' && member.peerId === serviceA.getIdentity().instanceId)?.tags,
    ['产品', 'AI']
  )

  const updated = await serviceA.updateGroup(created.id, {
    name: 'LAN product studio',
    icon: '🧭',
    description: 'Updated group details'
  })
  assert.equal(updated.name, 'LAN product studio')
  await assert.rejects(() => serviceB.updateGroup(created.id, { name: 'Unauthorized rename' }))
  await waitFor(() => serviceB.getState().then(state => state.groups
    .find(group => group.id === created.id)
    ?.description === 'Updated group details'))

  await serviceB.addAgent(created.id, 'agent_b', '分析')
  await waitFor(() => serviceA.getState().then(state => state.groups
    .find(group => group.id === created.id)
    ?.members.some(member => member.agentId === 'agent_b')))

  const sent = await serviceA.sendMessage(created.id, 'Hello from A', [{
    name: 'notes.txt',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('LAN file contents').toString('base64')
  }])
  assert.deepEqual(sent.deliveryErrors, [])
  await waitFor(() => serviceB.getState().then(state => state.groups
    .find(group => group.id === created.id)
    ?.messages.some(message => message.content === 'Hello from A')))
  const groupB = (await serviceB.getState()).groups.find(group => group.id === created.id)
  const receivedMessage = groupB.messages.find(message => message.content === 'Hello from A')
  const attachment = receivedMessage.attachments[0]
  assert.equal(attachment.name, 'notes.txt')
  const attachmentData = await serviceB.readAttachment(created.id, attachment.id)
  assert.equal(Buffer.from(attachmentData.dataBase64, 'base64').toString('utf8'), 'LAN file contents')

  const peerBId = serviceB.getIdentity().instanceId
  await serviceB.saveIdentity({
    displayName: 'Mac B Studio',
    avatar: '🦊',
    background: 'sunset',
    tags: ['设计', '远程']
  })
  await waitFor(() => serviceA.getState().then(state => {
    const member = state.groups
      .find(group => group.id === created.id)
      ?.members.find(item => item.kind === 'human' && item.peerId === peerBId)
    return member?.peerName === 'Mac B Studio'
      && member.avatar === '🦊'
      && member.background === 'sunset'
      && member.tags?.includes('设计')
  }))
  const profileMessage = await serviceB.sendMessage(created.id, 'Profile-aware hello')
  assert.equal(profileMessage.group.messages.find(message => message.content === 'Profile-aware hello')?.senderAvatar, '🦊')
  await waitFor(() => serviceA.getState().then(state => state.groups
    .find(group => group.id === created.id)
    ?.messages.some(message => message.content === 'Profile-aware hello')))
  const receivedProfileMessage = (await serviceA.getState()).groups
    .find(group => group.id === created.id)
    .messages.find(message => message.content === 'Profile-aware hello')
  assert.equal(receivedProfileMessage.senderName, 'Mac B Studio')
  assert.equal(receivedProfileMessage.senderAvatar, '🦊')
  assert.equal(receivedProfileMessage.senderBackground, 'sunset')

  const targetAgent = groupB.members.find(member => member.agentId === 'agent_b')
  const mentioned = await serviceA.sendMessage(created.id, `@${targetAgent.agentName} Summarize the launch risks`)
  assert.deepEqual(mentioned.deliveryErrors, [])
  await waitFor(() => serviceB.getState().then(state => state.groups
    .find(group => group.id === created.id)
    ?.delegations.some(item => item.toAgentMemberId === targetAgent.id)))
  const pendingForB = (await serviceB.getState()).groups
    .find(group => group.id === created.id)
    .delegations.find(item => item.toAgentMemberId === targetAgent.id)
  assert.equal(pendingForB.status, 'pending_owner_approval')
  assert.equal(pendingForB.task, 'Summarize the launch risks')

  await serviceB.decideDelegation(created.id, pendingForB.id, true)
  await waitFor(() => serviceA.getState().then(state => state.groups
    .find(group => group.id === created.id)
    ?.delegations.find(item => item.id === pendingForB.id)?.status === 'completed'))

  assert.equal(executed.length, 1)
  assert.match(executed[0].context, /Cross-user delegations require owner approval|跨用户委派/)
  assert.match(executed[0].context, /角色说明：Analyst B description/)
  const finalA = (await serviceA.getState()).groups.find(group => group.id === created.id)
  const completed = finalA.delegations.find(item => item.id === pendingForB.id)
  assert.match(completed.result || '', /Agent agent_b completed/)
  assert.ok(finalA.messages.some(message => message.kind === 'agent' && message.content.includes('Agent agent_b completed')))

  assert.equal(await serviceA.deleteGroup(created.id), true)
  assert.equal((await serviceA.getState()).groups.some(group => group.id === created.id), false)
  assert.equal((await serviceB.getState()).groups.some(group => group.id === created.id), false)
})

test('remote delegation cannot enter the approved state without owner action', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldbase-online-delegation-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const service = new OnlineGroupService({
    userDataPath: root,
    port: 19527,
    resolveHarness: async () => null,
    getAgent: () => null
  })
  await service.saveIdentity({ displayName: 'Owner', role: '研发', discoveryEnabled: false })
  const group = await service.createGroup({ name: 'Policy room', role: '研发' })
  const record = JSON.parse(fs.readFileSync(
    path.join(root, 'online-groups', 'groups', `${group.id}.json`),
    'utf8'
  ))
  const peerId = 'peer-remote'
  const accepted = await service.handleAcceptInvite(group.id, {
    inviteToken: record.inviteToken,
    peerId,
    displayName: 'Remote',
    role: '产品',
    baseUrl: 'http://127.0.0.1:19601'
  })
  const remoteGroup = accepted.group
  const remoteAgentId = `${peerId}:agent:remote_agent`
  service.handleIncomingMember(group.id, record.accessToken, {
    id: remoteAgentId,
    peerId,
    peerName: 'Remote',
    kind: 'agent',
    role: '分析',
    accessRole: 'member',
    baseUrl: 'http://127.0.0.1:19601',
    agentId: 'remote_agent',
    agentName: 'Remote Agent',
    joinedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, peerId)

  const delegation = {
    id: 'delegation-forged',
    groupId: group.id,
    fromPeerId: peerId,
    fromName: 'Remote',
    toAgentMemberId: remoteAgentId,
    toAgentName: 'Remote Agent',
    toOwnerPeerId: peerId,
    task: 'Run without approval',
    status: 'approved',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  service.handleIncomingDelegation(group.id, record.accessToken, delegation, peerId)
  const stored = (await service.getState()).groups
    .find(item => item.id === group.id)
    .delegations.find(item => item.id === delegation.id)
  assert.equal(stored.status, 'pending_owner_approval')
  assert.ok(remoteGroup)
})

test('an Agent that @mentions a same-owner Agent hands over the task and the target replies', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldbase-online-agent-mention-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const agents = {
    agent_a: agent('agent_a', 'Planner A'),
    agent_b: agent('agent_b', 'Analyst B')
  }
  const executed = []
  const service = new OnlineGroupService({
    userDataPath: root,
    port: 19527,
    baseUrl: 'http://127.0.0.1:19527',
    resolveHarness: async () => null,
    getAgent: id => agents[id] || null
  })
  service.setAgentExecutor(async input => {
    executed.push(input)
    if (input.agentId === 'agent_a') return '@Analyst B 请接手：整理发布风险'
    if (input.agentId === 'agent_b') return 'Analyst B 已接手并整理完成'
    throw new Error(`Unexpected Agent ${input.agentId}`)
  })
  await service.saveIdentity({ displayName: 'Owner', role: '研发', discoveryEnabled: false })
  const created = await service.createGroup({ name: 'Agent handoff room', role: '研发' })
  const withPlanner = await service.addAgent(created.id, 'agent_a')
  const withBoth = await service.addAgent(created.id, 'agent_b')
  const planner = withBoth.members.find(member => member.agentId === 'agent_a')
  const analyst = withBoth.members.find(member => member.agentId === 'agent_b')
  assert.ok(planner)
  assert.ok(analyst)
  assert.ok(withPlanner.members.some(member => member.agentId === 'agent_a'))

  const sent = await service.runOwnedAgentMessage(created.id, planner.id, '请先做规划')
  assert.ok(sent.group.messages.some(message => message.kind === 'agent' && message.content.includes('@Analyst B')))

  await waitFor(async () => {
    const group = (await service.getState()).groups.find(item => item.id === created.id)
    return Boolean(group?.messages.some(message => (
      message.kind === 'agent'
      && message.senderName === 'Analyst B'
      && message.content.includes('已接手')
    )) && group.delegations.some(delegation => (
      delegation.fromAgentId === 'agent_a'
      && delegation.toAgentMemberId === analyst.id
      && delegation.status === 'completed'
    )))
  })

  assert.deepEqual(executed.map(item => item.agentId), ['agent_a', 'agent_b'])
  assert.match(executed[0].context, /直接在回复中用 @Agent名称/)
  assert.match(executed[1].task, /整理发布风险/)
})

test('the shared chat timeline nests humans, owned agents, attachments, and current identities', () => {
  const group = {
    id: 'group-timeline',
    name: 'Timeline room',
    icon: '🧪',
    description: '',
    ownerPeerId: 'peer-a',
    ownerName: 'Mac A',
    accessRole: 'owner',
    joinPolicy: 'request',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:02:00.000Z',
    members: [
      {
        id: 'peer-a:human',
        peerId: 'peer-a',
        peerName: 'Mac A',
        kind: 'human',
        role: '',
        accessRole: 'owner',
        baseUrl: 'http://127.0.0.1:1',
        joinedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'peer-b:human',
        peerId: 'peer-b',
        peerName: 'Mac B',
        kind: 'human',
        role: '',
        avatar: '🐼',
        background: 'forest',
        tags: ['设计'],
        accessRole: 'member',
        baseUrl: 'http://127.0.0.1:2',
        joinedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'peer-b:agent:analyst',
        peerId: 'peer-b',
        peerName: 'Mac B',
        kind: 'agent',
        role: '',
        accessRole: 'member',
        baseUrl: 'http://127.0.0.1:2',
        agentId: 'analyst',
        agentName: 'Analyst',
        agentIcon: '📊',
        joinedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    messages: [
      {
        id: 'message-a',
        groupId: 'group-timeline',
        senderPeerId: 'peer-a',
        senderName: 'Mac A',
        senderRole: '',
        kind: 'human',
        content: 'Hello',
        attachments: [],
        createdAt: '2026-01-01T00:00:30.000Z'
      },
      {
        id: 'message-b',
        groupId: 'group-timeline',
        senderPeerId: 'peer-b',
        senderName: 'Analyst',
        senderRole: '',
        kind: 'agent',
        content: 'Result ready',
        attachments: [{
          id: 'file-1',
          name: 'report.txt',
          mimeType: 'text/plain',
          size: 6,
          sha256: 'a'.repeat(64),
          sourcePeerId: 'peer-b'
        }],
        createdAt: '2026-01-01T00:01:00.000Z'
      },
      {
        id: 'message-c',
        groupId: 'group-timeline',
        senderPeerId: 'peer-b',
        senderName: 'Old Mac B',
        senderRole: '',
        senderAvatar: '👤',
        kind: 'human',
        content: 'Identity changed',
        attachments: [],
        createdAt: '2026-01-01T00:01:15.000Z'
      }
    ],
    delegations: [{
      id: 'delegation-1',
      groupId: 'group-timeline',
      fromPeerId: 'peer-b',
      fromName: 'Mac B',
      toAgentMemberId: 'peer-a:agent:reviewer',
      toAgentName: 'Reviewer',
      toOwnerPeerId: 'peer-a',
      task: 'Review the result',
      status: 'pending_owner_approval',
      createdAt: '2026-01-01T00:01:30.000Z',
      updatedAt: '2026-01-01T00:01:30.000Z'
    }]
  }
  const state = {
    identity: {
      instanceId: 'peer-a',
      displayName: 'Mac A',
      role: '',
      discoveryEnabled: true,
      advertiseGroups: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    discovery: {
      running: true,
      enabled: true,
      local: null,
      peers: [],
      multicastAddress: '239.255.76.87',
      port: 19528
    },
    groups: [group],
    inbox: [],
    localAddresses: ['127.0.0.1'],
    serverPort: 19527
  }
  const mapped = mapOnlineMessages(group, state, key => key)
  assert.equal(mapped[0].role, 'user')
  assert.equal(mapped[1].role, 'assistant')
  assert.equal(mapped[1].speakerIcon, '📊')
  assert.equal(mapped[1].blocks.find(block => block.kind === 'online_group_attachment').attachment.name, 'report.txt')
  assert.equal(mapped[2].speakerName, 'Mac B')
  assert.equal(mapped[2].speakerIcon, '🐼')
  assert.equal(mapped.length, 4)
  assert.equal(mapped[3].speakerName, 'Reviewer')
  const delegationBlock = mapped[3].blocks.find(block => block.kind === 'online_group_delegation')
  assert.ok(delegationBlock)
  assert.equal(delegationBlock.delegation.status, 'pending_owner_approval')
  assert.equal(delegationBlock.ownerName, 'Mac A')

  const completedGroup = {
    ...group,
    messages: [...group.messages, {
      id: 'message-d',
      groupId: 'group-timeline',
      senderPeerId: 'peer-a',
      senderName: 'Reviewer',
      senderRole: 'Reviewer',
      kind: 'agent',
      content: 'Review complete.',
      attachments: [],
      createdAt: '2026-01-01T00:02:00.000Z',
      delegationId: 'delegation-1'
    }],
    delegations: [{ ...group.delegations[0], status: 'completed', updatedAt: '2026-01-01T00:02:00.000Z' }]
  }
  const completed = mapOnlineMessages(completedGroup, state, key => key)
  assert.equal(completed.some(message => message.blocks?.some(block => block.kind === 'online_group_delegation')), false)
  assert.equal(completed.at(-1).speakerName, 'Reviewer')
  assert.equal(completed.at(-1).content, 'Review complete.')

  const localGroup = { ...group, id: 'local-group', online: undefined }
  const merged = mergeAgentGroupCatalog([localGroup], state)
  assert.deepEqual(merged.map(item => item.id), ['local-group', onlineGroupConversationId('group-timeline')])
  assert.equal(merged[1].online.members.filter(member => member.kind === 'agent').length, 1)
})
