<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  LanDiscoveredPeer,
  OnlineGroup,
  OnlineGroupBackground,
  OnlineGroupIdentity,
  OnlineGroupInboxItem,
  OnlineGroupState
} from '../../../../shared/online-group-types.js'
import OnlineIdentityCard from './OnlineIdentityCard.vue'
import {
  ONLINE_GROUP_AVATARS,
  ONLINE_GROUP_BACKGROUNDS,
  ONLINE_GROUP_TAG_PRESETS,
  onlineGroupBackgroundGradient
} from './online-group-profile'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'openGroup', groupId: string): void
}>()

const { t } = useI18n()
const api = window.electronAPI!
type TabKey = 'discover' | 'groups' | 'inbox'

const state = ref<OnlineGroupState | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const activeTab = ref<TabKey>('discover')
const selectedPeerIds = ref<string[]>([])
const inviteTargetGroupId = ref('')
const identityEditorOpen = ref(false)
const tagDraft = ref('')

const identityForm = reactive({
  displayName: '',
  avatar: '',
  background: 'aurora' as OnlineGroupBackground,
  tags: [] as string[],
  discoveryEnabled: false,
  advertiseGroups: true
})

const createForm = reactive({
  name: '',
  icon: '🌐',
  description: ''
})

let pollTimer: ReturnType<typeof setInterval> | null = null
let changeCleanup: (() => void) | null = null

const identity = computed<OnlineGroupIdentity | null>(() => state.value?.identity || null)
const peers = computed(() => (state.value?.discovery.peers || []).filter(peer => peer.instanceId !== identity.value?.instanceId))
const groups = computed(() => state.value?.groups || [])
const manageableGroups = computed(() => groups.value.filter(canManageGroup))
const pendingInvitations = computed(() => (state.value?.inbox || []).filter(item => (
  item.type === 'invitation' && item.direction === 'incoming' && item.status === 'pending'
)))
const pendingJoinRequests = computed(() => (state.value?.inbox || []).filter(item => (
  item.type === 'join-request' && item.direction === 'incoming' && item.status === 'pending'
)))
const outgoingJoinRequests = computed(() => (state.value?.inbox || []).filter(item => (
  item.type === 'join-request' && item.direction === 'outgoing' && item.status === 'pending'
)))
const inboxCount = computed(() => pendingInvitations.value.length + pendingJoinRequests.value.length)
const inviteTargetGroup = computed(() => groups.value.find(group => group.id === inviteTargetGroupId.value) || null)

function setNotice (value: string): void {
  notice.value = value
  window.setTimeout(() => {
    if (notice.value === value) notice.value = ''
  }, 4500)
}

function errorMessage (value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function syncIdentity (): void {
  if (!state.value || identityEditorOpen.value) return
  identityForm.displayName = state.value.identity.displayName
  identityForm.avatar = state.value.identity.avatar || ''
  identityForm.background = state.value.identity.background || 'aurora'
  identityForm.tags = [...(state.value.identity.tags || [])]
  identityForm.discoveryEnabled = state.value.identity.discoveryEnabled
  identityForm.advertiseGroups = state.value.identity.advertiseGroups
}

async function loadState (quiet = false): Promise<void> {
  if (!props.open) return
  if (!quiet) loading.value = true
  try {
    state.value = await api.getOnlineGroupState()
    syncIdentity()
    if (!inviteTargetGroupId.value || !manageableGroups.value.some(group => group.id === inviteTargetGroupId.value)) {
      inviteTargetGroupId.value = manageableGroups.value[0]?.id || ''
    }
    error.value = ''
  } catch (caught) {
    if (!quiet) error.value = errorMessage(caught)
  } finally {
    if (!quiet) loading.value = false
  }
}

async function saveIdentity (): Promise<void> {
  if (busy.value) return
  if (!identityForm.displayName.trim()) {
    error.value = t('onlineGroups.nameRequired')
    return
  }
  busy.value = true
  error.value = ''
  try {
    state.value = await api.saveOnlineGroupIdentity({
      displayName: identityForm.displayName,
      avatar: identityForm.avatar,
      background: identityForm.background,
      tags: [...identityForm.tags],
      discoveryEnabled: identityForm.discoveryEnabled,
      advertiseGroups: identityForm.advertiseGroups
    })
    syncIdentity()
    setNotice(identityForm.discoveryEnabled ? t('onlineGroups.discoveryStarted') : t('onlineGroups.identitySaved'))
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

function openIdentityEditor (): void {
  if (!identity.value) return
  identityForm.displayName = identity.value.displayName
  identityForm.avatar = identity.value.avatar || ''
  identityForm.background = identity.value.background || 'aurora'
  identityForm.tags = [...(identity.value.tags || [])]
  tagDraft.value = ''
  identityEditorOpen.value = true
}

async function saveIdentityEditor (): Promise<void> {
  await saveIdentity()
  if (!error.value) identityEditorOpen.value = false
}

function cancelIdentityEditor (): void {
  identityEditorOpen.value = false
  syncIdentity()
}

function toggleTag (tag: string): void {
  identityForm.tags = identityForm.tags.includes(tag)
    ? identityForm.tags.filter(item => item !== tag)
    : [...identityForm.tags, tag].slice(0, 6)
}

function addTag (): void {
  const tag = tagDraft.value.trim().slice(0, 16)
  if (!tag) return
  if (!identityForm.tags.includes(tag)) identityForm.tags = [...identityForm.tags, tag].slice(0, 6)
  tagDraft.value = ''
}

async function startDiscovery (): Promise<void> {
  identityForm.discoveryEnabled = true
  await saveIdentity()
}

async function stopDiscovery (): Promise<void> {
  identityForm.discoveryEnabled = false
  await saveIdentity()
}

async function refresh (): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    state.value = await api.refreshOnlineGroups()
    syncIdentity()
    setNotice(t('onlineGroups.refreshed'))
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

function togglePeer (peerId: string): void {
  selectedPeerIds.value = selectedPeerIds.value.includes(peerId)
    ? selectedPeerIds.value.filter(id => id !== peerId)
    : [...selectedPeerIds.value, peerId]
}

function openGroup (group: OnlineGroup): void {
  emit('openGroup', group.id)
  emit('close')
}

async function createGroup (): Promise<void> {
  if (busy.value) return
  if (!createForm.name.trim()) {
    error.value = t('onlineGroups.nameRequired')
    return
  }
  busy.value = true
  try {
    const group = await api.createOnlineGroup({
      name: createForm.name.trim(),
      icon: createForm.icon.trim() || '🌐',
      description: createForm.description.trim()
    })
    const invitedPeers = [...selectedPeerIds.value]
    if (invitedPeers.length > 0) {
      const result = await api.inviteOnlineGroupPeers(group.id, invitedPeers)
      if (result.errors.length > 0) error.value = result.errors.join('\n')
    }
    createForm.name = ''
    createForm.description = ''
    selectedPeerIds.value = []
    await loadState(true)
    openGroup(group)
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function inviteSelectedToGroup (): Promise<void> {
  const group = inviteTargetGroup.value
  if (!group || selectedPeerIds.value.length === 0 || busy.value) return
  busy.value = true
  try {
    const result = await api.inviteOnlineGroupPeers(group.id, selectedPeerIds.value)
    if (result.errors.length > 0) error.value = result.errors.join('\n')
    else setNotice(t('onlineGroups.inviteSent', { count: result.invited }))
    selectedPeerIds.value = []
    await loadState(true)
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function requestJoin (peer: LanDiscoveredPeer, groupId: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await api.requestJoinOnlineGroup(peer.instanceId, groupId)
    await loadState(true)
    setNotice(t('onlineGroups.joinRequested'))
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function acceptInvitation (item: OnlineGroupInboxItem): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const group = await api.acceptOnlineGroupInvitation(item.id)
    await loadState(true)
    openGroup(group)
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function declineInvitation (item: OnlineGroupInboxItem): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    state.value = await api.declineOnlineGroupInvitation(item.id)
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function decideJoinRequest (item: OnlineGroupInboxItem, approved: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    state.value = await api.decideOnlineGroupJoinRequest(item.id, approved)
    setNotice(approved ? t('onlineGroups.joinApproved') : t('onlineGroups.joinRejected'))
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

function canManageGroup (group: OnlineGroup): boolean {
  return group.ownerPeerId === identity.value?.instanceId || group.accessRole === 'admin'
}

function humanCount (group: OnlineGroup): number {
  return group.members.filter(member => member.kind === 'human').length
}

function agentCount (group: OnlineGroup): number {
  return group.members.filter(member => member.kind === 'agent').length
}

function groupOwnerProfile (group: OnlineGroup): {
  displayName: string
  avatar?: string
  background?: OnlineGroupBackground
  tags?: string[]
} {
  const owner = group.members.find(member => member.kind === 'human' && member.peerId === group.ownerPeerId)
  return {
    displayName: group.ownerName || owner?.peerName || '',
    avatar: owner?.avatar,
    background: owner?.background,
    tags: owner?.tags
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      void loadState()
      pollTimer = setInterval(() => { void loadState(true) }, 4000)
      changeCleanup?.()
      changeCleanup = api.onOnlineGroupsChanged?.(() => { void loadState(true) }) || null
    } else {
      identityEditorOpen.value = false
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
      changeCleanup?.()
      changeCleanup = null
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  changeCleanup?.()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="online-groups-backdrop" @click.self="emit('close')">
      <section class="online-groups-dialog" role="dialog" :aria-label="$t('onlineGroups.title')">
        <header class="online-groups-header">
          <div class="online-groups-heading">
            <span class="online-groups-logo" aria-hidden="true">◎</span>
            <h2>{{ $t('onlineGroups.title') }}</h2>
          </div>
          <button class="online-groups-close" type="button" :aria-label="$t('common.close')" @click="emit('close')">
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        <div class="online-profile-strip">
          <OnlineIdentityCard
            :profile="{
              displayName: identityForm.displayName || $t('onlineGroups.displayName'),
              avatar: identityForm.avatar,
              background: identityForm.background,
              tags: identityForm.tags
            }"
            editable
            @edit="openIdentityEditor"
          />
          <div class="online-profile-controls">
            <label class="online-checkbox">
              <input v-model="identityForm.advertiseGroups" type="checkbox" @change="saveIdentity" />
              <span>{{ $t('onlineGroups.advertiseGroups') }}</span>
            </label>
            <div class="online-identity-actions">
              <button v-if="!identity?.discoveryEnabled" class="online-btn accent" type="button" :disabled="busy" @click="startDiscovery">
                {{ $t('onlineGroups.startDiscovery') }}
              </button>
              <button v-else class="online-btn" type="button" :disabled="busy" @click="stopDiscovery">
                {{ $t('onlineGroups.stopDiscovery') }}
              </button>
            </div>
          </div>
        </div>

        <div v-if="identityEditorOpen" class="online-identity-editor-backdrop" @click.self="cancelIdentityEditor">
          <section class="online-identity-editor" role="dialog" :aria-label="$t('onlineGroups.editIdentity')">
            <header>
              <strong>{{ $t('onlineGroups.editIdentity') }}</strong>
              <button type="button" :aria-label="$t('common.close')" @click="cancelIdentityEditor">✕</button>
            </header>
            <label class="online-field">
              <span>{{ $t('onlineGroups.displayName') }}</span>
              <input v-model="identityForm.displayName" maxlength="80" />
            </label>
            <div class="online-field">
              <span>{{ $t('onlineGroups.avatar') }}</span>
              <div class="online-avatar-options">
                <button
                  v-for="avatar in ONLINE_GROUP_AVATARS"
                  :key="avatar"
                  type="button"
                  :class="{ active: identityForm.avatar === avatar }"
                  @click="identityForm.avatar = avatar"
                >{{ avatar }}</button>
                <input v-model="identityForm.avatar" maxlength="8" :placeholder="$t('onlineGroups.customAvatar')" />
              </div>
            </div>
            <div class="online-field">
              <span>{{ $t('onlineGroups.background') }}</span>
              <div class="online-background-options">
                <button
                  v-for="item in ONLINE_GROUP_BACKGROUNDS"
                  :key="item.id"
                  type="button"
                  :class="{ active: identityForm.background === item.id }"
                  :style="{ background: onlineGroupBackgroundGradient(item.id) }"
                  :title="item.label"
                  @click="identityForm.background = item.id"
                />
              </div>
            </div>
            <div class="online-field">
              <span>{{ $t('onlineGroups.tags') }}</span>
              <div class="online-tag-options">
                <button
                  v-for="tag in ONLINE_GROUP_TAG_PRESETS"
                  :key="tag"
                  type="button"
                  :class="{ active: identityForm.tags.includes(tag) }"
                  @click="toggleTag(tag)"
                >{{ tag }}</button>
              </div>
              <div class="online-tag-custom">
                <input
                  v-model="tagDraft"
                  maxlength="16"
                  :placeholder="$t('onlineGroups.tagPlaceholder')"
                  @keydown.enter.prevent="addTag"
                />
                <button type="button" :disabled="!tagDraft.trim()" @click="addTag">＋</button>
              </div>
              <div v-if="identityForm.tags.length" class="online-tag-selected">
                <button v-for="tag in identityForm.tags" :key="tag" type="button" @click="toggleTag(tag)">
                  {{ tag }} <span aria-hidden="true">×</span>
                </button>
              </div>
            </div>
            <footer>
              <button class="online-btn" type="button" @click="cancelIdentityEditor">{{ $t('common.cancel') }}</button>
              <button class="online-btn primary" type="button" :disabled="busy" @click="saveIdentityEditor">{{ $t('common.save') }}</button>
            </footer>
          </section>
        </div>

        <div v-if="error" class="online-banner error">
          <span>{{ error }}</span>
          <button type="button" @click="error = ''">✕</button>
        </div>
        <div v-else-if="notice" class="online-banner notice">{{ notice }}</div>

        <nav class="online-tabs" role="tablist">
          <button type="button" :class="{ active: activeTab === 'discover' }" @click="activeTab = 'discover'">
            {{ $t('onlineGroups.tabDiscover') }}<span class="online-tab-count">{{ peers.length }}</span>
          </button>
          <button type="button" :class="{ active: activeTab === 'groups' }" @click="activeTab = 'groups'">
            {{ $t('onlineGroups.tabGroups') }}<span class="online-tab-count">{{ groups.length }}</span>
          </button>
          <button type="button" :class="{ active: activeTab === 'inbox' }" @click="activeTab = 'inbox'">
            {{ $t('onlineGroups.tabInbox') }}<span v-if="inboxCount" class="online-tab-badge">{{ inboxCount }}</span>
          </button>
        </nav>

        <div v-if="loading" class="online-loading">{{ $t('onlineGroups.loading') }}</div>

        <main v-else class="online-content">
          <section v-if="activeTab === 'discover'" class="online-discover">
            <div class="online-status-card">
              <div class="online-status-copy">
                <span class="online-status-dot" :class="{ live: state?.discovery.running }" />
                <strong>{{ state?.discovery.running ? $t('onlineGroups.statusDiscovering') : $t('onlineGroups.statusIdle') }}</strong>
                <small>
                  {{ $t('onlineGroups.statusDetail', {
                    count: peers.length,
                    address: state?.localAddresses?.[0] || $t('onlineGroups.noLanAddress'),
                    port: state?.serverPort || 19527
                  }) }}
                </small>
              </div>
              <div class="online-status-meta">
                <span>{{ $t('onlineGroups.multicast', { address: state?.discovery.multicastAddress || '239.255.76.87' }) }}</span>
                <button class="online-btn small" type="button" :disabled="busy" @click="refresh">{{ $t('onlineGroups.refresh') }}</button>
              </div>
            </div>
            <p v-if="state?.discovery.error" class="online-status-error">{{ state.discovery.error }}</p>

            <div class="online-discover-grid">
              <section class="online-panel">
                <h3>{{ $t('onlineGroups.createTitle') }}</h3>
                <div class="online-form-grid">
                  <label class="online-field icon">
                    <span>{{ $t('onlineGroups.icon') }}</span>
                    <input v-model="createForm.icon" maxlength="8" />
                  </label>
                  <label class="online-field grow">
                    <span>{{ $t('onlineGroups.groupName') }}</span>
                    <input v-model="createForm.name" maxlength="80" :placeholder="$t('onlineGroups.groupNamePlaceholder')" />
                  </label>
                </div>
                <label class="online-field">
                  <span>{{ $t('onlineGroups.description') }}</span>
                  <textarea v-model="createForm.description" rows="2" maxlength="1000" />
                </label>
                <div class="online-selected-peers">
                  <span>{{ $t('onlineGroups.selectedPeers', { count: selectedPeerIds.length }) }}</span>
                  <button class="online-link" type="button" :disabled="selectedPeerIds.length === 0" @click="selectedPeerIds = []">
                    {{ $t('onlineGroups.clearSelection') }}
                  </button>
                </div>
                <button class="online-btn primary wide" type="button" :disabled="busy || !createForm.name.trim()" @click="createGroup">
                  {{ $t('onlineGroups.createGroup') }}
                </button>

                <div v-if="manageableGroups.length > 0" class="online-invite-existing">
                  <h4>{{ $t('onlineGroups.inviteToExisting') }}</h4>
                  <select v-model="inviteTargetGroupId">
                    <option v-for="group in manageableGroups" :key="group.id" :value="group.id">
                      {{ group.icon || '🌐' }} {{ group.name }}
                    </option>
                  </select>
                  <button
                    class="online-btn wide"
                    type="button"
                    :disabled="busy || !inviteTargetGroup || !canManageGroup(inviteTargetGroup) || selectedPeerIds.length === 0"
                    @click="inviteSelectedToGroup"
                  >
                    {{ $t('onlineGroups.inviteSelected', { count: selectedPeerIds.length }) }}
                  </button>
                </div>
              </section>

              <section class="online-panel">
                <div class="online-panel-title-row">
                  <h3>{{ $t('onlineGroups.peersTitle') }}</h3>
                  <span class="online-panel-count">{{ peers.length }}</span>
                </div>
                <div v-if="peers.length === 0" class="online-empty">
                  <span>◎</span>
                  <strong>{{ $t('onlineGroups.noPeers') }}</strong>
                  <p>{{ $t('onlineGroups.noPeersHint') }}</p>
                  <button v-if="!identity?.discoveryEnabled" class="online-btn accent" type="button" :disabled="busy" @click="startDiscovery">
                    {{ $t('onlineGroups.startDiscovery') }}
                  </button>
                </div>
                <div v-else class="online-peer-list">
                  <article v-for="peer in peers" :key="peer.instanceId" class="online-peer-card" :class="{ selected: selectedPeerIds.includes(peer.instanceId) }">
                    <button class="online-peer-select" type="button" @click="togglePeer(peer.instanceId)">
                      <OnlineIdentityCard
                        compact
                        :profile="{
                          displayName: peer.displayName,
                          avatar: peer.avatar,
                          background: peer.background,
                          tags: peer.tags
                        }"
                      />
                      <span class="online-peer-check" aria-hidden="true">{{ selectedPeerIds.includes(peer.instanceId) ? '✓' : '' }}</span>
                    </button>
                    <div class="online-peer-meta">{{ peer.address }} · v{{ peer.appVersion || '?' }}</div>
                    <div v-if="peer.groups.length > 0" class="online-peer-groups">
                      <div v-for="group in peer.groups" :key="group.id" class="online-peer-group-row">
                        <span>{{ group.icon || '🌐' }} {{ group.name }}</span>
                        <small>{{ $t('onlineGroups.memberCount', { count: group.memberCount }) }}</small>
                        <button class="online-link" type="button" :disabled="busy" @click="requestJoin(peer, group.id)">
                          {{ $t('onlineGroups.requestJoin') }}
                        </button>
                      </div>
                    </div>
                  </article>
                </div>
              </section>
            </div>
          </section>

          <section v-else-if="activeTab === 'groups'" class="online-groups-tab">
            <div v-if="groups.length === 0" class="online-empty">
              <span>🌐</span>
              <strong>{{ $t('onlineGroups.noGroups') }}</strong>
              <p>{{ $t('onlineGroups.noGroupsHint') }}</p>
              <button class="online-btn accent" type="button" @click="activeTab = 'discover'">{{ $t('onlineGroups.findPeers') }}</button>
            </div>
            <div v-else class="online-group-card-grid">
              <article v-for="group in groups" :key="group.id" class="online-group-card">
                <header>
                  <span class="online-group-icon">{{ group.icon || '🌐' }}</span>
                  <div>
                    <strong>{{ group.name }}</strong>
                  </div>
                </header>
                <OnlineIdentityCard compact :profile="groupOwnerProfile(group)" />
                <p>{{ group.description || $t('onlineGroups.noDescription') }}</p>
                <div class="online-group-stats">
                  <span>{{ $t('onlineGroups.humanCount', { count: humanCount(group) }) }}</span>
                  <span>{{ $t('onlineGroups.agentCount', { count: agentCount(group) }) }}</span>
                </div>
                <footer>
                  <button class="online-btn primary" type="button" @click="openGroup(group)">{{ $t('onlineGroups.openChat') }}</button>
                  <button
                    v-if="canManageGroup(group)"
                    class="online-btn"
                    type="button"
                    @click="inviteTargetGroupId = group.id; activeTab = 'discover'"
                  >
                    {{ $t('onlineGroups.inviteMembers') }}
                  </button>
                </footer>
              </article>
            </div>
          </section>

          <section v-else class="online-inbox">
            <div class="online-panel">
              <h3>{{ $t('onlineGroups.pendingInvitations') }}</h3>
              <p v-if="pendingInvitations.length === 0" class="online-empty-inline">{{ $t('onlineGroups.noInvitations') }}</p>
              <article v-for="item in pendingInvitations" :key="item.id" class="online-inbox-card">
                <OnlineIdentityCard
                  class="online-inbox-identity"
                  compact
                  :profile="{
                    displayName: item.fromName,
                    avatar: item.fromAvatar,
                    background: item.fromBackground,
                    tags: item.fromTags
                  }"
                />
                <div class="online-inbox-copy">
                  <strong><span aria-hidden="true">{{ item.groupIcon || '🌐' }}</span> {{ item.groupName }}</strong>
                  <p>{{ item.groupDescription || $t('onlineGroups.noDescription') }}</p>
                </div>
                <div class="online-inbox-actions">
                  <button class="online-btn small" type="button" :disabled="busy" @click="declineInvitation(item)">{{ $t('onlineGroups.decline') }}</button>
                  <button class="online-btn small accent" type="button" :disabled="busy" @click="acceptInvitation(item)">{{ $t('onlineGroups.accept') }}</button>
                </div>
              </article>
            </div>

            <div class="online-panel">
              <h3>{{ $t('onlineGroups.pendingJoinRequests') }}</h3>
              <p v-if="pendingJoinRequests.length === 0" class="online-empty-inline">{{ $t('onlineGroups.noJoinRequests') }}</p>
              <article v-for="item in pendingJoinRequests" :key="item.id" class="online-inbox-card">
                <OnlineIdentityCard
                  class="online-inbox-identity"
                  compact
                  :profile="{
                    displayName: item.fromName,
                    avatar: item.fromAvatar,
                    background: item.fromBackground,
                    tags: item.fromTags
                  }"
                />
                <div class="online-inbox-copy">
                  <strong><span aria-hidden="true">{{ item.groupIcon || '🌐' }}</span> {{ item.groupName }}</strong>
                </div>
                <div class="online-inbox-actions">
                  <button class="online-btn small" type="button" :disabled="busy" @click="decideJoinRequest(item, false)">{{ $t('onlineGroups.reject') }}</button>
                  <button class="online-btn small accent" type="button" :disabled="busy" @click="decideJoinRequest(item, true)">{{ $t('onlineGroups.approve') }}</button>
                </div>
              </article>
            </div>

            <div v-if="outgoingJoinRequests.length > 0" class="online-panel">
              <h3>{{ $t('onlineGroups.outgoingRequests') }}</h3>
              <article v-for="item in outgoingJoinRequests" :key="item.id" class="online-inbox-card">
                <span class="online-group-icon">{{ item.groupIcon || '🌐' }}</span>
                <div class="online-inbox-copy">
                  <strong>{{ item.groupName }}</strong>
                  <small>{{ item.fromName }} · {{ $t('onlineGroups.waitingOwner') }}</small>
                </div>
              </article>
            </div>
          </section>
        </main>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.online-groups-backdrop {
  position: fixed;
  inset: 0;
  z-index: 12000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(11, 18, 28, 0.56);
  backdrop-filter: blur(6px);
}
.online-groups-dialog {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(980px, 95vw);
  height: min(760px, 90vh);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-border-strong) 72%, transparent);
  border-radius: 20px;
  background:
    radial-gradient(circle at 12% 0%, color-mix(in srgb, var(--app-accent-soft) 60%, transparent), transparent 36%),
    var(--app-panel);
  box-shadow: 0 28px 90px rgba(6, 15, 26, 0.42);
  color: var(--app-text);
}
.online-groups-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 8px 14px 8px 18px;
  border-bottom: 1px solid var(--app-border);
}
.online-groups-heading {
  display: flex;
  align-items: center;
  gap: 9px;
}
.online-groups-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 27px;
  height: 27px;
  border-radius: 8px;
  background: linear-gradient(145deg, color-mix(in srgb, var(--app-accent-strong) 24%, transparent), color-mix(in srgb, var(--app-accent-soft) 80%, transparent));
  color: var(--app-accent-strong);
  font-size: 15px;
}
.online-groups-heading h2 {
  margin: 0;
  font-size: 0.88rem;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.online-groups-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-right: 2px;
  padding: 0;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 0.76rem;
}
.online-groups-close:hover {
  border-color: var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text);
}
.online-profile-strip {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 18px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel-muted) 58%, transparent);
}
.online-profile-strip > :first-child {
  flex: 0 1 330px;
  min-width: 210px;
}
.online-profile-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  margin-left: auto;
}
.online-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.online-field > span {
  color: var(--app-text-faint);
  font-size: 0.68rem;
  font-weight: 650;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.online-field input,
.online-field textarea,
.online-invite-existing select {
  width: 100%;
  border: 1px solid var(--app-border);
  border-radius: 9px;
  outline: none;
  background: var(--app-input-bg);
  color: var(--app-text);
  font: inherit;
  font-size: 0.82rem;
  padding: 8px 10px;
}
.online-identity-editor-backdrop {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 22px;
  background: rgba(10, 17, 27, 0.42);
  backdrop-filter: blur(5px);
}
.online-identity-editor {
  display: flex;
  flex-direction: column;
  gap: 13px;
  width: min(440px, 100%);
  max-height: 100%;
  overflow-y: auto;
  padding: 15px;
  border: 1px solid color-mix(in srgb, var(--app-border-strong) 78%, transparent);
  border-radius: 16px;
  background: var(--app-panel);
  box-shadow: 0 22px 65px rgba(5, 13, 23, 0.32);
}
.online-identity-editor > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 2px 2px;
}
.online-identity-editor > header strong {
  font-size: 0.84rem;
}
.online-identity-editor > header button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--app-border);
  border-radius: 7px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 0.7rem;
}
.online-avatar-options,
.online-background-options,
.online-tag-options,
.online-tag-selected,
.online-tag-custom {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.online-avatar-options > button,
.online-tag-options > button,
.online-tag-selected > button {
  min-width: 30px;
  height: 30px;
  padding: 0 7px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text);
  cursor: pointer;
  font: inherit;
  font-size: 0.73rem;
}
.online-avatar-options > button {
  font-size: 16px;
}
.online-avatar-options > button:hover,
.online-tag-options > button:hover,
.online-tag-selected > button:hover {
  border-color: var(--app-border-strong);
}
.online-avatar-options > button.active,
.online-tag-options > button.active {
  border-color: color-mix(in srgb, var(--app-accent-strong) 64%, transparent);
  background: color-mix(in srgb, var(--app-accent-strong) 13%, var(--app-panel));
  color: var(--app-accent-strong);
}
.online-avatar-options > input,
.online-tag-custom > input {
  width: 92px;
  flex: 1 1 92px;
  min-width: 72px;
}
.online-background-options > button {
  width: 34px;
  height: 26px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.24);
  cursor: pointer;
}
.online-background-options > button.active {
  border-color: var(--app-accent-strong);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-accent-strong) 20%, transparent);
}
.online-tag-custom > button {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  padding: 0;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  cursor: pointer;
  font: inherit;
}
.online-tag-custom > button:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
.online-tag-selected > button {
  height: 25px;
  min-width: 0;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 0.68rem;
}
.online-tag-selected > button span {
  margin-left: 3px;
  color: var(--app-text-faint);
}
.online-identity-editor > footer {
  display: flex;
  justify-content: flex-end;
  gap: 7px;
  padding-top: 2px;
}
.online-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--app-text-muted);
  font-size: 0.71rem;
  white-space: nowrap;
}
.online-identity-actions {
  display: flex;
  gap: 7px;
}
.online-btn {
  border: 1px solid var(--app-border-strong);
  border-radius: 9px;
  background: var(--app-panel-muted);
  color: var(--app-text);
  cursor: pointer;
  font: inherit;
  font-size: 0.77rem;
  font-weight: 600;
  padding: 8px 13px;
}
.online-btn:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-accent-strong) 52%, var(--app-border));
  background: var(--app-accent-soft);
}
.online-btn:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}
.online-btn.primary,
.online-btn.accent {
  border-color: color-mix(in srgb, var(--app-accent-strong) 56%, transparent);
  background: color-mix(in srgb, var(--app-accent-strong) 16%, var(--app-panel));
  color: var(--app-accent-strong);
}
.online-btn.primary {
  background: var(--app-accent-strong);
  color: var(--app-accent-contrast, #fff);
}
.online-btn.small {
  padding: 5px 9px;
  font-size: 0.72rem;
}
.online-btn.wide {
  width: 100%;
}
.online-link {
  border: none;
  background: transparent;
  color: var(--app-accent-strong);
  cursor: pointer;
  font: inherit;
  font-size: 0.73rem;
  padding: 0;
}
.online-link:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.online-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 22px;
  border-bottom: 1px solid var(--app-border);
  font-size: 0.78rem;
}
.online-banner.error {
  background: color-mix(in srgb, var(--app-danger) 12%, transparent);
  color: var(--app-danger);
  white-space: pre-line;
}
.online-banner.notice {
  background: color-mix(in srgb, var(--app-accent-strong) 10%, transparent);
  color: var(--app-accent-strong);
}
.online-banner button {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.online-tabs {
  display: flex;
  gap: 4px;
  padding: 7px 18px 0;
  border-bottom: 1px solid var(--app-border);
}
.online-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 11px 8px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 650;
}
.online-tabs button.active {
  border-bottom-color: var(--app-accent-strong);
  color: var(--app-accent-strong);
}
.online-tab-count,
.online-tab-badge {
  min-width: 18px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-faint);
  font-size: 0.66rem;
  text-align: center;
}
.online-tab-badge {
  background: color-mix(in srgb, var(--app-accent-strong) 20%, transparent);
  color: var(--app-accent-strong);
}
.online-content {
  min-height: 0;
  flex: 1;
  overflow: hidden;
}
.online-loading {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  color: var(--app-text-muted);
  font-size: 0.82rem;
}
.online-discover,
.online-inbox {
  height: 100%;
  overflow-y: auto;
  padding: 13px 18px 20px;
}
.online-status-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 15px;
  border: 1px solid var(--app-border);
  border-radius: 13px;
  background: color-mix(in srgb, var(--app-panel-muted) 62%, transparent);
}
.online-status-copy {
  display: grid;
  grid-template-columns: auto auto;
  grid-template-rows: auto auto;
  column-gap: 8px;
  align-items: center;
}
.online-status-copy small {
  grid-column: 2;
  color: var(--app-text-faint);
  font-size: 0.72rem;
}
.online-status-dot {
  grid-row: span 2;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--app-text-faint);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--app-text-faint) 12%, transparent);
}
.online-status-dot.live {
  background: #3bb273;
  box-shadow: 0 0 0 4px color-mix(in srgb, #3bb273 18%, transparent);
}
.online-status-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--app-text-faint);
  font-size: 0.69rem;
}
.online-status-error {
  margin: 7px 2px 0;
  color: var(--app-danger);
  font-size: 0.72rem;
}
.online-discover-grid {
  display: grid;
  grid-template-columns: minmax(280px, 0.88fr) minmax(360px, 1.35fr);
  gap: 12px;
  margin-top: 12px;
  align-items: start;
}
.online-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-panel) 88%, var(--app-panel-muted));
}
.online-panel h3,
.online-invite-existing h4 {
  margin: 0;
  font-size: 0.84rem;
}
.online-panel-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.online-panel-count {
  min-width: 20px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-faint);
  font-size: 0.65rem;
  text-align: center;
}
.online-empty-inline {
  color: var(--app-text-muted);
  font-size: 0.74rem;
  line-height: 1.5;
  margin: 0;
}
.online-form-grid {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.online-field.icon {
  width: 58px;
  flex: 0 0 58px;
}
.online-field.grow {
  flex: 1;
}
.online-selected-peers {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-text-muted);
  font-size: 0.73rem;
}
.online-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 220px;
  padding: 24px;
  border: 1px dashed color-mix(in srgb, var(--app-border) 74%, transparent);
  border-radius: 13px;
  color: var(--app-text-muted);
  text-align: center;
}
.online-empty > span {
  color: var(--app-accent-strong);
  font-size: 26px;
}
.online-empty p {
  max-width: 280px;
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.55;
}
.online-peer-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-height: 510px;
  overflow-y: auto;
}
.online-peer-card {
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel);
  overflow: hidden;
}
.online-peer-card.selected {
  border-color: color-mix(in srgb, var(--app-accent-strong) 60%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 38%, var(--app-panel));
}
.online-peer-select {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.online-peer-select :deep(.identity-card) {
  flex: 1;
  min-width: 0;
  border-color: transparent;
  box-shadow: none;
}
.online-peer-meta {
  padding: 0 12px 7px 15px;
  color: var(--app-text-faint);
  font-size: 0.65rem;
}
.online-inbox-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.online-inbox-copy strong {
  overflow: hidden;
  font-size: 0.83rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.online-inbox-copy small,
.online-inbox-copy p {
  overflow: hidden;
  color: var(--app-text-muted);
  font-size: 0.7rem;
  line-height: 1.45;
  text-overflow: ellipsis;
}
.online-inbox-copy p {
  margin: 2px 0 0;
}
.online-peer-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 19px;
  height: 19px;
  margin-left: auto;
  border: 1px solid var(--app-border-strong);
  border-radius: 6px;
  color: var(--app-accent-contrast, #fff);
  font-size: 0.7rem;
}
.online-peer-card.selected .online-peer-check {
  border-color: var(--app-accent-strong);
  background: var(--app-accent-strong);
}
.online-peer-groups {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 10px 8px;
  border-top: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel-muted) 54%, transparent);
}
.online-peer-group-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  font-size: 0.74rem;
}
.online-peer-group-row > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.online-invite-existing {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-top: 10px;
  border-top: 1px solid var(--app-border);
}
.online-groups-tab {
  height: 100%;
  overflow-y: auto;
  padding: 13px 18px 20px;
}
.online-group-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}
.online-group-card {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel);
}
.online-group-card header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.online-group-card header > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.online-group-card header strong {
  overflow: hidden;
  font-size: 0.86rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.online-group-card header small,
.online-group-card > p {
  color: var(--app-text-muted);
  font-size: 0.71rem;
  line-height: 1.45;
}
.online-group-card :deep(.identity-card) {
  border-color: color-mix(in srgb, var(--app-border) 70%, transparent);
  box-shadow: none;
}
.online-group-card > p {
  flex: 1;
  margin: 0;
}
.online-group-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-accent-strong) 12%, var(--app-panel-muted));
  font-size: 17px;
}
.online-group-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.online-group-stats span {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  font-size: 0.64rem;
}
.online-group-card footer {
  display: flex;
  gap: 6px;
}
.online-group-card footer .primary {
  flex: 1;
}
.online-inbox {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.online-inbox-card {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--app-border);
  border-radius: 11px;
  background: var(--app-panel);
}
.online-inbox-identity {
  flex: 0 1 190px;
  min-width: 150px;
}
.online-inbox-identity :deep(.identity-card) {
  border-color: transparent;
  box-shadow: none;
}
.online-inbox-copy {
  flex: 1;
  min-width: 120px;
}
.online-inbox-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 5px;
}
@media (max-width: 860px) {
  .online-profile-strip {
    flex-wrap: wrap;
  }
  .online-profile-strip > :first-child {
    flex-basis: 100%;
  }
  .online-profile-controls {
    width: 100%;
    margin-left: 0;
  }
  .online-discover-grid {
    grid-template-columns: 1fr;
  }
}
</style>
