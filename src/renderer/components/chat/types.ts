export type MessageContent = string | ChatContentPart[]

export interface ChatContentPart {
  type: string
  text?: string
  image_url?: { url: string }
}

export interface ToolProgressEntry {
  stage: string
  detail?: string
}

export interface ToolRun {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  progress: ToolProgressEntry[]
}

export type ChatMessageBlock =
  | { id: string; kind: 'content'; content: MessageContent }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; toolRun: ToolRun }
  | { id: string; kind: 'file_preview'; filePath: string; previewContent: string; truncated: boolean; active: boolean }
  | { id: string; kind: 'attachment'; fileName: string; fileType: string; fileSizeLabel: string; previewText: string }
  | { id: string; kind: 'auth_request'; requestId: string; title: string; detail: string; status: 'pending' | 'approved' | 'denied' }

export interface ChatMessage {
  role: string
  content: MessageContent
  thinking?: string
  modelLabel?: string
  toolRuns?: ToolRun[]
  blocks?: ChatMessageBlock[]
}

export interface GalleryImage {
  url: string
  messageIndex: number
  blockIndex: number
  partIndex: number
}

export interface FilePreviewState {
  active: boolean
  filePath: string
  content: string
  truncated: boolean
}
