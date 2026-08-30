export interface ProjectRuntime {
  status?: string
  port?: number
}

export interface Project {
  id: string
  name?: string
  type?: string
  icon?: string
  kind?: 'project' | 'web'
  url?: string
  createdAt?: string
  updatedAt?: string
  runtime?: ProjectRuntime
  [key: string]: unknown
}

export interface LaunchFolder {
  id: string
  name: string
  projectIds: string[]
}

export interface LaunchpadDragItem {
  id: string
  type: 'project' | 'folder'
  source: 'top-level' | 'folder'
  folderId?: string | null
}

export type LaunchpadDropAction = 'before' | 'after' | 'merge' | 'into-folder' | 'append'

export interface LaunchpadDropTarget {
  id: string
  type: 'project' | 'folder' | 'grid'
  action: LaunchpadDropAction
  folderId?: string | null
}

export type LaunchpadGridItem =
  | { kind: 'folder'; data: LaunchFolder }
  | { kind: 'project'; data: Project }
