export type FolderWorkspaceFileKind = 'text' | 'code' | 'markdown' | 'binary' | 'large' | 'unknown'

export interface ConversationFolderWorkspaceState {
  rootPath: string
  rootName: string
  activeFilePath?: string
  width?: number
}

export interface FolderWorkspaceFileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  kind?: FolderWorkspaceFileKind
  language?: string
  children?: FolderWorkspaceFileEntry[]
}

export interface FolderWorkspacePickResult {
  canceled: boolean
  rootPath?: string
  rootName?: string
}

export interface FolderWorkspaceListResult {
  rootPath: string
  rootName: string
  entries: FolderWorkspaceFileEntry[]
  totalEntries: number
  truncated: boolean
}

export interface FolderWorkspaceReadResult {
  rootPath: string
  filePath: string
  fileName: string
  size: number
  content: string
  kind: FolderWorkspaceFileKind
  language?: string
  isMarkdown: boolean
  lineCount: number
  truncated: boolean
}
