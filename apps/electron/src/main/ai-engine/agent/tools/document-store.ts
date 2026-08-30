/**
 * In-memory document store — manages imported DocumentArtifacts and user selections.
 * Lives in the main process, accessed through IPC from the renderer.
 */
import type {
  DocumentArtifact,
  DocumentNode,
  SelectionRegion,
  SelectionRef,
  DocumentSummary,
  CreateSelectionPayload
} from './document-types.js'

interface DocumentChunkEntry {
  nodeId: string
  pageIndex: number
  text: string
}

export interface DocumentArtifactChunk {
  chunkIndex: number
  content: string
  startNodeId: string | null
  endNodeId: string | null
  startPageIndex: number | null
  endPageIndex: number | null
}

function generateId (): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export class DocumentStore {
  private artifacts = new Map<string, DocumentArtifact>()
  private selections = new Map<string, SelectionRegion>()

  /** Store a parsed artifact. Returns the artifact id. */
  addArtifact (artifact: DocumentArtifact): string {
    this.artifacts.set(artifact.id, artifact)
    return artifact.id
  }

  /** Get a single artifact by id. */
  getArtifact (id: string): DocumentArtifact | null {
    return this.artifacts.get(id) ?? null
  }

  /** Remove an artifact and all its associated selections. */
  removeArtifact (id: string): boolean {
    const deleted = this.artifacts.delete(id)
    if (deleted) {
      for (const [selId, sel] of this.selections) {
        if (sel.artifactId === id) this.selections.delete(selId)
      }
    }
    return deleted
  }

  /** List all imported document summaries. */
  listSummaries (): DocumentSummary[] {
    const result: DocumentSummary[] = []
    for (const artifact of this.artifacts.values()) {
      const selectionCount = Array.from(this.selections.values())
        .filter(sel => sel.artifactId === artifact.id).length
      result.push({
        id: artifact.id,
        filePath: artifact.filePath,
        fileName: artifact.fileName,
        fileType: artifact.fileType,
        fileSize: artifact.fileSize,
        nodeCount: artifact.nodes.length,
        selectionCount,
        importedAt: artifact.importedAt
      })
    }
    return result
  }

  /** Create a new selection region on an artifact. */
  createSelection (payload: CreateSelectionPayload): SelectionRegion {
    const artifact = this.artifacts.get(payload.artifactId)
    if (!artifact) throw new Error(`文档不存在: ${payload.artifactId}`)

    const excerpt = payload.excerpt?.trim()
    if (payload.nodeIds.length === 0 && !excerpt) {
      throw new Error('选区不能为空')
    }

    if (payload.nodeIds.length > 0) {
      const nodeIdSet = new Set(this.collectAllNodeIds(artifact.nodes))
      for (const nid of payload.nodeIds) {
        if (!nodeIdSet.has(nid)) throw new Error(`节点不存在: ${nid}`)
      }
    }

    const region: SelectionRegion = {
      id: generateId(),
      artifactId: payload.artifactId,
      nodeIds: payload.nodeIds,
      label: payload.label || '未命名选区',
      color: payload.color || '#3b82f6',
      excerpt: excerpt || undefined,
      createdAt: new Date().toISOString()
    }

    this.selections.set(region.id, region)
    return region
  }

  /** Remove a selection. */
  removeSelection (id: string): boolean {
    return this.selections.delete(id)
  }

  /** Update label of a selection. */
  updateSelectionLabel (id: string, label: string): SelectionRegion | null {
    const sel = this.selections.get(id)
    if (!sel) return null
    sel.label = label
    return sel
  }

  /** Get all selections for a given artifact. */
  getSelectionsForArtifact (artifactId: string): SelectionRegion[] {
    return Array.from(this.selections.values())
      .filter(sel => sel.artifactId === artifactId)
  }

  /** Get all selections across all artifacts. */
  getAllSelections (): SelectionRegion[] {
    return Array.from(this.selections.values())
  }

  /**
   * Build SelectionRef objects for prompt injection.
   * These contain the actual text content from the selected nodes.
   */
  buildSelectionRefs (regionIds?: string[]): SelectionRef[] {
    const regions = regionIds
      ? regionIds.map(id => this.selections.get(id)).filter(Boolean) as SelectionRegion[]
      : Array.from(this.selections.values())

    return regions.map(region => {
      const artifact = this.artifacts.get(region.artifactId)
      if (!artifact) return null

      const nodeMap = this.buildNodeMap(artifact.nodes)
      const selectedText = region.excerpt?.trim() || region.nodeIds
        .map(nid => nodeMap.get(nid)?.text ?? '')
        .filter(Boolean)
        .join('\n')

      return {
        regionId: region.id,
        artifactId: region.artifactId,
        fileName: artifact.fileName,
        label: region.label,
        selectedText
      } satisfies SelectionRef
    }).filter(Boolean) as SelectionRef[]
  }

  /** Build a prompt string from selections for AI consumption. */
  buildSelectionsPrompt (regionIds?: string[]): string {
    const refs = this.buildSelectionRefs(regionIds)
    if (refs.length === 0) return ''

    return refs.map(ref => {
      return `【文档选区：${ref.fileName} — ${ref.label}】\n${ref.selectedText}\n【选区结束】`
    }).join('\n\n')
  }

  /** Get the full text of a specific artifact (for agent tools). */
  getArtifactText (artifactId: string): string | null {
    const artifact = this.artifacts.get(artifactId)
    return artifact?.plainText ?? null
  }

  /** Build bounded, structure-aware chunks for AI reads of large documents. */
  getArtifactChunks (artifactId: string, maxChars = 12000): DocumentArtifactChunk[] | null {
    const artifact = this.artifacts.get(artifactId)
    if (!artifact) return null

    const normalizedMaxChars = this.normalizeChunkSize(maxChars)
    return this.buildArtifactChunks(artifact.nodes, normalizedMaxChars, artifact.plainText)
  }

  // --- Internal helpers ---

  private normalizeChunkSize (maxChars: number): number {
    if (!Number.isFinite(maxChars)) return 12000
    return Math.min(30000, Math.max(2000, Math.floor(maxChars)))
  }

  private buildArtifactChunks (nodes: DocumentNode[], maxChars: number, fallbackText: string): DocumentArtifactChunk[] {
    const entries = this.collectChunkEntries(nodes)

    if (entries.length === 0) {
      return [{
        chunkIndex: 0,
        content: fallbackText.trim() || '(无文本内容)',
        startNodeId: null,
        endNodeId: null,
        startPageIndex: null,
        endPageIndex: null
      }]
    }

    const rawChunks: Array<Omit<DocumentArtifactChunk, 'chunkIndex'>> = []
    let currentEntries: DocumentChunkEntry[] = []
    let currentLength = 0

    const flushCurrentEntries = () => {
      if (currentEntries.length === 0) return
      rawChunks.push({
        content: currentEntries.map(entry => entry.text).join('\n\n'),
        startNodeId: currentEntries[0]?.nodeId ?? null,
        endNodeId: currentEntries[currentEntries.length - 1]?.nodeId ?? null,
        startPageIndex: currentEntries[0]?.pageIndex ?? null,
        endPageIndex: currentEntries[currentEntries.length - 1]?.pageIndex ?? null
      })
      currentEntries = []
      currentLength = 0
    }

    for (const entry of entries) {
      const segments = this.segmentChunkEntry(entry, maxChars)

      for (const segment of segments) {
        const nextLength = currentLength === 0
          ? segment.text.length
          : currentLength + 2 + segment.text.length

        if (currentEntries.length > 0 && nextLength > maxChars) {
          flushCurrentEntries()
        }

        currentEntries.push(segment)
        currentLength = currentLength === 0
          ? segment.text.length
          : currentLength + 2 + segment.text.length
      }
    }

    flushCurrentEntries()

    return rawChunks.map((chunk, chunkIndex) => ({
      chunkIndex,
      ...chunk
    }))
  }

  private collectChunkEntries (nodes: DocumentNode[]): DocumentChunkEntry[] {
    const entries: DocumentChunkEntry[] = []

    const walk = (list: DocumentNode[]) => {
      for (const node of list) {
        const text = this.formatChunkNodeText(node)
        if (text) {
          entries.push({
            nodeId: node.id,
            pageIndex: node.pageIndex,
            text
          })
        }

        if (node.children?.length) {
          walk(node.children)
        }
      }
    }

    walk(nodes)
    return entries
  }

  private formatChunkNodeText (node: DocumentNode): string {
    const text = node.text?.trim()
    if (!text) return ''

    switch (node.type) {
      case 'heading':
        return `${'#'.repeat(Math.min(Math.max(node.level || 1, 1), 6))} ${text}`
      case 'page':
        return `[页面 ${node.pageIndex}]`
      case 'sheet':
        return `[工作表 ${text}]`
      case 'slide':
        return `[幻灯片 ${node.pageIndex}]`
      case 'table_row':
      case 'list_item':
        return `- ${text}`
      case 'image_placeholder':
        return `[图片占位] ${text}`
      default:
        return text
    }
  }

  private segmentChunkEntry (entry: DocumentChunkEntry, maxChars: number): DocumentChunkEntry[] {
    if (entry.text.length <= maxChars) {
      return [entry]
    }

    const segments: DocumentChunkEntry[] = []
    let cursor = 0
    while (cursor < entry.text.length) {
      segments.push({
        ...entry,
        text: entry.text.slice(cursor, cursor + maxChars)
      })
      cursor += maxChars
    }

    return segments
  }

  private collectAllNodeIds (nodes: DocumentNode[]): string[] {
    const ids: string[] = []
    for (const node of nodes) {
      ids.push(node.id)
      if (node.children) ids.push(...this.collectAllNodeIds(node.children))
    }
    return ids
  }

  private buildNodeMap (nodes: DocumentNode[]): Map<string, DocumentNode> {
    const map = new Map<string, DocumentNode>()
    const walk = (list: DocumentNode[]) => {
      for (const node of list) {
        map.set(node.id, node)
        if (node.children) walk(node.children)
      }
    }
    walk(nodes)
    return map
  }
}
