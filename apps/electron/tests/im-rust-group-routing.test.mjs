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
  './group-deliberation.js': `
    export function parseGroupRouting(_group, text) {
      globalThis.${STATE_KEY}.routingInputs.push(text)
      return globalThis.${STATE_KEY}.routing
    }
    export function resolveDirectGroupReplyRoute() { return null }
    export function buildDirectGroupReplyPromptSection() { return 'direct group reply' }
    export async function buildGroupDeliberationSection() {
      throw new Error('TypeScript GroupSession path must not run in Rust mode')
    }
  `,
  './native-rust-group-deliberation.js': `
    export async function buildNativeRustGroupDeliberation(input) {
      globalThis.${STATE_KEY}.nativeCalls.push(input)
      return { promptSection: 'native Rust group notes', transcript: null }
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

test('Rust-selected IM group replies use the native Rust group adapter', async () => {
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
  const replyCalls = []
  const memoryCalls = []
  globalThis[STATE_KEY] = {
    routingInputs: [],
    nativeCalls: [],
    routing: {
      mode: 'discussion',
      selectedMemberIds: ['member'],
      mentionedMemberIds: [],
      normalizedRequest: 'Review the deployment plan.'
    },
    rustHarnessEngine: {
      async chat (_messages, options) {
        replyCalls.push(options)
        return { role: 'assistant', content: 'Rust IM reply' }
      }
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
      aiEngine: {
        async chat () { throw new Error('TypeScript AI engine must not run in Rust mode') }
      },
      rustHarness: {
        native: true,
        async ingestMemory (input) { memoryCalls.push(input) }
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
    text: 'Review the deployment plan.'
  })

  assert.equal(reply, 'Rust IM reply')
  assert.equal(globalThis[STATE_KEY].nativeCalls.length, 1)
  assert.equal(globalThis[STATE_KEY].nativeCalls[0].client.native, true)
  assert.deepEqual(globalThis[STATE_KEY].nativeCalls[0].agents.map(agent => agent.id), ['coordinator', 'member'])
  assert.equal(globalThis[STATE_KEY].nativeCalls[0].context.targetProjectId, 'project-im')
  assert.deepEqual(globalThis[STATE_KEY].nativeCalls[0].context.systemPromptSections, ['## Channel context'])
  assert.match(globalThis[STATE_KEY].nativeCalls[0].sessionId, /^im-rust-group-binding-1-message-1-/)
  assert.equal(globalThis[STATE_KEY].routingInputs.length, 1)
  assert.match(replyCalls[0].systemPromptSections.at(-1), /native Rust group notes/)
  assert.equal(memoryCalls.length, 1)
  assert.equal(memoryCalls[0].finalAssistantText, 'Rust IM reply')
})
