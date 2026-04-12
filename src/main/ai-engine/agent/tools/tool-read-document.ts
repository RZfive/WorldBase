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
      description: '读取用户已导入的文档内容。可以读取完整文档文本，也可以读取用户标记的特定选区。',
      parameters: {
        type: 'object' as const,
        properties: {
          artifact_id: {
            type: 'string',
            description: '文档的唯一ID。使用 list_documents 获取可用文档列表。'
          },
          region_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '可选的选区ID列表。如果提供,则只返回这些选区的内容。'
          }
        },
        required: ['artifact_id']
      }
    },
    handler: async (args: Record<string, unknown>): Promise<unknown> => {
      const artifactId = String(args.artifact_id || '')
      const regionIds = Array.isArray(args.region_ids) ? args.region_ids.map(String) : undefined

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

      // Return full document text (possibly truncated)
      const maxLength = 80000
      const text = artifact.plainText
      return {
        fileName: artifact.fileName,
        fileType: artifact.fileType,
        totalLength: text.length,
        content: text.length > maxLength ? text.substring(0, maxLength) + '\n... (内容已截断)' : text
      }
    }
  }
}

export function toolListDocuments (documentStore: DocumentStore) {
  return {
    definition: {
      name: 'list_documents',
      description: '列出所有用户已导入的文档及其选区摘要。',
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
