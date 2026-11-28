<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RoomLocalWorker } from '../../../../shared/local-agent-types'
import { roomLocalWorkerName } from '../../../../shared/local-agent-types'
import type {
  OnlineGroup,
  OnlineGroupDelegation,
  OnlineGroupIdentity,
  OnlineGroupMember
} from '../../../../shared/online-group-types.js'
import type { AgentDefinition, AgentGroupDefinition } from '../panel/types'
import OnlineIdentityCard from './OnlineIdentityCard.vue'
import { countGroupMembers, GROUP_MEMBERS_FOLD_MS, GROUP_MEMBERS_WIDTH } from './group-members-state'

const props = defineProps<{
  group: AgentGroupDefinition
  agents: AgentDefinition[]
  localWorkers?: RoomLocalWorker[]
  onlineGroup?: OnlineGroup | null
  onlineIdentity?: OnlineGroupIdentity | null
  pendingApprovals?: OnlineGroupDelegation[]
  availableAgents?: AgentDefinition[]
  busy?: boolean
  pendingAuthCount?: number
  onlineUserIds?: string[]
  /**
   * Folded away by the title row's member toggle. The panel stays mounted so
   * it can slide back; once folded it takes no pointer or keyboard input.
   */
  collapsed?: boolean
}>()

const emit = defineEmits<{
  (e: 'approve-delegation', delegationId: string): void
  (e: 'reject-delegation', delegationId: string): void
  (e: 'add-agent', agentId: string): void
  (e: 'remove-agent', memberId: string): void
  (e: 'edit-identity'): void
}>()

const { t } = useI18n()
const agentPickerOpen = ref(false)
const AGENT_BRANCH_STORAGE_KEY = 'group-member-agent-branches'
// Key of the local human's fold; online humans fold under their member id.
const LOCAL_BRANCH_KEY = 'local'

function loadCollapsedAgentBranches (): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AGENT_BRANCH_STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => entry[1] === true)
    )
  } catch {
    return {}
  }
}

const collapsedAgentBranches = reactive<Record<string, boolean>>(loadCollapsedAgentBranches())

watch(collapsedAgentBranches, (value) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(AGENT_BRANCH_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Ignore preference persistence failures.
  }
}, { deep: true })

const isOnline = computed(() => Boolean(props.group.online))
const selfPeerId = computed(() => props.group.online?.selfPeerId || props.onlineIdentity?.instanceId || '')

const humanSections = computed(() => {
  const group = props.onlineGroup
  if (!group) return []
  const humans = group.members
    .filter(member => member.kind === 'human')
    .sort((left, right) => {
      const rank = (member: OnlineGroupMember): number => (
        member.peerId === group.ownerPeerId ? 0 : member.peerId === selfPeerId.value ? 1 : 2
      )
      return rank(left) - rank(right)
    })
  return humans.map(human => ({
    human,
    agents: group.members.filter(member => member.kind === 'agent' && member.peerId === human.peerId)
  }))
})

const localAgents = computed(() => {
  if (isOnline.value) return []
  const ids = new Set([props.group.coordinatorAgentId, ...props.group.memberAgentIds].filter(Boolean))
  return [...ids].flatMap(id => props.agents.find(agent => agent.id === id) || [])
})

const localAgentOptions = computed(() => {
  const present = new Set((props.onlineGroup?.members || [])
    .filter(member => member.kind === 'agent' && member.peerId === selfPeerId.value)
    .map(member => member.agentId))
  return (props.availableAgents || props.agents).filter(agent => !present.has(agent.id))
})

// The local human's fold holds the group's own Agents plus its CLI workers.
const localAgentCount = computed(() => (
  localAgents.value.length + (props.localWorkers?.length || 0)
))
const memberCount = computed(() => countGroupMembers(
  props.group,
  props.agents,
  props.localWorkers,
  props.onlineGroup
))

const pendingApprovalCount = computed(() => props.pendingApprovals?.length || 0)
const approvalCount = computed(() => pendingApprovalCount.value + (props.pendingAuthCount || 0))
const onlineUserIds = computed(() => new Set(props.onlineUserIds || []))

const rootEl = ref<HTMLElement | null>(null)
/**
 * Width the sheet is held at while the panel folds or unfolds. At rest it is
 * null and the sheet simply follows the panel, so a narrow window squeezes the
 * list the way it always did: rows truncate, nothing is cut off. During a fold
 * the panel's width is in flight, so the sheet is held at the width the panel
 * rests at, and the content slides under the clip instead of rewrapping.
 */
const sheetWidth = ref<number | null>(null)
let restingWidth = 0
let sheetRelease: ReturnType<typeof setTimeout> | undefined

watch(() => props.collapsed, (collapsed) => {
  // Runs before the DOM takes the new class, so a panel on its way out still
  // has the width it rests at.
  if (collapsed && rootEl.value) restingWidth = rootEl.value.clientWidth
  clearTimeout(sheetRelease)
  sheetWidth.value = restingWidth || GROUP_MEMBERS_WIDTH
  sheetRelease = setTimeout(() => {
    sheetWidth.value = null
    if (!props.collapsed && rootEl.value) restingWidth = rootEl.value.clientWidth
  }, GROUP_MEMBERS_FOLD_MS + 60)
})

onBeforeUnmount(() => clearTimeout(sheetRelease))

watch(localAgentOptions, (options) => {
  if (options.length === 0) agentPickerOpen.value = false
})

function isSelf (member: OnlineGroupMember): boolean {
  return member.peerId === selfPeerId.value && member.kind === 'human'
}

function isGroupOwner (member: OnlineGroupMember): boolean {
  return member.peerId === props.onlineGroup?.ownerPeerId
}

function isOwnAgent (member: OnlineGroupMember): boolean {
  return member.kind === 'agent' && member.peerId === selfPeerId.value
}

function isHumanOnline (member: OnlineGroupMember): boolean {
  return member.peerId === selfPeerId.value || onlineUserIds.value.has(member.peerId)
}

function agentBranchKey (humanId: string): string {
  return `${props.group.id}:${humanId}`
}

function isAgentBranchCollapsed (key: string): boolean {
  return collapsedAgentBranches[key] === true
}

function toggleAgentBranch (key: string): void {
  collapsedAgentBranches[key] = !isAgentBranchCollapsed(key)
}

function latestAgentDelegation (member: OnlineGroupMember): OnlineGroupDelegation | null {
  const delegations = props.onlineGroup?.delegations || []
  return [...delegations]
    .filter(delegation => (
      delegation.toAgentMemberId === member.id
      && delegation.status !== 'completed'
    ))
    .sort((left, right) => (right.updatedAt || right.createdAt).localeCompare(left.updatedAt || left.createdAt))[0] || null
}

function delegationStatusLabel (delegation: OnlineGroupDelegation): string {
  if (delegation.status === 'pending_owner_approval') return t('onlineGroups.delegationStatus.pending_owner_approval')
  if (delegation.status === 'approved' || delegation.status === 'running') return t('onlineGroups.delegationThinking')
  if (delegation.status === 'rejected') return t('onlineGroups.delegationStatus.rejected')
  return t('onlineGroups.delegationStatus.failed')
}

function toggleAgentPicker (): void {
  if (props.busy) return
  agentPickerOpen.value = !agentPickerOpen.value
}

function addAgent (agentId: string): void {
  if (props.busy) return
  emit('add-agent', agentId)
  agentPickerOpen.value = false
}

</script>

<template>
  <aside
    ref="rootEl"
    class="group-members-panel"
    :class="{ collapsed: props.collapsed }"
    :aria-hidden="props.collapsed ? 'true' : undefined"
  >
    <!--
      A sheet inside a clipping shell. The panel no longer has a title bar of
      its own: the chat's title row runs across it, and the fold toggle lives up
      there. While the panel folds, the sheet is held at the width the panel
      rests at, so the content slides under the clip instead of rewrapping;
      at rest it follows the shell, so a narrow window squeezes the list.
    -->
    <div
      class="group-members-inner"
      :style="sheetWidth ? { width: `${sheetWidth}px` } : undefined"
    >
      <div class="group-members-scroll">
        <section class="group-members-section group-member-list-section">
          <div class="group-section-heading">
            <h4>
              {{ $t('onlineGroups.memberPanelTitle') }}
              <span class="group-section-count">{{ memberCount }}</span>
              <span
                v-if="approvalCount"
                class="group-members-alert"
                :title="$t('onlineGroups.approvalPending', { count: approvalCount })"
              >
                <span class="group-members-alert-dot" aria-hidden="true" />
                {{ approvalCount }}
              </span>
            </h4>
            <button
              v-if="onlineGroup"
              class="group-add-agent-toggle"
              type="button"
              :class="{ active: agentPickerOpen }"
              :disabled="busy"
              :aria-expanded="agentPickerOpen"
              :title="$t('onlineGroups.addMyAgent')"
              @click="toggleAgentPicker"
            >
              <span aria-hidden="true">＋</span>
              {{ $t('onlineGroups.addAgentShort') }}
            </button>
          </div>

          <div v-if="onlineGroup && agentPickerOpen" class="group-agent-picker">
            <div class="group-agent-picker-head">
              <strong>{{ $t('onlineGroups.addMyAgent') }}</strong>
              <button type="button" :aria-label="$t('common.close')" @click="agentPickerOpen = false">✕</button>
            </div>
            <p v-if="localAgentOptions.length === 0" class="group-members-empty">{{ $t('onlineGroups.noLocalAgents') }}</p>
            <button
              v-for="agent in localAgentOptions"
              :key="agent.id"
              class="group-agent-picker-item"
              type="button"
              :disabled="busy"
              @click="addAgent(agent.id)"
            >
              <span class="group-member-avatar agent">{{ agent.icon || '🤖' }}</span>
              <span class="group-member-copy">
                <strong>{{ agent.name }}</strong>
                <small>{{ $t('onlineGroups.myAgentHint') }}</small>
              </span>
              <span class="group-agent-picker-add" aria-hidden="true">＋</span>
            </button>
          </div>

          <!--
            Member tree: each human is a card, and pressing the card folds or
            unfolds every Agent that human brought along.
          -->
          <div v-if="onlineGroup" class="group-member-tree">
            <div
              v-for="section in humanSections"
              :key="section.human.id"
              class="group-human-block"
              :class="{ folded: isAgentBranchCollapsed(agentBranchKey(section.human.id)) }"
            >
              <OnlineIdentityCard
                class="group-member-identity"
                compact
                :toggleable="section.agents.length > 0"
                :agent-count="section.agents.length"
                :expanded="!isAgentBranchCollapsed(agentBranchKey(section.human.id))"
                :editable="isSelf(section.human)"
                :profile="{
                  displayName: section.human.peerName,
                  avatar: section.human.avatar,
                  background: section.human.background,
                  tags: section.human.tags
                }"
                :badge="isGroupOwner(section.human) ? $t('onlineGroups.roleOwner') : isSelf(section.human) ? $t('onlineGroups.you') : undefined"
                :badge-kind="isGroupOwner(section.human) ? 'owner' : 'you'"
                :presence="isHumanOnline(section.human) ? 'online' : 'offline'"
                @toggle="toggleAgentBranch(agentBranchKey(section.human.id))"
                @edit="emit('edit-identity')"
              />
              <div
                v-if="section.agents.length && !isAgentBranchCollapsed(agentBranchKey(section.human.id))"
                class="group-agent-branch"
              >
                <div v-for="agent in section.agents" :key="agent.id" class="group-agent-row">
                  <span class="group-member-avatar agent">{{ agent.agentIcon || '🤖' }}</span>
                  <div class="group-member-copy">
                    <strong :title="agent.agentName">{{ agent.agentName || $t('onlineGroups.agentBadge') }}</strong>
                  </div>
                  <span
                    v-if="latestAgentDelegation(agent)"
                    class="group-agent-status"
                    :class="latestAgentDelegation(agent)?.status"
                  >
                    {{ delegationStatusLabel(latestAgentDelegation(agent)!) }}
                  </span>
                  <button v-if="isOwnAgent(agent)" type="button" :disabled="busy" @click="emit('remove-agent', agent.id)">
                    {{ $t('onlineGroups.remove') }}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div v-else-if="!group.online" class="group-member-tree">
            <div class="group-human-block" :class="{ folded: isAgentBranchCollapsed(LOCAL_BRANCH_KEY) }">
              <OnlineIdentityCard
                class="group-member-identity"
                compact
                :toggleable="localAgentCount > 0"
                :agent-count="localAgentCount"
                :expanded="!isAgentBranchCollapsed(LOCAL_BRANCH_KEY)"
                editable
                :profile="{
                  displayName: onlineIdentity?.displayName || $t('onlineGroups.localHumanLabel'),
                  avatar: onlineIdentity?.avatar,
                  background: onlineIdentity?.background,
                  tags: onlineIdentity?.tags
                }"
                :badge="$t('onlineGroups.you')"
                badge-kind="you"
                @toggle="toggleAgentBranch(LOCAL_BRANCH_KEY)"
                @edit="emit('edit-identity')"
              />
              <div v-if="localAgentCount > 0 && !isAgentBranchCollapsed(LOCAL_BRANCH_KEY)" class="group-agent-branch">
                <div v-for="agent in localAgents" :key="agent.id" class="group-agent-row">
                  <span class="group-member-avatar agent">{{ agent.icon || '🤖' }}</span>
                  <div class="group-member-copy">
                    <strong :title="agent.name">{{ agent.name }}</strong>
                  </div>
                </div>
                <div v-for="worker in localWorkers || []" :key="worker.id" class="group-agent-row">
                  <span class="group-member-avatar agent">⌘</span>
                  <div class="group-member-copy">
                    <strong :title="roomLocalWorkerName(worker)">{{ roomLocalWorkerName(worker) }}</strong>
                  </div>
                  <span class="group-agent-kind" :title="worker.kind">{{ worker.kind }}</span>
                </div>
              </div>
            </div>
          </div>
          <p v-else class="group-members-empty">{{ $t('onlineGroups.loading') }}</p>
        </section>

        <section v-if="approvalCount" class="group-members-section group-auth-section">
          <div class="group-section-heading">
            <h4>
              <span class="group-auth-dot" aria-hidden="true" />
              {{ $t('onlineGroups.approvals') }}
            </h4>
            <span class="group-section-count">{{ approvalCount }}</span>
          </div>
          <article v-for="delegation in pendingApprovals" :key="delegation.id" class="group-approval-item">
            <div class="group-approval-route">
              <span>{{ delegation.fromAgentName ? `${delegation.fromAgentName} · ${delegation.fromName}` : delegation.fromName }}</span>
              <span aria-hidden="true">@</span>
              <strong>{{ delegation.toAgentName }}</strong>
            </div>
            <p>{{ delegation.task }}</p>
            <small>{{ $t('onlineGroups.approvalRunsTools') }}</small>
            <div class="group-approval-actions">
              <button type="button" :disabled="busy" @click="emit('reject-delegation', delegation.id)">{{ $t('onlineGroups.reject') }}</button>
              <button class="primary" type="button" :disabled="busy" @click="emit('approve-delegation', delegation.id)">{{ $t('onlineGroups.approveAndRun') }}</button>
            </div>
          </article>
          <p v-if="pendingAuthCount" class="group-members-note">
            {{ $t('onlineGroups.toolApprovalsPending', { count: pendingAuthCount }) }}
          </p>
        </section>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/*
 * Sized by a ceiling rather than a fixed width. The panel is the chat panel's
 * side column, and that column follows this ceiling: it shrinks with a narrow
 * window instead of being cut off, and goes to zero when the panel folds.
 */
.group-members-panel {
  max-width: 292px;
  min-width: 0;
  overflow: hidden;
  /* A hairline that takes no width, so a folded panel is exactly zero wide. */
  box-shadow: -1px 0 0 var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 92%, var(--app-panel-muted));
  color: var(--app-text);
  transition: max-width 0.22s ease, box-shadow 0.22s ease;
}
/*
 * Folded by the title row's member toggle. Visibility flips only after the
 * width is gone, so the sheet neither vanishes mid-slide nor lingers as a
 * clickable sliver.
 */
.group-members-panel.collapsed {
  max-width: 0;
  box-shadow: -1px 0 0 transparent;
  visibility: hidden;
  transition: max-width 0.22s ease, box-shadow 0.22s ease, visibility 0s linear 0.22s;
}
/*
 * The sheet follows the shell, which is as wide as the side column gives it.
 * Only while the panel folds does the script hold it at the resting width.
 */
.group-members-inner {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  width: 100%;
  min-width: 0;
  transition: transform 0.22s ease, opacity 0.18s ease;
}
.group-members-panel.collapsed .group-members-inner {
  transform: translateX(18px);
  opacity: 0;
}
.group-members-alert {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 18px;
  height: 17px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--app-danger-strong, #d33d49);
  color: #fff;
  font-size: 0.61rem;
  font-weight: 750;
}
.group-members-alert-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
}
.group-members-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 20px;
  scrollbar-gutter: stable;
}
.group-members-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 14px;
  margin-bottom: 13px;
  border-bottom: 1px solid var(--app-border);
}
.group-members-section:last-child {
  border-bottom: none;
  margin-bottom: 0;
}
.group-members-section h4 {
  margin: 0;
  font-size: 0.77rem;
  color: var(--app-text);
}
.group-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 25px;
}
.group-section-heading h4 {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.group-section-count {
  min-width: 18px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-faint);
  font-size: 0.62rem;
  text-align: center;
}
.group-auth-section {
  gap: 8px;
  padding: 10px;
  margin-bottom: 14px;
  border: 1px solid color-mix(in srgb, #d69d2e 42%, var(--app-border));
  border-radius: 12px;
  background: color-mix(in srgb, #d69d2e 7%, var(--app-panel));
}
.group-auth-section h4 {
  color: var(--app-text-strong);
}
.group-auth-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--app-danger-strong, #d33d49);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-danger-strong, #d33d49) 12%, transparent);
}
.group-add-agent-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--app-accent-strong) 36%, var(--app-border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent-soft) 44%, transparent);
  color: var(--app-accent-strong);
  cursor: pointer;
  font: inherit;
  font-size: 0.66rem;
  font-weight: 650;
}
.group-add-agent-toggle:hover,
.group-add-agent-toggle.active {
  border-color: var(--app-accent-strong);
  background: var(--app-accent-soft);
}
.group-agent-picker {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid color-mix(in srgb, var(--app-accent-strong) 32%, var(--app-border));
  border-radius: 11px;
  background: color-mix(in srgb, var(--app-panel-muted) 54%, var(--app-panel));
}
.group-agent-picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 1px 2px 3px;
}
.group-agent-picker-head strong {
  font-size: 0.7rem;
}
.group-agent-picker-head button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 21px;
  height: 21px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
  font: inherit;
  font-size: 0.66rem;
}
.group-agent-picker-head button:hover {
  background: var(--app-panel-muted);
  color: var(--app-text);
}
.group-agent-picker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 6px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.group-agent-picker-item:hover {
  border-color: var(--app-border);
  background: var(--app-panel);
}
.group-agent-picker-add {
  margin-left: auto;
  color: var(--app-accent-strong);
  font-size: 0.85rem;
  font-weight: 700;
}
.group-member-tree {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.group-human-block {
  min-width: 0;
}
.group-member-identity {
  width: 100%;
}
/*
 * The Agents hang off their human as one indented block. The hairline is the
 * branch: it starts under the card above and stops short of the last row.
 */
.group-agent-branch {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 5px 0 0 14px;
  padding: 3px 0 3px 9px;
}
.group-agent-branch::before {
  content: '';
  position: absolute;
  top: -5px;
  bottom: 9px;
  left: 0;
  width: 1px;
  background: color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
}
.group-agent-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 30px;
  padding: 3px 5px;
  border-radius: 8px;
}
.group-agent-row:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 72%, transparent);
}
.group-member-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 27px;
  height: 27px;
  flex: 0 0 27px;
  border-radius: 9px;
  background: var(--app-panel-muted);
}
.group-member-avatar.agent {
  width: 23px;
  height: 23px;
  flex-basis: 23px;
  font-size: 0.78rem;
}
.group-member-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.group-agent-picker-item .group-member-copy small {
  overflow: hidden;
  color: var(--app-text-faint);
  font-size: 0.64rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-member-copy strong {
  overflow: hidden;
  font-size: 0.76rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-agent-status {
  flex: 0 0 auto;
  max-width: 88px;
  overflow: hidden;
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent-soft) 72%, transparent);
  color: var(--app-accent-strong);
  font-size: 0.58rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-agent-status.pending_owner_approval {
  background: color-mix(in srgb, var(--app-warning, #b78022) 13%, transparent);
  color: color-mix(in srgb, var(--app-warning, #b78022) 88%, var(--app-text));
}
.group-agent-status.failed,
.group-agent-status.rejected {
  background: color-mix(in srgb, var(--app-danger, #d33d49) 11%, transparent);
  color: var(--app-danger, #d33d49);
}
.group-agent-status.approved,
.group-agent-status.running {
  animation: group-agent-status-pulse 1.7s ease-in-out infinite;
}
@keyframes group-agent-status-pulse {
  0%, 100% { opacity: 0.72; }
  50% { opacity: 1; }
}
.group-agent-kind {
  flex: 0 0 auto;
  max-width: 84px;
  overflow: hidden;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-panel-muted) 80%, transparent);
  color: var(--app-text-faint);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.6rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-agent-row button {
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
  font: inherit;
  font-size: 0.65rem;
}
.group-agent-row button:hover {
  border-color: var(--app-border);
  background: var(--app-panel);
  color: var(--app-text);
}
button:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}
.group-members-note,
.group-members-empty {
  margin: 0;
  color: var(--app-text-muted);
  font-size: 0.7rem;
  line-height: 1.5;
}
.group-approval-item {
  padding: 9px;
  border: 1px solid color-mix(in srgb, #d69d2e 36%, var(--app-border));
  border-radius: 9px;
  background: color-mix(in srgb, var(--app-panel) 82%, transparent);
}
.group-approval-route {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--app-text-muted);
  font-size: 0.7rem;
}
.group-approval-route strong {
  color: var(--app-text-strong);
}
.group-approval-item p {
  margin: 6px 0;
  font-size: 0.72rem;
  line-height: 1.45;
  white-space: pre-wrap;
}
.group-approval-item small {
  color: var(--app-text-faint);
  font-size: 0.62rem;
}
.group-approval-actions {
  display: flex;
  justify-content: flex-end;
  gap: 5px;
  margin-top: 7px;
}
.group-approval-actions button {
  padding: 5px 9px;
  border: 1px solid var(--app-border-strong);
  border-radius: 7px;
  background: var(--app-panel);
  color: var(--app-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 0.68rem;
}
.group-approval-actions button.primary {
  border-color: var(--app-accent-strong);
  background: var(--app-accent-strong);
  color: var(--app-accent-contrast, #fff);
}
</style>
