export interface AgentSidebarItem {
  id: string
  conversationId: string | null
  title: string
  subtitle: string
  searchText: string
  icon: string
  modelId: string
  providerName: string
  modelOptions: string[]
  isStreaming: boolean
  pendingAuthCount: number
  unreadCount: number
  isActive: boolean
}

export interface GroupSidebarItem {
  id: string
  conversationId: string | null
  title: string
  subtitle: string
  searchText: string
  icon: string
  isStreaming: boolean
  pendingAuthCount: number
  unreadCount: number
  isActive: boolean
}

export interface ConversationSidebarItem {
  id: string
  title: string
  subtitle: string
  searchText: string
  icon: string
  isStreaming: boolean
  pendingAuthCount: number
  unreadCount: number
  isActive: boolean
  isPinned?: boolean
  /** Forked from another conversation (lineage badge ⑂). */
  isFork?: boolean
  /** Launchpad 项目归属（项目聚合分组；time/folder 模式渲染归属徽标用）。 */
  projectId?: string
  updatedAt?: string
  /** 会话工作过的代码目录（无 Launchpad 归属时代替分组）。 */
  workspaceRootPath?: string
  workspaceRootName?: string
}

export interface LongTermGoalSidebarItem {
  id: string
  title: string
  subtitle: string
  searchText: string
  icon: string
  status: LongTermGoalDefinition['status']
  isRunning: boolean
  needsUserInput: boolean
  isStreaming: boolean
  pendingAuthCount: number
  unreadCount: number
  isActive: boolean
}

export interface ConversationFolderLayout {
  id: string
  name: string
  conversationIds: string[]
  collapsed: boolean
}

export interface ConversationSidebarLayout {
  folders: ConversationFolderLayout[]
  topLevelOrder: string[]
  pinnedIds: string[]
}

export interface ConversationDragItem {
  id: string
  type: 'conversation' | 'folder'
  source: 'top-level' | 'folder'
  folderId?: string | null
}

export interface ConversationDropTarget {
  id: string
  type: 'conversation' | 'folder' | 'section' | 'folder-body'
  action: 'before' | 'after' | 'merge' | 'into-folder' | 'append'
  folderId?: string | null
}

export type ConversationSidebarEntry =
  | { kind: 'conversation'; item: ConversationSidebarItem }
  | {
    kind: 'folder'
    folder: ConversationFolderLayout
    isPinned: boolean
    items: ConversationSidebarItem[]
    visibleItems: ConversationSidebarItem[]
    previewItems: ConversationSidebarItem[]
  }
  | {
    kind: 'group'
    /** Stable collapse-state key: `time:<bucket>` / `proj:<id>` / `ws:<rootPath>` / `ungrouped` / `deleted`. */
    groupId: string
    groupKind: 'time' | 'project' | 'workspace' | 'ungrouped' | 'deleted'
    label: string
    project?: { id: string; name: string; rootPath?: string } | null
    /** Root path for workspace groups (`ws:`) — "＋" attaches it to new conversations. */
    workspaceRoot?: string | null
    items: ConversationSidebarItem[]
    collapsed: boolean
  }

/** Sidebar grouping strategy (R1/R3/R6): switchable in the chat section header. */
export type ConversationGroupingMode = 'time' | 'project' | 'folders'

export type ConversationSidebarSectionKey = 'agents' | 'groups' | 'longTermGoals' | 'conversations'
