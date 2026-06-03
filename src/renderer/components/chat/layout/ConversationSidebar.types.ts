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
  isActive: boolean
  isPinned?: boolean
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
    items: ConversationSidebarItem[]
    visibleItems: ConversationSidebarItem[]
    previewItems: ConversationSidebarItem[]
  }

export type ConversationSidebarSectionKey = 'agents' | 'groups' | 'conversations'
