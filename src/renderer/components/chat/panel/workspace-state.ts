import type { Ref } from 'vue'
import { buildOutgoingChatMessages } from './message-runtime'
import type { ChatMessage, MessageContent } from './types'

export const DEFAULT_DOCUMENT_WORKSPACE_WIDTH = 900
export const DEFAULT_FOLDER_WORKSPACE_WIDTH = 980

interface ChatWorkspaceRefs {
  documentDockVisible: Ref<boolean>
  documentWorkspaceDocuments: Ref<ConversationDocumentReference[]>
  documentWorkspaceActiveFilePath: Ref<string | null>
  documentWorkspaceWidth: Ref<number>
  folderWorkspaceRootPath: Ref<string | null>
  folderWorkspaceRootName: Ref<string | null>
  folderWorkspaceActiveFilePath: Ref<string | null>
  folderWorkspaceWidth: Ref<number>
}

export function createChatWorkspaceState (refs: ChatWorkspaceRefs) {
  const {
    documentDockVisible,
    documentWorkspaceDocuments,
    documentWorkspaceActiveFilePath,
    documentWorkspaceWidth,
    folderWorkspaceRootPath,
    folderWorkspaceRootName,
    folderWorkspaceActiveFilePath,
    folderWorkspaceWidth
  } = refs

  function getDocumentFileName (filePath: string, fallback?: string | null): string {
    const normalizedFallback = fallback?.trim()
    if (normalizedFallback) return normalizedFallback
    const segments = filePath.split(/[\\/]/).filter(Boolean)
    return segments[segments.length - 1] || filePath
  }

  function normalizeDocumentFileKey (filePath?: string | null): string {
    return (filePath || '')
      .trim()
      .replace(/\//g, '\\')
      .toLowerCase()
  }

  function sanitizeDocumentWorkspaceDocuments (documents?: ConversationDocumentReference[] | null): ConversationDocumentReference[] {
    const uniqueDocuments = new Map<string, ConversationDocumentReference>()

    for (const documentRef of documents || []) {
      const filePath = documentRef?.filePath?.trim()
      if (!filePath) continue
      const fileKey = normalizeDocumentFileKey(filePath)
      if (!fileKey || uniqueDocuments.has(fileKey)) continue
      uniqueDocuments.set(fileKey, {
        filePath,
        fileName: getDocumentFileName(filePath, documentRef.fileName)
      })
    }

    return Array.from(uniqueDocuments.values())
  }

  function applyDocumentWorkspaceState (state?: ConversationDocumentWorkspaceState | null): void {
    const nextDocuments = sanitizeDocumentWorkspaceDocuments(state?.documents)
    documentWorkspaceDocuments.value = nextDocuments

    const normalizedActiveFileKey = normalizeDocumentFileKey(state?.activeFilePath)
    const activeDocument = nextDocuments.find(item => normalizeDocumentFileKey(item.filePath) === normalizedActiveFileKey)
    documentWorkspaceActiveFilePath.value = activeDocument?.filePath || nextDocuments[0]?.filePath || null

    const nextWidth = state?.width
    documentWorkspaceWidth.value = typeof nextWidth === 'number' && Number.isFinite(nextWidth)
      ? Math.round(nextWidth)
      : DEFAULT_DOCUMENT_WORKSPACE_WIDTH
  }

  function buildCurrentDocumentWorkspaceState (): ConversationDocumentWorkspaceState | undefined {
    const documents = sanitizeDocumentWorkspaceDocuments(documentWorkspaceDocuments.value)
    if (documents.length === 0) return undefined

    const activeFilePath = documents.find(item => item.filePath === documentWorkspaceActiveFilePath.value)?.filePath
      || documents[0]?.filePath

    return {
      documents,
      activeFilePath,
      width: documentWorkspaceWidth.value
    }
  }

  function trimDocumentWorkspaceContextValue (value: string, maxLength = 240): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, maxLength)}...[truncated ${normalized.length - maxLength} chars]`
  }

  async function buildDocumentWorkspaceContextPrompt (): Promise<string | null> {
    const state = buildCurrentDocumentWorkspaceState()
    const documents = state?.documents || []
    if (!documentDockVisible.value && documents.length === 0) return null

    const importedSummaries = new Map<string, DocumentSummaryDTO>()
    if (documents.length > 0 && window.electronAPI?.listDocuments) {
      try {
        const summaries = await window.electronAPI.listDocuments()
        for (const summary of summaries) {
          importedSummaries.set(normalizeDocumentFileKey(summary.filePath), summary)
        }
      } catch {
        // Workspace paths still provide useful context when document lookup fails.
      }
    }

    const lines = [
      '## Document workspace context',
      documentDockVisible.value
        ? '- The user currently has the document workspace open in this conversation.'
        : '- This conversation has document workspace files bound from an earlier workspace state.',
      '- If the user asks about "the document", "the opened file", "the workbench document", or similar phrasing, treat the files below as the relevant document context.',
      '- Use `list_documents` to verify available imported artifacts when needed, then `read_document` with the matching artifact_id to inspect document content. Do not claim no document is available before checking this context and the document tools.'
    ]

    if (documents.length === 0) {
      lines.push('- No document is currently bound in the document workspace.')
      return lines.join('\n')
    }

    lines.push('Current document workspace files:')
    for (const documentRef of documents.slice(0, 20)) {
      const fileKey = normalizeDocumentFileKey(documentRef.filePath)
      const summary = importedSummaries.get(fileKey)
      const isActive = fileKey === normalizeDocumentFileKey(state?.activeFilePath)
      const details = [
        `name: ${trimDocumentWorkspaceContextValue(documentRef.fileName || getDocumentFileName(documentRef.filePath), 120)}`,
        `path: ${trimDocumentWorkspaceContextValue(documentRef.filePath)}`
      ]
      if (summary) {
        details.push(
          `artifact_id: ${summary.id}`,
          `type: ${summary.fileType}`,
          `selections: ${summary.selectionCount}`
        )
      } else {
        details.push('artifact_id: unknown until `list_documents` is checked')
      }
      lines.push(`- ${isActive ? '[active] ' : ''}${details.join('; ')}`)
    }

    if (documents.length > 20) {
      lines.push(`- ...and ${documents.length - 20} more workspace file(s).`)
    }

    return lines.join('\n')
  }

  async function buildOutgoingMessagesWithDocumentWorkspaceContext (
    sourceMessages: ChatMessage[]
  ): Promise<Array<{ role: string; content: MessageContent }>> {
    const outgoingMessages = buildOutgoingChatMessages(sourceMessages)
    const documentContextPrompt = await buildDocumentWorkspaceContextPrompt()
    if (!documentContextPrompt) return outgoingMessages

    const insertIndex = Math.max(outgoingMessages.length - 1, 0)
    outgoingMessages.splice(insertIndex, 0, {
      role: 'system',
      content: documentContextPrompt
    })
    return outgoingMessages
  }

  function resetDocumentWorkspaceState (): void {
    documentWorkspaceDocuments.value = []
    documentWorkspaceActiveFilePath.value = null
    documentWorkspaceWidth.value = DEFAULT_DOCUMENT_WORKSPACE_WIDTH
  }

  function getFolderWorkspaceName (rootPath: string, fallback?: string | null): string {
    const normalizedFallback = fallback?.trim()
    if (normalizedFallback) return normalizedFallback
    const segments = rootPath.split(/[\\/]/).filter(Boolean)
    return segments[segments.length - 1] || rootPath
  }

  function normalizeFolderWorkspacePathKey (value?: string | null): string {
    return (value || '')
      .trim()
      .replace(/\\/g, '/')
  }

  function applyFolderWorkspaceState (state?: ConversationFolderWorkspaceState | null): void {
    const rootPath = state?.rootPath?.trim()
    if (!rootPath) {
      resetFolderWorkspaceState()
      return
    }

    folderWorkspaceRootPath.value = rootPath
    folderWorkspaceRootName.value = getFolderWorkspaceName(rootPath, state?.rootName)
    folderWorkspaceActiveFilePath.value = normalizeFolderWorkspacePathKey(state?.activeFilePath) || null

    const nextWidth = state?.width
    folderWorkspaceWidth.value = typeof nextWidth === 'number' && Number.isFinite(nextWidth)
      ? Math.round(nextWidth)
      : DEFAULT_FOLDER_WORKSPACE_WIDTH
  }

  function buildCurrentFolderWorkspaceState (): ConversationFolderWorkspaceState | undefined {
    const rootPath = folderWorkspaceRootPath.value?.trim()
    if (!rootPath) return undefined

    return {
      rootPath,
      rootName: getFolderWorkspaceName(rootPath, folderWorkspaceRootName.value),
      activeFilePath: normalizeFolderWorkspacePathKey(folderWorkspaceActiveFilePath.value) || undefined,
      width: folderWorkspaceWidth.value
    }
  }

  function resetFolderWorkspaceState (): void {
    folderWorkspaceRootPath.value = null
    folderWorkspaceRootName.value = null
    folderWorkspaceActiveFilePath.value = null
    folderWorkspaceWidth.value = DEFAULT_FOLDER_WORKSPACE_WIDTH
  }

  return {
    applyDocumentWorkspaceState,
    applyFolderWorkspaceState,
    buildCurrentDocumentWorkspaceState,
    buildCurrentFolderWorkspaceState,
    buildOutgoingMessagesWithDocumentWorkspaceContext,
    resetDocumentWorkspaceState,
    resetFolderWorkspaceState
  }
}
