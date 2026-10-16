import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, ref } from 'vue'
import './register-ts-hooks.mjs'
import {
  resolveTimeBucket,
  useConversationSidebarGrouping
} from '../src/renderer/components/chat/layout/useConversationSidebarGrouping.ts'

const NOW = new Date('2026-10-15T12:00:00')

function item (id, overrides = {}) {
  return {
    id,
    title: id,
    subtitle: '',
    searchText: '',
    icon: '',
    isStreaming: false,
    pendingAuthCount: 0,
    unreadCount: 0,
    isActive: false,
    ...overrides
  }
}

test('resolveTimeBucket splits local calendar days', () => {
  assert.equal(resolveTimeBucket('2026-10-15T09:00:00', NOW), 'today')
  assert.equal(resolveTimeBucket('2026-10-14T23:30:00', NOW), 'yesterday')
  assert.equal(resolveTimeBucket('2026-10-09T00:00:00', NOW), 'last7Days')
  assert.equal(resolveTimeBucket('2026-09-20T00:00:00', NOW), 'last30Days')
  assert.equal(resolveTimeBucket('2026-08-01T00:00:00', NOW), 'older')
  assert.equal(resolveTimeBucket('not-a-date', NOW), 'older')
})

function groupingFixture (items, projects = [], pinnedIds = []) {
  const searchQuery = ref('')
  const labels = {
    today: '今天', yesterday: '昨天', last7Days: '近 7 天', last30Days: '近 30 天',
    older: '更早', ungrouped: '未分组', deletedProjects: '已删除项目'
  }
  const composable = useConversationSidebarGrouping({
    conversationItems: computed(() => items),
    searchQuery,
    normalizeSearchValue: value => value.toLowerCase().trim(),
    conversationListLoaded: ref(true),
    folderEntries: computed(() => []),
    pinnedIds: ref(pinnedIds),
    projects: ref(projects),
    labels
  })
  return { ...composable, searchQuery }
}

test('time mode buckets non-empty groups in calendar order', () => {
  const { groupedEntries } = groupingFixture([
    item('a', { updatedAt: '2026-10-15T08:00:00' }),
    item('b', { updatedAt: '2026-10-14T08:00:00' }),
    item('c', { updatedAt: '2026-10-01T08:00:00' })
  ])
  const groups = groupedEntries.value.filter(entry => entry.kind === 'group')
  assert.deepEqual(groups.map(group => group.groupId), ['time:today', 'time:yesterday', 'time:last30Days'])
  // empty buckets are not rendered
  assert.ok(!groups.some(group => group.groupId === 'time:last7Days'))
})

test('project mode groups by project then ungrouped then deleted', () => {
  const projects = [{ id: 'p1', name: 'the-world' }]
  const grouping = groupingFixture([
    item('assigned', { updatedAt: '2026-10-15T08:00:00', projectId: 'p1' }),
    item('free', { updatedAt: '2026-10-15T07:00:00' }),
    item('legacy', { updatedAt: '2026-10-15T06:00:00', projectId: 'gone' })
  ], projects)
  grouping.setGroupingMode('project')
  const groups = grouping.groupedEntries.value.filter(entry => entry.kind === 'group')
  assert.deepEqual(groups.map(group => group.groupId), ['proj:p1', 'ungrouped', 'deleted'])
  const deleted = groups.find(group => group.groupId === 'deleted')
  assert.deepEqual(deleted.items.map(item => item.id), ['legacy'])
})

test('project groups order by most recent activity', () => {
  const projects = [{ id: 'p1', name: 'old' }, { id: 'p2', name: 'fresh' }]
  const grouping = groupingFixture([
    item('x', { updatedAt: '2026-10-15T10:00:00', projectId: 'p2' }),
    item('y', { updatedAt: '2026-10-15T09:00:00', projectId: 'p1' })
  ], projects)
  grouping.setGroupingMode('project')
  const groups = grouping.groupedEntries.value.filter(entry => entry.kind === 'group')
  assert.deepEqual(groups.map(group => group.groupId), ['proj:p2', 'proj:p1'])
})

test('search flattens every mode into matched rows', () => {
  const { groupedEntries, searchQuery } = groupingFixture([
    item('alpha-today', { updatedAt: '2026-10-15T08:00:00' }),
    item('beta-today', { updatedAt: '2026-10-15T07:00:00' }),
    item('gamma-old', { updatedAt: '2026-08-01T07:00:00' })
  ])
  searchQuery.value = 'today'
  const entries = groupedEntries.value
  assert.ok(entries.every(entry => entry.kind === 'conversation'))
  assert.deepEqual(entries.map(entry => entry.item.id), ['alpha-today', 'beta-today'])
})

test('workspace code directories group like projects for unowned conversations', () => {
  const projects = [{ id: 'p1', name: 'the-world' }]
  const grouping = groupingFixture([
    item('owned', { updatedAt: '2026-10-15T08:00:00', projectId: 'p1' }),
    item('ext1', { updatedAt: '2026-10-15T07:00:00', workspaceRootPath: '/Users/dev/app-a', workspaceRootName: 'app-a' }),
    item('ext2', { updatedAt: '2026-10-15T06:00:00', workspaceRootPath: '/Users/dev/app-a', workspaceRootName: 'app-a' }),
    item('ext-other', { updatedAt: '2026-10-15T05:00:00', workspaceRootPath: '/Users/dev/app-b' }),
    item('loose', { updatedAt: '2026-10-15T04:00:00' })
  ], projects)
  grouping.setGroupingMode('project')
  const groups = grouping.groupedEntries.value.filter(entry => entry.kind === 'group')
  assert.deepEqual(groups.map(group => [group.groupId, group.groupKind]), [
    ['proj:p1', 'project'],
    ['ws:/Users/dev/app-a', 'workspace'],
    ['ws:/Users/dev/app-b', 'workspace'],
    ['ungrouped', 'ungrouped']
  ])
  const wsA = groups.find(group => group.groupId === 'ws:/Users/dev/app-a')
  assert.equal(wsA.label, 'app-a')
  assert.deepEqual(wsA.items.map(item => item.id), ['ext1', 'ext2'])
  const wsB = groups.find(group => group.groupId === 'ws:/Users/dev/app-b')
  assert.equal(wsB.label, 'app-b')
})

test('pinned conversations join their project group instead of floating to the top', () => {
  const projects = [{ id: 'p1', name: 'the-world' }]
  const grouping = groupingFixture([
    item('pinned-free', { updatedAt: '2026-10-15T10:00:00' }),
    item('plain', { updatedAt: '2026-10-15T09:00:00' }),
    item('pinned-owned', { updatedAt: '2026-10-15T08:00:00', projectId: 'p1' }),
    item('owned', { updatedAt: '2026-10-15T07:00:00', projectId: 'p1' })
  ], projects, ['pinned-free', 'pinned-owned'])
  grouping.setGroupingMode('project')
  // No global pinned section in project mode — every entry is a group.
  assert.ok(grouping.groupedEntries.value.every(entry => entry.kind === 'group'))
  const ungrouped = grouping.groupedEntries.value.find(entry => entry.groupId === 'ungrouped')
  assert.equal(ungrouped.items[0].id, 'pinned-free')
  assert.equal(ungrouped.items[0].isPinned, true)
  const proj = grouping.groupedEntries.value.find(entry => entry.groupId === 'proj:p1')
  assert.deepEqual(proj.items.map(item => item.id), ['pinned-owned', 'owned'])
  assert.equal(proj.items[0].isPinned, true)
  assert.equal(proj.items[1].isPinned, undefined)
})

test('registered folder projects capture conversations by workspace root path', () => {
  const projects = [{ id: 'cproj_x', name: '营销资料库', rootPath: '/Users/dev/docs' }]
  const grouping = groupingFixture([
    item('assigned', { updatedAt: '2026-10-15T08:00:00', projectId: 'cproj_x' }),
    item('attached', { updatedAt: '2026-10-15T07:00:00', workspaceRootPath: '/Users/dev/docs', workspaceRootName: 'docs' }),
    item('other-root', { updatedAt: '2026-10-15T06:00:00', workspaceRootPath: '/Users/dev/elsewhere' })
  ], projects)
  grouping.setGroupingMode('project')
  const groups = grouping.groupedEntries.value.filter(entry => entry.kind === 'group')
  assert.deepEqual(groups.map(group => group.groupId), ['proj:cproj_x', 'ws:/Users/dev/elsewhere'])
  const proj = groups.find(group => group.groupId === 'proj:cproj_x')
  assert.deepEqual(proj.items.map(item => item.id), ['assigned', 'attached'])
})

test('mode persists and folder mode passes entries through', () => {
  const folderEntry = { kind: 'folder', folder: { id: 'f1', name: 'F', conversationIds: ['a'], collapsed: false }, isPinned: false, items: [], visibleItems: [], previewItems: [] }
  const searchQuery = ref('')
  const composable = useConversationSidebarGrouping({
    conversationItems: computed(() => [item('a', { updatedAt: '2026-10-15T08:00:00' })]),
    searchQuery,
    normalizeSearchValue: value => value.toLowerCase().trim(),
    conversationListLoaded: ref(true),
    folderEntries: computed(() => [folderEntry]),
    pinnedIds: ref([]),
    projects: ref([]),
    labels: { today: '今天', yesterday: '昨天', last7Days: '近 7 天', last30Days: '近 30 天', older: '更早', ungrouped: '未分组', deletedProjects: '已删除项目' }
  })
  composable.setGroupingMode('folders')
  assert.deepEqual(composable.groupedEntries.value, [folderEntry])
  composable.toggleGroupCollapsed('time:today')
  composable.setGroupingMode('time')
  assert.equal(composable.groupedEntries.value.find(entry => entry.kind === 'group')?.collapsed, true)
  composable.toggleGroupCollapsed('time:today')
  assert.equal(composable.groupedEntries.value.find(entry => entry.kind === 'group')?.collapsed, false)
})
