/**
 * Agent tool — read_document
 * Allows the AI agent to read the content of an imported document or specific selections.
 */
import type { AgentCore } from '../agent-core.js'
import type { DocumentStore } from './document-store.js'

export function toolReadDocument (documentStore: DocumentStore) {
  return {
    definition: {
      name: 'read_document',
      description: 'Read imported document content in bounded chunks, or return specific selected regions.',
      parameters: {
        type: 'object' as const,
        properties: {
          artifact_id: {
            type: 'string',
            description: 'Unique document ID. Use list_documents to discover available documents.'
          },
          region_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of selection IDs. If provided, only those selections are returned.'
          },
          chunk_index: {
            type: 'number',
            description: 'Optional zero-based chunk index for traversing large documents. Defaults to 0.'
          },
          max_chars: {
            type: 'number',
            description: 'Optional maximum characters per chunk. Defaults to 12000 and is clamped for safety.'
          }
        },
        required: ['artifact_id']
      }
    },
    handler: async (args: Record<string, unknown>): Promise<unknown> => {
      const artifactId = String(args.artifact_id || '')
      const regionIds = Array.isArray(args.region_ids) ? args.region_ids.map(String) : undefined
      const chunkIndex = Number.isFinite(Number(args.chunk_index)) ? Math.max(0, Math.floor(Number(args.chunk_index))) : 0
      const maxChars = Number.isFinite(Number(args.max_chars)) ? Math.floor(Number(args.max_chars)) : 12000

      const artifact = documentStore.getArtifact(artifactId)
      if (!artifact) {
        return { error: `文档不存在: ${artifactId}` }
      }

      if (regionIds && regionIds.length > 0) {
        const refs = documentStore.buildSelectionRefs(regionIds)
        return {
          fileName: artifact.fileName,
          fileType: artifact.fileType,
          selections: refs.map(ref => ({
            regionId: ref.regionId,
            label: ref.label,
            text: ref.selectedText
          }))
        }
      }

      const chunks = documentStore.getArtifactChunks(artifactId, maxChars)
      if (!chunks || chunks.length === 0) {
        return {
          fileName: artifact.fileName,
          fileType: artifact.fileType,
          totalLength: artifact.plainText.length,
          totalChunks: 0,
          chunkIndex: 0,
          hasMore: false,
          content: ''
        }
      }

      if (chunkIndex >= chunks.length) {
        return {
          error: `文档分块索引超出范围: ${chunkIndex}，可用范围为 0-${Math.max(0, chunks.length - 1)}`,
          fileName: artifact.fileName,
          fileType: artifact.fileType,
          totalLength: artifact.plainText.length,
          totalChunks: chunks.length,
          requestedChunkIndex: chunkIndex
        }
      }

      const chunk = chunks[chunkIndex]
      return {
        strategy: 'chunk',
        fileName: artifact.fileName,
        fileType: artifact.fileType,
        totalLength: artifact.plainText.length,
        totalChunks: chunks.length,
        chunkIndex: chunk.chunkIndex,
        maxChars,
        hasMore: chunk.chunkIndex < chunks.length - 1,
        nextChunkIndex: chunk.chunkIndex < chunks.length - 1 ? chunk.chunkIndex + 1 : null,
        range: {
          startNodeId: chunk.startNodeId,
          endNodeId: chunk.endNodeId,
          startPageIndex: chunk.startPageIndex,
          endPageIndex: chunk.endPageIndex
        },
        guidance: chunk.chunkIndex < chunks.length - 1
          ? `继续读取请再次调用 read_document，并传入 artifact_id=${artifactId} 与 chunk_index=${chunk.chunkIndex + 1}`
          : '已到达文档末尾。',
        content: chunk.content
      }
    }
  }
}

export function toolListDocuments (documentStore: DocumentStore) {
  return {
    definition: {
      name: 'list_documents',
      description: 'List all imported documents and their selection summaries.',
      parameters: {
        type: 'object' as const,
        properties: {}
      }
    },
    handler: async (): Promise<unknown> => {
      const summaries = documentStore.listSummaries()
      if (summaries.length === 0) {
        return { message: '当前没有已导入的文档。' }
      }

      return {
        documents: summaries.map(s => ({
          id: s.id,
          fileName: s.fileName,
          fileType: s.fileType,
          nodeCount: s.nodeCount,
          selectionCount: s.selectionCount,
          importedAt: s.importedAt
        })),
        selections: documentStore.getAllSelections().map(sel => ({
          id: sel.id,
          artifactId: sel.artifactId,
          label: sel.label,
          nodeCount: sel.nodeIds.length
        }))
      }
    }
  }
}
