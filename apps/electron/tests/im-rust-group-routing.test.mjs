import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const STATE_KEY = '__worldbaseImRustGroupRoutingState'

const STUBS = {
  '../state.js': `export const mainState = globalThis.${STATE_KEY}.mainState`,
  '../chat-message-utils.js': `
    export function getMessageText(content) { return typeof content === 'string' ? content : '' }
    export function getLastUserMessageText(messages) {
      const message = [...messages].reverse().find(item => item.role === 'user')
      return typeof message?.content === 'string' ? message.content : ''
    }
  `,
  './agent-context.js': `
    export function resolveAgentRuntimeContext() { return globalThis.${STATE_KEY}.runtimeContext }
  `,
  './native-rust-room.js': `
    export function formatRoomReplies(replies) {
      return replies.map(reply => reply.speakerName + ':\\n' + reply.content).join('\\n\\n')
    }
    export async function runNativeRoom(input) {
      globalThis.${STATE_KEY}.nativeCalls.push(input)
      return [{ speakerName: 'Coordinator', content: 'First reply' }, { speakerName: 'Member', content: 'Second reply' }]
    }
  `,
  './selected-execution-engine.js': `
    export async function startSelectedRustHarness() {
      return globalThis.${STATE_KEY}.rustHarnessEngine
    }
  `
}

let modulePromise

async function loadModule () {
  if (modulePromise) return await modulePromise
  modulePromise = (async () => {
    const result = await build({
      entryPoints: ['electron/main-process/ai/im-replies.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      plugins: [{
        name: 'im-rust-group-routing-stubs',
        setup (build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (Object.hasOwn(STUBS, args.path)) {
              return { path: args.path, namespace: 'im-rust-group-routing-stub' }
            }
            return undefined
          })
          build.onLoad({ filter: /.*/, namespace: 'im-rust-group-routing-stub' }, args => ({
            contents: STUBS[args.path],
            loader: 'js'
          }))
        }
      }]
    })
    return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  })()
  return await modulePromise
}

test('an IM room returns the member replies without a coordinator synthesis turn', async () => {
  const agents = new Map([
    ['coordinator', { id: 'coordinator', name: 'Coordinator' }],
    ['member', { id: 'member', name: 'Member' }]
  ])
  const group = {
    id: 'im-group',
    name: 'IM native group',
    coordinatorAgentId: 'coordinator',
    memberAgentIds: ['member']
  }
  globalThis[STATE_KEY] = {
    nativeCalls: [],
    rustHarnessEngine: {
      async chat () { assert.fail('IM must not pass the room replies through a second model call') }
    },
    runtimeContext: {
      agent: agents.get('coordinator'),
      group,
      channelBinding: null,
      effectiveTargetProjectId: 'project-im',
      providerConfig: { reasoningEffort: 'high', temperature: 0.2 },
      activeSkillContents: ['coordinator skill'],
      systemPromptSections: ['## Active custom agent\nCoordinator', '## Channel context'],
      allowedToolNames: [],
      deniedToolNames: [],
      memoryScopeTypes: []
    },
    mainState: {
      rustHarness: {
        native: true,
        async ingestMemory () { assert.fail('Room answers must not be attributed to the default member as a group summary') }
      },
      agentStore: { get: id => agents.get(id) }
    }
  }

  const { generateImGatewayReply } = await loadModule()
  const reply = await generateImGatewayReply({
    id: 'binding-1',
    connectorType: 'slack',
    externalChannelId: 'channel-1',
    boundGroupId: 'im-group',
    defaultAgentId: 'coordinator',
    targetProjectId: 'project-im'
  }, {
    connectorType: 'slack',
    channelId: 'channel-1',
    messageId: 'message-1',
    senderId: 'user-1',
    senderName: 'External User',
    text: '@all Review the deployment plan.'
  })

  assert.equal(reply, 'Coordinator:\nFirst reply\n\nMember:\nSecond reply')
  assert.equal(globalThis[STATE_KEY].nativeCalls.length, 1)
  assert.equal(globalThis[STATE_KEY].nativeCalls[0].client.native, true)
  assert.deepEqual(globalThis[STATE_KEY].nativeCalls[0].agents.map(agent => agent.id), ['coordinator', 'member'])
  assert.equal(globalThis[STATE_KEY].nativeCalls[0].context.targetProjectId, 'project-im')
  assert.equal(globalThis[STATE_KEY].nativeCalls[0].context.systemPromptSections[0], '## Channel context')
  assert.equal(globalThis[STATE_KEY].nativeCalls[0].context.authMode, 'strict')
  assert.equal(globalThis[STATE_KEY].nativeCalls[0].requestWorkspaceApproval, undefined)
  assert.match(globalThis[STATE_KEY].nativeCalls[0].sessionId, /^im-rust-room-binding-1-message-1-/)
  assert.match(globalThis[STATE_KEY].nativeCalls[0].messages[0].content, /@all Review the deployment plan\.$/)
})
