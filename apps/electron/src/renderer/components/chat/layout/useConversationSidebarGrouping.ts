import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type {
  ConversationGroupingMode,
  ConversationSidebarEntry,
  ConversationSidebarItem
} from './ConversationSidebar.types'

const GROUPING_STORAGE_KEY = 'conversation-sidebar-grouping'

export interface SidebarProjectInfo {
  id: string
  name: string
  /** Registered folder projects group by directory as well as by id. */
  rootPath?: string
}

/** Group identity for conversations tied to a code directory but no Launchpad project. */
export interface SidebarWorkspaceRootInfo {
  path: string
  name: string
}

export interface ConversationGroupingLabels {
  today: string
  yesterday: string
  last7Days: string
  last30Days: string
  older: string
  ungrouped: string
  deletedProjects: string
}

const DAY_MS = 86_400_000

type TimeBucketKey = 'today' | 'yesterday' | 'last7Days' | 'last30Days' | 'older'

function startOfDay (value: Date): number {
  const copy = new Date(value)
  copy.setHours(0, 0, 0, 0)
  return copy.getTime()
}

/** Local-calendar buckets; `now` injectable so tests can pin the boundary. */
export function resolveTimeBucket (updatedAt: string, now: Date = new Date()): TimeBucketKey {
  const timestamp = Date.parse(updatedAt)
  if (Number.isNaN(timestamp)) return 'older'
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - DAY_MS
  if (timestamp >= todayStart) return 'today'
  if (timestamp >= yesterdayStart) return 'yesterday'
  if (timestamp >= yesterdayStart - 7 * DAY_MS) return 'last7Days'
  if (timestamp >= yesterdayStart - 30 * DAY_MS) return 'last30Days'
  return 'older'
}

interface GroupingStorage {
  mode?: unknown
  collapsedGroups?: unknown
}

function loadGroupingState (): { mode: ConversationGroupingMode; collapsedGroups: Record<string, boolean> } {
  const fallback = { mode: 'time' as ConversationGroupingMode, collapsedGroups: {} as Record<string, boolean> }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(GROUPING_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as GroupingStorage
    const collapsedGroups: Record<string, boolean> = {}
    if (parsed.collapsedGroups && typeof parsed.collapsedGroups === 'object') {
      for (const [key, value] of Object.entries(parsed.collapsedGroups)) {
        if (typeof key === 'string' && key && value === true) collapsedGroups[key] = true
      }
    }
    return {
      mode: parsed.mode === 'project' || parsed.mode === 'folders' || parsed.mode === 'time' ? parsed.mode : 'time',
      collapsedGroups
    }
  } catch {
    return fallback
  }
}

/** Initial mode for the parent shell so the collapsed flyout groups identically. */
export function loadConversationGroupingMode (): ConversationGroupingMode {
  return loadGroupingState().mode
}

export function useConversationSidebarGrouping (options: {
  conversationItems: ComputedRef<ConversationSidebarItem[]>
  searchQuery: Ref<string>
  normalizeSearchValue: (value: string) => string
  conversationListLoaded: Ref<boolean>
  /** Folder-mode entries from useConversationSidebarFolders (passthrough). */
  folderEntries: ComputedRef<ConversationSidebarEntry[]>
  pinnedIds: Ref<string[]>
  projects: Ref<SidebarProjectInfo[]>
  labels: ConversationGroupingLabels
}) {
  const {
    conversationItems,
    searchQuery,
    normalizeSearchValue,
    conversationListLoaded,
    folderEntries,
    pinnedIds,
    projects,
    labels
  } = options

  const initialState = loadGroupingState()
  const groupingMode = ref<ConversationGroupingMode>(initialState.mode)
  const collapsedGroups = ref<Record<string, boolean>>(initialState.collapsedGroups)
    // Prune collapse keys that no longer resolve once the catalog settles, so the
    // stored record cannot grow without bound across churned group ids.
    watch([groupingMode, conversationListLoaded], () => {
      if (!conversationListLoaded.value) return
      let changed = false
      for (const key of Object.keys(collapsedGroups.value)) {
        if (key.startsWith('time:') || key.startsWith('proj:') || key.startsWith('ws:') || key === 'ungrouped' || key === 'deleted') continue
        delete collapsedGroups.value[key]
        changed = true
      }
      if (changed) persistGroupingState()
    })

  function persistGroupingState () {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(GROUPING_STORAGE_KEY, JSON.stringify({
        mode: groupingMode.value,
        collapsedGroups: collapsedGroups.value
      }))
    } catch {
      // Ignore local persistence failures.
    }
  }

  function setGroupingMode (mode: ConversationGroupingMode): void {
    if (groupingMode.value === mode) return
    groupingMode.value = mode
    persistGroupingState()
  }

  function toggleGroupCollapsed (groupId: string): void {
    if (collapsedGroups.value[groupId]) delete collapsedGroups.value[groupId]
    else collapsedGroups.value[groupId] = true
    // Reassign so Vue's reactive record change is observed.
    collapsedGroups.value = { ...collapsedGroups.value }
    persistGroupingState()
  }

  function isGroupCollapsed (groupId: string): boolean {
    return collapsedGroups.value[groupId] === true
  }

  function matchesQuery (item: ConversationSidebarItem, query: string): boolean {
    if (!query) return true
    return normalizeSearchValue([item.title, item.subtitle, item.searchText].join(' ')).includes(query)
  }

  function recentFirst (left: ConversationSidebarItem, right: ConversationSidebarItem): number {
    const leftTime = Date.parse(left.updatedAt || '') || 0
    const rightTime = Date.parse(right.updatedAt || '') || 0
    return rightTime - leftTime
  }

  const projectsById = computed(() => new Map(projects.value.map(project => [project.id, project])))

  const bucketOrder: TimeBucketKey[] = ['today', 'yesterday', 'last7Days', 'last30Days', 'older']
  const bucketLabels: Record<TimeBucketKey, string> = {
    today: labels.today,
    yesterday: labels.yesterday,
    last7Days: labels.last7Days,
    last30Days: labels.last30Days,
    older: labels.older
  }

  /**
   * Unified chat-section entries. Time/project modes build their groups here;
   * folder mode passes the manual layout through untouched. Search flattens
   * every mode into matched rows (matches the legacy behavior).
   */
  const groupedEntries = computed<ConversationSidebarEntry[]>(() => {
    const query = normalizeSearchValue(searchQuery.value)

    if (groupingMode.value === 'folders') return folderEntries.value

    const pinnedSet = new Set(pinnedIds.value)
    const matched = conversationItems.value.filter(item => matchesQuery(item, query))
    const pinnedItems = matched.filter(item => pinnedSet.has(item.id)).sort(recentFirst)
    const unpinned = matched.filter(item => !pinnedSet.has(item.id)).sort(recentFirst)

    const pinnedEntries: ConversationSidebarEntry[] = pinnedItems.map(item => ({ kind: 'conversation', item }))
    if (query) return [...pinnedEntries, ...unpinned.map(item => ({ kind: 'conversation' as const, item }))]

    if (groupingMode.value === 'time') {
      const entries: ConversationSidebarEntry[] = [...pinnedEntries]
      for (const bucket of bucketOrder) {
        const items = unpinned.filter(item => resolveTimeBucket(item.updatedAt || '') === bucket)
        if (items.length === 0) continue
        const groupId = `time:${bucket}`
        entries.push({
          kind: 'group',
          groupId,
          groupKind: 'time',
          label: bucketLabels[bucket],
          items,
          collapsed: isGroupCollapsed(groupId)
        })
      }
      return entries
    }

    // project mode — Launchpad projects plus workspace code directories form
    // one project dimension, ordered by each group's most recent activity.
    // Pinned rows do NOT float above every group here: the project dimension
    // dominates, and pinned conversations sort first inside their own group.
    const knownProjects = projectsById.value
    const projectGroups: ConversationSidebarEntry[] = []
    const wsGroups = new Map<string, { name: string; items: ConversationSidebarItem[] }>()
    const assigned = new Set<string>()

    const orderWithinGroup = (left: ConversationSidebarItem, right: ConversationSidebarItem): number => {
      const leftPinned = pinnedSet.has(left.id) ? 0 : 1
      const rightPinned = pinnedSet.has(right.id) ? 0 : 1
      if (leftPinned !== rightPinned) return leftPinned - rightPinned
      return recentFirst(left, right)
    }
    const decorate = (item: ConversationSidebarItem): ConversationSidebarItem => (
      pinnedSet.has(item.id) ? { ...item, isPinned: true } : item
    )
    const latestOf = (items: ConversationSidebarItem[]): number => (
      items.reduce((max, item) => Math.max(max, Date.parse(item.updatedAt || '') || 0), 0)
    )

    for (const project of projects.value) {
      const items = matched
        .filter(item => item.projectId === project.id ||
          (!item.projectId && project.rootPath && item.workspaceRootPath === project.rootPath))
        .sort(orderWithinGroup)
        .map(decorate)
      if (items.length === 0) continue
      items.forEach(item => assigned.add(item.id))
      const groupId = `proj:${project.id}`
      projectGroups.push({
        kind: 'group',
        groupId,
        groupKind: 'project',
        label: project.name,
        project,
        items,
        collapsed: isGroupCollapsed(groupId)
      })
    }

    // Workspace code directories (folder tab / legacy folder workspace) group
    // conversations that never got a project owner — external code projects.
    for (const item of matched) {
      if (assigned.has(item.id) || item.projectId || !item.workspaceRootPath) continue
      const path = item.workspaceRootPath
      if (!wsGroups.has(path)) {
        wsGroups.set(path, { name: item.workspaceRootName || path.split(/[\\/]/).filter(Boolean).pop() || path, items: [] })
      }
      wsGroups.get(path)!.items.push(item)
    }
    for (const [path, group] of wsGroups) {
      group.items.sort(orderWithinGroup)
      const groupId = `ws:${path}`
      projectGroups.push({
        kind: 'group',
        groupId,
        groupKind: 'workspace',
        label: group.name,
        workspaceRoot: path,
        items: group.items.map(decorate),
        collapsed: isGroupCollapsed(groupId)
      })
    }

    projectGroups.sort((left, right) => {
      const leftItems = left.kind === 'group' ? left.items : []
      const rightItems = right.kind === 'group' ? right.items : []
      return latestOf(rightItems) - latestOf(leftItems)
    })
    const entries: ConversationSidebarEntry[] = [...projectGroups]

    const ungrouped = matched
      .filter(item => !item.projectId && !item.workspaceRootPath)
      .sort(orderWithinGroup)
      .map(decorate)
    if (ungrouped.length > 0) {
      entries.push({
        kind: 'group',
        groupId: 'ungrouped',
        groupKind: 'ungrouped',
        label: labels.ungrouped,
        items: ungrouped,
        collapsed: isGroupCollapsed('ungrouped')
      })
    }

    const deleted = matched
      .filter(item => {
        if (!item.projectId || assigned.has(item.id)) return false
        return !knownProjects.has(item.projectId)
      })
      .sort(orderWithinGroup)
      .map(decorate)
    if (deleted.length > 0) {
      entries.push({
        kind: 'group',
        groupId: 'deleted',
        groupKind: 'deleted',
        label: labels.deletedProjects,
        items: deleted,
        collapsed: isGroupCollapsed('deleted')
      })
    }

    return entries
  })

  return {
    groupingMode,
    setGroupingMode,
    groupedEntries,
    toggleGroupCollapsed,
    isGroupCollapsed
  }
}
