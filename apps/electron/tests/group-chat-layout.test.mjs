import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { h, ref } from 'vue'
import './register-ts-hooks.mjs'
import { flush, loadSetupComponent, rendererFixture } from './helpers/renderer-fixture.mjs'
import { countGroupMembers, GROUP_MEMBERS_FOLD_MS, GROUP_MEMBERS_WIDTH } from '../src/renderer/components/chat/layout/group-members-state.ts'
import { useDrawerDismiss } from '../src/renderer/components/chat/layout/use-drawer-dismiss.ts'

const layoutUrl = name => new URL(`../src/renderer/components/chat/layout/${name}`, import.meta.url)
const chatPanelUrl = new URL('../src/renderer/components/chat/panel/ChatPanelContainer.vue', import.meta.url)
const GroupMembersPanel = await loadSetupComponent(layoutUrl('GroupMembersPanel.vue'))

function cssRule (source, selector) {
  const start = source.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `missing CSS rule ${selector}`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++
    if (source[index] === '}') {
      depth--
      if (depth === 0) return source.slice(bodyStart + 1, index)
    }
  }
  throw new Error(`unterminated CSS rule ${selector}`)
}

const localGroup = {
  id: 'room',
  name: 'Product room',
  coordinatorAgentId: 'planner',
  memberAgentIds: ['planner', 'reviewer', 'not-installed'],
  localWorkers: []
}
const localAgents = [
  { id: 'planner', name: 'Planner' },
  { id: 'reviewer', name: 'Reviewer' },
  { id: 'outsider', name: 'Belongs to another group' }
]

test('the member headcount counts each human, known Agent and CLI worker once', () => {
  // The local human, plus the two group Agents that exist (the coordinator is
  // listed twice and one member id has no Agent).
  assert.equal(countGroupMembers(localGroup, localAgents, undefined, null), 3)
  assert.equal(countGroupMembers(localGroup, localAgents, [{ id: 'w1' }, { id: 'w2' }], undefined), 5)
  // An online group knows its whole roster already.
  assert.equal(countGroupMembers(localGroup, localAgents, [], { members: [{}, {}, {}, {}] }), 4)
})

test('the member panel takes a fold state and reports the shared headcount', async t => {
  const fixture = rendererFixture(t)
  const { props, state } = fixture.mount(GroupMembersPanel, {
    group: localGroup,
    agents: localAgents,
    localWorkers: [{ id: 'w1', kind: 'codex', role: 'Reviewer', exitAfterTask: false }],
    collapsed: true
  })
  await flush()

  assert.equal(props.collapsed, true)
  assert.equal(state.memberCount, 4)
  assert.equal(state.localAgentCount, 3)
  assert.equal(state.isAgentBranchCollapsed('room:local'), false)
  state.toggleAgentBranch('room:local')
  assert.equal(state.isAgentBranchCollapsed('room:local'), true)
})

test('the title row spans the member list and the settings drawer stays under it', async () => {
  const [chatPanel, chatHeader] = await Promise.all([
    readFile(chatPanelUrl, 'utf8'),
    readFile(layoutUrl('ChatHeader.vue'), 'utf8')
  ])

  // Two rows: the title on top, conversation and member list side by side.
  const panel = cssRule(chatPanel, '.chat-panel')
  assert.match(panel, /display:\s*grid/)
  assert.match(panel, /grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/)
  assert.match(cssRule(chatPanel, '.chat-panel-title'), /grid-row:\s*1/)
  assert.match(cssRule(chatPanel, '.chat-panel-title'), /grid-column:\s*1\s*\/\s*-1/)
  assert.match(cssRule(chatPanel, '.chat-panel-members'), /grid-row:\s*2/)
  assert.match(cssRule(chatPanel, '.chat-main'), /grid-row:\s*2/)
  assert.ok(
    chatPanel.indexOf('class="chat-panel-title"') < chatPanel.indexOf('class="chat-main"'),
    'the title row is a child of the panel, not of the conversation column'
  )
  // The workspace keeps its own tab strip beside the title row.
  assert.match(cssRule(chatPanel, '.chat-panel-with-workspace .chat-panel-title'), /grid-column:\s*1/)
  assert.match(cssRule(chatPanel, '.chat-panel-workspace'), /grid-row:\s*1\s*\/\s*-1/)

  // Three-dot button and a fold toggle that hides until the member list is hovered.
  assert.match(chatHeader, /class="header-group-action header-group-more"/)
  assert.match(chatHeader, /<SidebarIcon name="more"/)
  assert.doesNotMatch(chatHeader, /header-group-settings/)
  assert.match(cssRule(chatHeader, '.header-group-members'), /opacity:\s*0/)
  assert.match(chatHeader, /\.header-group-members\.revealed/)
  assert.ok(chatHeader.indexOf('class="header-group-action header-group-more"') > chatHeader.indexOf('class="header-model-picker"'), 'the three-dot button is the last control on the right')
})

test('the member list has no title bar of its own and folds through the human cards', async () => {
  const [members, identityCard] = await Promise.all([
    readFile(layoutUrl('GroupMembersPanel.vue'), 'utf8'),
    readFile(layoutUrl('OnlineIdentityCard.vue'), 'utf8')
  ])

  // The chat title row runs across the panel, so its own "群成员" bar is gone.
  assert.doesNotMatch(members, /group-members-head\b/)
  // One toggle per human: the card itself, not a separate branch row.
  assert.doesNotMatch(members, /group-agent-branch-toggle/)
  assert.match(members, /:toggleable="section\.agents\.length > 0"/)
  assert.match(members, /@toggle="toggleAgentBranch\(agentBranchKey\(section\.human\.id\)\)"/)
  assert.match(members, /:toggleable="localAgentCount > 0"/)
  // The fold slides instead of rewrapping, then stops taking input. At rest the
  // sheet follows the shell, so a narrow window squeezes the list; only while
  // the panel folds is it held at the width the shell rests at.
  assert.match(cssRule(members, '.group-members-panel.collapsed'), /visibility:\s*hidden/)
  assert.match(cssRule(members, '.group-members-inner'), /width:\s*100%/)
  assert.match(members, /:style="sheetWidth \? \{ width: `\$\{sheetWidth\}px` \} : undefined"/)
  // A hairline that takes no width: the folded panel is exactly zero wide.
  assert.doesNotMatch(cssRule(members, '.group-members-panel'), /border-left/)

  // On a fold trigger the pencil edits the identity on its own; a click
  // anywhere else on the card folds, and the avatar and name are plain text.
  assert.match(identityCard, /@click\.stop="emit\('edit'\)"/)
  assert.match(identityCard, /:is="editOnClick \? 'button' : 'span'"/)
  assert.match(identityCard, /@keydown\.enter\.self\.prevent="props\.toggleable && emit\('toggle'\)"/)
})

test('the member sheet is held at the resting width only while the panel folds', async t => {
  const fixture = rendererFixture(t)
  const collapsed = ref(false)
  const panel = ref(null)
  fixture.mount({
    render: () => h(GroupMembersPanel, {
      ref: panel,
      group: localGroup,
      agents: localAgents,
      localWorkers: [],
      collapsed: collapsed.value
    })
  }, {})
  await flush()
  const state = panel.value.$.setupState
  assert.equal(state.sheetWidth, null, 'at rest the sheet follows the panel')

  // A panel squeezed to 279px by a 1200px window is read before the DOM folds it,
  // so its rows slide under the clip instead of rewrapping on the way out.
  state.rootEl = { clientWidth: 279 }
  collapsed.value = true
  await flush()
  assert.equal(state.sheetWidth, 279, 'while folding, the sheet keeps the width the panel rests at')

  collapsed.value = false
  await flush()
  assert.equal(state.sheetWidth, 279, 'while unfolding, the sheet is held at the same width')

  await new Promise(resolve => setTimeout(resolve, GROUP_MEMBERS_FOLD_MS + 90))
  assert.equal(state.sheetWidth, null, 'once the fold is over, the sheet follows the panel again')

  // Folded from the moment it mounts (a remembered preference), the panel has
  // never been measured, so the sheet opens at the natural width.
  const fresh = ref(null)
  const expanded = ref(false)
  fixture.mount({
    render: () => h(GroupMembersPanel, {
      ref: fresh, group: localGroup, agents: localAgents, localWorkers: [], collapsed: !expanded.value
    })
  }, {})
  await flush()
  expanded.value = true
  await flush()
  assert.equal(fresh.value.$.setupState.sheetWidth, GROUP_MEMBERS_WIDTH, 'the first unfold slides at the natural width')
})

test('a drawer closes on Escape and on a press that starts and ends outside it', async t => {
  const fixture = rendererFixture(t)
  const originalNode = globalThis.Node
  globalThis.Node = class FakeNode {}
  t.after(() => {
    if (originalNode === undefined) delete globalThis.Node
    else globalThis.Node = originalNode
  })

  const inside = new globalThis.Node()
  const outside = new globalThis.Node()
  const open = ref(true)
  const dismissals = []
  const root = { contains: target => target === inside }
  fixture.mount({
    setup () {
      useDrawerDismiss(ref(root), () => open.value, () => dismissals.push('dismissed'))
      return () => null
    }
  })
  const press = (startsAt, endsAt) => {
    fixture.document.dispatchEvent({ type: 'pointerdown', target: startsAt })
    fixture.document.dispatchEvent({ type: 'click', target: endsAt })
  }
  const key = (keyName) => fixture.document.dispatchEvent({ type: 'keydown', key: keyName })

  press(outside, outside)
  assert.equal(dismissals.length, 1, 'clicking beside the drawer closes it')
  // A selection that begins in the drawer and is released beside it must not
  // read as an outside click.
  press(inside, outside)
  press(inside, inside)
  key('Enter')
  assert.equal(dismissals.length, 1, 'presses that begin inside the drawer leave it open')
  key('Escape')
  assert.equal(dismissals.length, 2, 'Escape closes the drawer')

  open.value = false
  press(outside, outside)
  key('Escape')
  assert.equal(dismissals.length, 2, 'nothing happens while the drawer is closed')
})
