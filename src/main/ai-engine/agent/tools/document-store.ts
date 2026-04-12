/**
 * In-memory document store — manages imported DocumentArtifacts and user selections.
 * Lives in the main process, accessed through IPC from the renderer.
 */
import type {
  DocumentArtifact,
  SelectionRegion,
  SelectionRef,
  DocumentSummary,
  CreateSelectionPayload
} from './document-types.js'

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

  // --- Internal helpers ---

  private collectAllNodeIds (nodes: import('./document-types.js').DocumentNode[]): string[] {
    const ids: string[] = []
    for (const node of nodes) {
      ids.push(node.id)
      if (node.children) ids.push(...this.collectAllNodeIds(node.children))
    }
    return ids
  }

  private buildNodeMap (nodes: import('./document-types.js').DocumentNode[]): Map<string, import('./document-types.js').DocumentNode> {
    const map = new Map<string, import('./document-types.js').DocumentNode>()
    const walk = (list: import('./document-types.js').DocumentNode[]) => {
      for (const node of list) {
        map.set(node.id, node)
        if (node.children) walk(node.children)
      }
    }
    walk(nodes)
    return map
  }
}
