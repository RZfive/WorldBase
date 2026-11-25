import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { RustHarnessClient } from '../electron/main-process/rust-harness-client.ts'
import { mainState } from '../electron/main-process/state.ts'
import { parseLocalAgentCliLine } from '../src/main/local-agents/cli-parser.ts'
import { localAgentDefinition } from '../src/main/local-agents/catalog.ts'
import { LocalAgentRegistry } from '../src/main/local-agents/registry.ts'
import { prepareRoomLocalWorkspace, resolveRoomLocalWorkspace } from '../src/main/local-agents/room-workspace.ts'
import { runLocalAgent } from '../src/main/local-agents/runtime.ts'
import { inviteRoomLocalWorker, removeRoomLocalWorker } from '../src/main/local-agents/service.ts'
import { findGroupMentionQuery } from '../src/shared/group-mentions.ts'
import { roomLocalWorkerName } from '../src/shared/local-agent-types.ts'
import { localRoomSessionKey, nativeRoomId } from '../src/shared/room-context.ts'

function createFixture (context) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worldbase-local-agent-')))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`
  context.after(() => {
    process.env.PATH = previousPath
    fs.rmSync(root, { recursive: true, force: true })
  })
  const writeCli = (name, script) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh
test "$1" = '--version' && { printf '${name} 1.0\n'; exit; }
${script}
`, { mode: 0o755 })
  return { root, writeCli, registry: new LocalAgentRegistry(path.join(root, 'app-data')) }
}

async function loadRoomAdapter (root) {
  const sources = {
    'state.js': 'export const mainState = globalThis.__worldbaseRoomSmokeState',
    'main-i18n.js': 'export function t(key, params) { return [key, ...Object.values(params || {})].join(" ") }'
  }
  const adapter = path.join(root, 'room-adapter.mjs')
  await build({
    entryPoints: ['electron/main-process/ai/native-rust-room.ts'],
    outfile: adapter,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'room-smoke-host',
      setup (bundle) {
        bundle.onResolve({ filter: /\/(state|main-i18n)\.js$/ }, args => ({ path: path.basename(args.path), namespace: 'test-host' }))
        bundle.onLoad({ filter: /.*/, namespace: 'test-host' }, args => ({ contents: sources[args.path] }))
      }
    }]
  })
  return await import(pathToFileURL(adapter).href)
}

test('CLI parsers identify sessions, tool events and failure results', () => {
  assert.equal(parseLocalAgentCliLine('codex', '{"type":"thread.started","thread_id":"thread-1"}').sessionId, 'thread-1')
  assert.equal(parseLocalAgentCliLine('codex', '{"type":"item.completed","item":{"type":"command_execution","command":"cargo test"}}').toolName, 'shell')
  assert.equal(parseLocalAgentCliLine('claude', '{"type":"result","is_error":true,"result":"Denied"}').error, 'Denied')
  assert.equal(parseLocalAgentCliLine('opencode', '{"type":"text","part":{"sessionID":"ses_1","text":"Done"}}').sessionId, 'ses_1')
  assert.deepEqual(parseLocalAgentCliLine('codex', '{"type":"item.completed","item":{"type":"reasoning","text":"Review the file"}}'), { thinking: 'Review the file' })
  const claude = parseLocalAgentCliLine('claude', '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Check the input"},{"type":"text","text":"Result"}]}}')
  assert.equal(claude.thinking, 'Check the input')
  assert.equal(claude.text, 'Result')
  assert.equal(parseLocalAgentCliLine('opencode', '{"type":"reasoning","part":{"text":"Inspect dependencies"}}').thinking, 'Inspect dependencies')
})

test('mention completions work after spaces, next to Chinese text and with a full-width at sign', () => {
  assert.deepEqual(findGroupMentionQuery('@', 1), { start: 0, end: 1, query: '' })
  assert.deepEqual(findGroupMentionQuery('please @', 8), { start: 7, end: 8, query: '' })
  assert.deepEqual(findGroupMentionQuery('请帮我＠Cod', 7), { start: 3, end: 7, query: 'Cod' })
  assert.deepEqual(findGroupMentionQuery('@@co and more', 4), { start: 1, end: 4, query: 'co' })
  assert.equal(findGroupMentionQuery('@Codex CLI ', 11), null)
})

test('a room prefers the task folder, then the project, then its own managed directory', async context => {
  const { root } = createFixture(context)
  const dataDir = path.join(root, 'app-data')
  const task = path.join(root, 'task')
  const project = path.join(root, 'project')
  fs.mkdirSync(task)
  fs.mkdirSync(project)
  const taskWorkspace = await resolveRoomLocalWorkspace(dataDir, 'room', task, project)
  assert.deepEqual(taskWorkspace, { path: task, source: 'task' })
  fs.rmdirSync(task)
  await assert.rejects(prepareRoomLocalWorkspace(taskWorkspace), /approved working directory is no longer available/)
  assert.deepEqual(await resolveRoomLocalWorkspace(dataDir, 'room', path.join(root, 'missing-task'), project), { path: project, source: 'project' })
  const workspace = await resolveRoomLocalWorkspace(dataDir, '../room')
  assert.equal(workspace.source, 'room')
  assert.equal(path.dirname(workspace.path), path.join(dataDir, 'room-workspaces'))
  assert.notEqual(workspace.path, (await resolveRoomLocalWorkspace(dataDir, 'room')).path)
  assert.equal(fs.existsSync(workspace.path), false)
  assert.equal(await prepareRoomLocalWorkspace(workspace), workspace.path)
  assert.ok(fs.statSync(workspace.path).isDirectory())
})

test('CLI turn resumes the same room session with the current sandbox mode', async context => {
  const { root, writeCli, registry } = createFixture(context)
  writeCli('codex', `
printf '%s\n' "$@" > argv
cat > prompt
printf '%s\n' '{"type":"thread.started","thread_id":"session-42"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"CLI evidence: tests passed"}}'
`)
  const request = { groupId: 'room-1', agentId: 'local_cli_codex', prompt: 'Implement task', workspaceRoot: root, allowWorkspaceWrites: true }
  assert.equal((await runLocalAgent(request, registry)).text, 'CLI evidence: tests passed')
  assert.equal(registry.getSession('room-1', request.agentId, root).sessionId, 'session-42')
  assert.equal(registry.getSession('room-2', request.agentId, root), null)
  assert.throws(() => registry.bindSession('room-2', request.agentId, root, 'session-42'), /already assigned/)
  await runLocalAgent({ ...request, prompt: 'Continue task', allowWorkspaceWrites: false }, registry)
  const argv = fs.readFileSync(path.join(root, 'argv'), 'utf8')
  assert.match(argv, /exec\nresume\n[\s\S]*session-42/)
  assert.match(argv, /sandbox_mode="read-only"/)
  assert.doesNotMatch(argv, /^-s$|--auto|--dangerously-bypass/m)
  assert.equal(fs.readFileSync(path.join(root, 'prompt'), 'utf8'), 'Continue task')
})

test('session discovery filters other workspaces and already assigned sessions', async context => {
  const { root, writeCli, registry } = createFixture(context)
  writeCli('opencode', `printf '%s\n' '[{"id":"ses_here","directory":"${root}"},{"id":"ses_other","directory":"/"},{"id":"ses_unknown"},{"id":"ses_claimed","directory":"${root}"}]'`)
  registry.bindSession('room-1', 'local_cli_opencode', root, 'ses_claimed')
  assert.deepEqual((await registry.discoverSessions('local_cli_opencode', root)).map(item => item.sessionId), ['ses_here'])
})

test('workers have distinct session bindings and a CLI session cannot be shared by two workers', context => {
  const { root, registry } = createFixture(context)
  const first = 'local_worker_codex_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const second = 'local_worker_codex_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const releaseFirst = registry.reserveRun('room', first, root)
  const releaseSecond = registry.reserveRun('room', second, root)
  registry.saveSession('room', first, root, 'first-thread')
  registry.saveSession('room', second, root, 'second-thread')
  assert.throws(() => registry.saveSession('room', second, root, 'first-thread'), /already assigned/)
  assert.throws(() => registry.saveSession('other-room', 'local_cli_codex', root, 'first-thread'), /already assigned/)
  assert.throws(() => registry.releaseWorkerSessions('room', first), /still running/)
  releaseFirst()
  registry.releaseWorkerSessions('room', first)
  assert.equal(registry.getSession('room', first, root), null)
  assert.equal(registry.getSession('room', second, root)?.sessionId, 'second-thread')
  releaseSecond()
})

test('Codex session discovery requests threads for the chosen workspace', async context => {
  const { root, writeCli, registry } = createFixture(context)
  writeCli('codex', `
read -r request
printf '%s\n' '{"id":1,"result":{}}'
read -r notification
read -r query
printf '%s' "$query" > thread-query
printf '%s\n' '{"id":2,"result":{"data":[{"id":"thread-id","sessionId":"tree-id","cwd":"${root}","name":"Review"},{"id":"child-id","parentThreadId":"thread-id","cwd":"${root}"}]}}'
`)
  assert.deepEqual((await registry.discoverSessions('local_cli_codex', root)).map(item => item.sessionId), ['thread-id'])
  const query = JSON.parse(fs.readFileSync(path.join(root, 'thread-query'), 'utf8'))
  assert.equal(query.method, 'thread/list')
  assert.equal(query.params.cwd, root)
})

test('stopping an active CLI turn terminates its child process group', { timeout: 6000 }, async context => {
  const { root, writeCli, registry } = createFixture(context)
  writeCli('codex', `
cat >/dev/null
sleep 30 &
printf '%s\n' "$!" > worker-pid
printf '%s\n' '{"type":"item.started","item":{"type":"command_execution","command":"wait"}}'
wait
`)
  const controller = new AbortController()
  const reason = new Error('User stopped room')
  let receivedToolEvent = false
  await assert.rejects(runLocalAgent({
    groupId: 'room-1',
    agentId: 'local_cli_codex',
    prompt: 'Wait',
    workspaceRoot: root,
    allowWorkspaceWrites: false,
    abortSignal: controller.signal,
    onEvent: event => {
      if (event.kind !== 'tool') return
      receivedToolEvent = true
      controller.abort(reason)
    }
  }, registry), error => error === reason)
  assert.equal(receivedToolEvent, true)
  const workerPid = Number(fs.readFileSync(path.join(root, 'worker-pid'), 'utf8').trim())
  let alive = true
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(workerPid, 0)
    } catch {
      alive = false
      break
    }
    await delay(25)
  }
  assert.equal(alive, false, 'The managed CLI child process must stop with its parent.')
})

test('installed Rust harness dispatches CLI work, persists invitations and shares prior results', {
  skip: !process.env.WORLDBASE_RUST_HARNESS,
  timeout: 30_000
}, async context => {
  const { root, writeCli, registry } = createFixture(context)
  writeCli('codex', `
cat > codex-prompt
printf '%s\n' '{"type":"thread.started","thread_id":"session-codex"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"reasoning","text":"Review the fixture first"}}'
printf '%s\n' '{"type":"item.started","item":{"type":"command_execution","command":"check fixture"}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"message\\":\\"Codex produced evidence\\",\\"handoffs\\":[{\\"agentId\\":\\"local_cli_claude\\",\\"role\\":\\"Reviewer\\",\\"exitAfterTask\\":false,\\"task\\":\\"Review the Codex result\\"}]}"}}'
`)
  writeCli('claude', `
cat > claude-prompt
while test "$#" -gt 0; do
  if test "$1" = '--add-dir'; then
    shift
    cat "$1/messages.json" > shared-archive
  fi
  shift
done
printf '%s\n' '{"type":"result","session_id":"session-claude","result":"Claude reviewed the evidence"}'
`)
  const agents = new Map()
  const agentStore = {
    get: id => agents.get(id),
    save: agent => { agents.set(agent.id, agent); return agent }
  }
  const client = new RustHarnessClient({ workspace: root, dataDir: path.join(root, 'rust'), onEvent () {} })
  const saved = { agentStore: mainState.agentStore, localAgentRegistry: mainState.localAgentRegistry, rustHarness: mainState.rustHarness }
  Object.assign(mainState, { agentStore, localAgentRegistry: registry, rustHarness: client })
  globalThis.__worldbaseRoomSmokeState = mainState
  context.after(() => {
    client.dispose()
    Object.assign(mainState, saved)
    delete globalThis.__worldbaseRoomSmokeState
  })
  const codex = agentStore.save(await client.saveAgent(localAgentDefinition(await registry.get('local_cli_codex'))))
  const group = await client.saveAgentGroup({ id: 'cli-room', name: 'CLI Room', coordinatorAgentId: codex.id, memberAgentIds: [] })
  const nativeGroupId = 'room-cli-room'
  const localWorkspace = await resolveRoomLocalWorkspace(path.join(root, 'app-data'), group.id)
  const { runNativeRoom } = await loadRoomAdapter(root)
  const request = 'Implement the fixture and get a review'
  const progress = []
  const joined = []
  const approvals = []
  const result = await runNativeRoom({
    client, group, agents: [codex], localAgentRegistry: registry,
    messages: [{ role: 'user', content: request }],
    sessionId: 'test-room-stream', localWorkspace,
    requestWorkspaceApproval: async approval => {
      assert.equal(approval.purpose, 'room_workspace')
      assert.ok(approval.detail.includes(localWorkspace.path))
      if (approvals.length === 0) assert.equal(fs.existsSync(localWorkspace.path), false)
      approvals.push(approval)
      return true
    },
    onMembershipChanged: group => joined.push(group), onProgress: event => progress.push(event)
  })
  assert.deepEqual(result.map(reply => reply.content), ['Codex produced evidence', 'Claude reviewed the evidence'])
  assert.equal(approvals.length, 2)
  const [reviewer] = joined[0].localWorkers
  const reviewerName = roomLocalWorkerName(reviewer)
  assert.deepEqual(progress.filter(event => event.type === 'room_message').map(event => event.roomMessage.speakerName), [codex.name, reviewerName])
  assert.deepEqual(progress.filter(event => event.type === 'room_member_status').map(event => event.roomMemberStatus.status), ['queued', 'running', 'completed'])
  assert.deepEqual(progress.filter(event => event.type === 'thinking').map(event => event.content.trim()), ['Review the fixture first'])
  assert.ok(progress.some(event => event.type === 'progress' && event.detail === 'shell: check fixture'))
  assert.ok(progress.some(event => event.type === 'group_peer_message' && event.peerMessage.status === 'completed'))
  assert.equal(joined.length, 1)
  assert.equal(reviewer.kind, 'claude')
  assert.deepEqual((await client.getAgentGroup(group.id)).localWorkers, [reviewer])
  const prompt = fs.readFileSync(path.join(localWorkspace.path, 'claude-prompt'), 'utf8')
  assert.match(prompt, /Codex produced evidence/)
  assert.match(prompt, /Review the Codex result/)
  assert.match(prompt, /Work as an autonomous teammate/)
  assert.match(prompt, /split it into concrete parts and hand off independent parts immediately/)
  assert.match(prompt, /Before asking the user, check whether a safe, reversible default exists/)
  assert.match(prompt, /Do not ask the user to @ someone/)
  assert.match(fs.readFileSync(path.join(localWorkspace.path, 'shared-archive'), 'utf8'), /Codex produced evidence/)
  assert.ok((await client.listConversationMessages(`group-${nativeGroupId}`)).some(row => row.content.includes(`Handoff to ${reviewerName}:`)))
  const nativeGroup = await client.getNativeGroup(nativeGroupId)
  assert.equal(nativeGroup.members.length, 2)
  assert.ok(nativeGroup.members.every(member => member.localRuntime === true))
  const clarify = 'Check cancellation too'
  const injected = await client.injectNativeGroup('test-room-stream', nativeGroupId, clarify, [codex.id])
  assert.equal(injected.queued, 1)
  assert.ok((await client.listConversationMessages(`group-${nativeGroupId}`)).some(row => row.content.includes(clarify)))

  const unapprovedWorkspace = await resolveRoomLocalWorkspace(path.join(root, 'app-data'), 'different-workspace')
  await assert.rejects(runNativeRoom({
    client, group: await client.getAgentGroup(group.id), agents: [codex], localAgentRegistry: registry,
    messages: [{ role: 'user', content: '@Codex CLI Verify the example' }],
    sessionId: 'denied-room-stream',
    localWorkspace: unapprovedWorkspace,
    context: { authMode: 'auto' },
    requestWorkspaceApproval: async approval => {
      assert.equal(approval.purpose, 'room_workspace')
      assert.ok(approval.detail.includes(unapprovedWorkspace.path))
      return false
    }
  }), /roomWorkspaceDenied/)
  assert.equal(fs.existsSync(unapprovedWorkspace.path), false)

  const handoffReply = JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: JSON.stringify({ message: 'Codex finished the draft', handoffs: [{ agentId: `@${reviewerName}`, task: 'Review the direct result' }] })
    }
  })
  writeCli('codex', `
cat > codex-direct-prompt
printf '%s\n' '${handoffReply}'
`)
  const directReplies = []
  const directApprovals = []
  const directResult = await runNativeRoom({
    client, group: await client.getAgentGroup(group.id), agents: [codex], localAgentRegistry: registry,
    messages: [{ role: 'user', content: '@Codex CLI Return the result' }],
    sessionId: 'approved-direct-room-stream',
    localWorkspace,
    requestWorkspaceApproval: async approval => {
      assert.equal(approval.purpose, 'room_workspace')
      assert.ok(approval.detail.includes(localWorkspace.path))
      directApprovals.push(approval.title)
      return true
    },
    onProgress: event => { if (event.type === 'room_message') directReplies.push(event.roomMessage) }
  })
  assert.deepEqual(directResult.map(reply => reply.content), ['Codex finished the draft', 'Claude reviewed the evidence'])
  assert.deepEqual(directApprovals, [codex.name, reviewerName].map(name => `mainDialog.roomWorkspaceApprovalTitle ${name}`))
  assert.deepEqual(directReplies, [
    { speakerName: codex.name, speakerIcon: codex.icon, content: 'Codex finished the draft' },
    { speakerName: reviewerName, speakerIcon: '⌘', content: 'Claude reviewed the evidence' }
  ])
  assert.match(fs.readFileSync(path.join(localWorkspace.path, 'claude-prompt'), 'utf8'), /From Codex CLI:\nReview the direct result/)

  writeCli('codex', `
cat > codex-all-prompt
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Codex is here"}}'
`)
  const broadcastApprovals = []
  const broadcast = await runNativeRoom({
    client, group: await client.getAgentGroup(group.id), agents: [codex], localAgentRegistry: registry,
    messages: [{ role: 'user', content: '@all Check in' }],
    sessionId: 'broadcast-room-stream', localWorkspace,
    requestWorkspaceApproval: async approval => { broadcastApprovals.push(approval.title); return true }
  })
  assert.deepEqual(broadcast.map(reply => reply.speakerName), [codex.name, reviewerName])
  assert.deepEqual(broadcastApprovals.sort(), [codex.name, reviewerName].map(name => `mainDialog.roomWorkspaceApprovalTitle ${name}`).sort())
  assert.match(fs.readFileSync(path.join(localWorkspace.path, 'codex-all-prompt'), 'utf8'), /Check in/)
  assert.match(fs.readFileSync(path.join(localWorkspace.path, 'claude-prompt'), 'utf8'), /Check in/)
})

test('two roles run concurrently on one CLI, keep separate sessions, and leave without losing results', {
  skip: !process.env.WORLDBASE_RUST_HARNESS,
  timeout: 30_000
}, async context => {
  const { root, writeCli, registry } = createFixture(context)
  writeCli('codex', `
prompt=$(cat)
case "$prompt" in
  *'Role: Frontend'*) own=frontend; peer=tester ;;
  *'Role: Tests'*) own=tester; peer=frontend ;;
  *) exit 2 ;;
esac
printf '%s\n' "$prompt" > "$own-prompt"
printf '%s\n' "$@" > "$own-args"
touch "$own-started"
attempts=0
while test ! -f "$peer-started"; do
  attempts=$((attempts + 1))
  test "$attempts" -lt 100 || exit 3
  sleep .03
done
printf '{"type":"thread.started","thread_id":"%s-thread"}\n' "$own"
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s result"}}\n' "$own"
`)
  const client = new RustHarnessClient({ workspace: root, dataDir: path.join(root, 'rust'), onEvent () {} })
  const saved = { localAgentRegistry: mainState.localAgentRegistry, rustHarness: mainState.rustHarness }
  Object.assign(mainState, { localAgentRegistry: registry, rustHarness: client })
  globalThis.__worldbaseRoomSmokeState = mainState
  context.after(() => {
    client.dispose()
    Object.assign(mainState, saved)
    delete globalThis.__worldbaseRoomSmokeState
  })

  const group = await client.saveAgentGroup({ id: 'worker-room', name: 'Worker Room', maxParallelWorkers: 2 })
  const [{ worker: frontend }, { worker: tester }] = await Promise.all([
    inviteRoomLocalWorker('local_cli_codex', group.id, { role: 'Frontend', instructions: 'Only edit UI components.', exitAfterTask: true }),
    inviteRoomLocalWorker('local_cli_codex', group.id, { role: 'Tests', instructions: 'Only write tests.', exitAfterTask: false })
  ])
  assert.notEqual(frontend.id, tester.id)
  const currentGroup = await client.getAgentGroup(group.id)
  assert.deepEqual(new Set(currentGroup.localWorkers.map(worker => worker.id)), new Set([frontend.id, tester.id]))
  assert.deepEqual(await client.listAgents(), [])
  const workspace = await resolveRoomLocalWorkspace(path.join(root, 'app-data'), group.id)
  const { runNativeRoom } = await loadRoomAdapter(root)
  const approvals = []
  const run = (room, text) => runNativeRoom({
    client, group: room, agents: [], localAgentRegistry: registry, localWorkspace: workspace,
    messages: [{ role: 'user', content: text }], sessionId: 'worker-stream',
    requestWorkspaceApproval: async approval => { approvals.push(approval); return true }
  })
  const results = await run(currentGroup, '@all Start your own assignment')
  assert.deepEqual(new Set(results.map(reply => reply.speakerName)), new Set([roomLocalWorkerName(frontend), roomLocalWorkerName(tester)]))
  assert.equal(approvals.length, 2)
  assert.match(fs.readFileSync(path.join(workspace.path, 'frontend-prompt'), 'utf8'), /Only edit UI components/)
  assert.match(fs.readFileSync(path.join(workspace.path, 'tester-prompt'), 'utf8'), /Only write tests/)
  assert.equal(registry.getSession(group.id, frontend.id, workspace.path), null)
  assert.equal(registry.getSession(group.id, tester.id, workspace.path)?.sessionId, 'tester-thread')
  const remaining = await client.getAgentGroup(group.id)
  assert.deepEqual(remaining.localWorkers, [tester])
  const nativeGroupId = `room-${group.id}`
  assert.deepEqual((await client.getNativeGroup(nativeGroupId)).members.map(member => member.agentId), [tester.id])

  assert.deepEqual((await run(remaining, '@all Check your own result')).map(reply => reply.speakerName), [roomLocalWorkerName(tester)])
  const resumedArgs = fs.readFileSync(path.join(workspace.path, 'tester-args'), 'utf8')
  assert.match(resumedArgs, /exec\nresume\n[\s\S]*tester-thread/)
  assert.doesNotMatch(resumedArgs, /frontend-thread/)
  const removed = await removeRoomLocalWorker(group.id, tester.id)
  assert.equal(removed.removed, true)
  assert.deepEqual(removed.group.localWorkers, [])
  assert.equal(registry.getSession(group.id, tester.id, workspace.path), null)
  assert.deepEqual((await client.saveAgentGroup(currentGroup)).localWorkers, [])
  const history = await client.listConversationMessages(`group-${nativeGroupId}`)
  assert.ok(history.some(row => row.content.includes('frontend result')))
  assert.ok(history.some(row => row.content.includes('tester result')))
})

test('clearing or deleting a room drops its app-owned history and CLI session bindings', {
  skip: !process.env.WORLDBASE_RUST_HARNESS,
  timeout: 30_000
}, async context => {
  const { root, writeCli, registry } = createFixture(context)
  writeCli('codex', String.raw`
prompt=$(cat)
printf '%s\n' "$prompt" > latest-prompt
printf '%s\n' "$@" > latest-args
archive=$(printf '%s\n' "$prompt" | sed -n 's/^The shared room message archive is readable at \(.*\/messages\.json\)\. Read.*$/\1/p')
cat "$archive" > latest-archive || exit 4
case "$prompt" in
  *'obsolete-room-marker'*) thread=old-thread ;;
  *) thread=new-thread ;;
esac
printf '{"type":"thread.started","thread_id":"%s"}\n' "$thread"
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Fixture done"}}'
`)
  const options = { workspace: root, dataDir: path.join(root, 'rust'), onEvent () {} }
  const clients = [new RustHarnessClient(options)]
  context.after(() => { for (const client of clients) client.dispose() })
  const original = clients[0]
  const codex = localAgentDefinition(await registry.get('local_cli_codex'))
  const group = await original.saveAgentGroup({ id: 'cleared-room', name: 'Room', coordinatorAgentId: codex.id })
  const other = await original.saveAgentGroup({ id: 'other-room', name: 'Unchanged', coordinatorAgentId: codex.id })
  registry.saveSession(other.id, codex.id, root, 'unrelated-thread')
  const { runNativeRoom, clearNativeRoomContext, deleteNativeRoom } = await loadRoomAdapter(root)
  const workspace = await resolveRoomLocalWorkspace(path.join(root, 'app-data'), group.id)
  const run = (client, text) => runNativeRoom({
    client, group, agents: [codex], localAgentRegistry: registry, localWorkspace: workspace,
    messages: [{ role: 'user', content: text }], sessionId: 'clear-room-stream', requestWorkspaceApproval: async () => true
  })
  await run(original, 'Remember obsolete-room-marker')
  assert.equal(registry.getSession(group.id, codex.id, workspace.path)?.sessionId, 'old-thread')
  const nativeId = nativeRoomId(group)
  await original.injectNativeGroup('clear-room-stream', nativeId, 'obsolete-clarification-marker', [codex.id])
  assert.match(fs.readFileSync(path.join(workspace.path, 'latest-archive'), 'utf8'), /obsolete-room-marker/)

  let updated
  await clearNativeRoomContext(original, group.id, registry, async cleared => { updated = cleared })
  assert.notEqual(nativeRoomId(updated), nativeId)
  assert.equal(updated.coordinatorAgentId, codex.id)
  assert.equal(registry.getSession(group.id, codex.id, workspace.path), null)
  assert.equal(registry.getSession(other.id, codex.id, root)?.sessionId, 'unrelated-thread')
  assert.deepEqual(await original.listConversationMessages(`group-${nativeId}`), [])
  await assert.rejects(original.getNativeGroup(nativeId), /not found/)
  await assert.rejects(original.createNativeGroup({
    logicalGroupId: group.id, sessionId: nativeId, room: true, topic: group.name, mode: 'coordinator_only',
    members: [{ name: codex.name, agentId: codex.id, persona: '', localRuntime: true }]
  }), /room context has changed/)

  original.dispose()
  const reopened = new RustHarnessClient(options)
  clients.push(reopened)
  assert.equal((await reopened.getAgentGroup(group.id)).roomContextId, updated.roomContextId)
  await run(reopened, 'Begin a fresh assignment')
  for (const file of ['latest-prompt', 'latest-archive']) {
    const text = fs.readFileSync(path.join(workspace.path, file), 'utf8')
    assert.match(text, /Begin a fresh assignment/)
    assert.doesNotMatch(text, /obsolete-room-marker|obsolete-clarification-marker/)
  }
  assert.doesNotMatch(fs.readFileSync(path.join(workspace.path, 'latest-args'), 'utf8'), /resume|old-thread/)
  assert.equal(registry.getSession(localRoomSessionKey(updated), codex.id, workspace.path)?.sessionId, 'new-thread')

  const visibleId = 'visible-room-chat'
  await reopened.call('conversation.sync', {
    id: visibleId, title: group.name, messages: [{ role: 'user', content: 'Visible room history' }]
  })
  await reopened.call('memory.save', { entry: {
    id: 'room-only-fact', scopeType: 'user', scopeId: 'local-user', title: 'Room-only fact', summary: 'Remember this in the room',
    sourceConversationId: visibleId
  } })
  let removedVisibleHistory = false
  assert.equal(await deleteNativeRoom(reopened, group.id, registry, async () => {
    removedVisibleHistory = true
    assert.deepEqual(await reopened.listConversationMessages(visibleId), [])
  }, [visibleId]), true)
  assert.equal(removedVisibleHistory, true)
  assert.equal(await reopened.getAgentGroup(group.id), null)
  assert.deepEqual(await reopened.listConversationMessages(`group-${nativeRoomId(updated)}`), [])
  assert.deepEqual((await reopened.call('memory.list', { query: 'Room-only fact' })).entries, [])
  assert.equal(registry.getSession(localRoomSessionKey(updated), codex.id, workspace.path), null)
  assert.equal(registry.getSession(other.id, codex.id, root)?.sessionId, 'unrelated-thread')
  assert.ok(fs.existsSync(path.join(workspace.path, 'latest-archive')))
})
