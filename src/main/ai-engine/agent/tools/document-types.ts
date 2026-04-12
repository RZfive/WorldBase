/**
 * Document model types for structured document parsing, preview, and annotation.
 * Used across main process (parsers, store, IPC) and renderer (preview, selection).
 */

/** Supported document file types. */
export type DocumentFileType = 'pdf' | 'xlsx' | 'docx' | 'pptx' | 'unknown'

/** Real preview strategy attached to an imported document. */
export interface DocumentRenderPreview {
  /** Whether the renderer should use a PDF preview, generated HTML, or structured DOM. */
  kind: 'pdf' | 'html' | 'structured'
  /** How the preview asset was produced. */
  source: 'original' | 'generated' | 'fallback'
  /** Whether the preferred preview path is currently available. */
  status: 'ready' | 'unavailable'
  /** MIME type for the render asset when status=ready. */
  mimeType?: string
  /** Internal on-disk asset location (main process use). */
  assetPath?: string
  /** Human-readable failure reason when preview generation failed. */
  error?: string
  /** Timestamp for render asset generation. */
  generatedAt: string
}

/** A single logical unit within a parsed document (paragraph, table row, slide, etc.). */
export interface DocumentNode {
  /** Unique id within the document. */
  id: string
  /** Node type — determines how the renderer visualises it. */
  type: 'heading' | 'paragraph' | 'table' | 'table_row' | 'slide' | 'page' | 'sheet' | 'image_placeholder' | 'list_item'
  /** Main text content. */
  text: string
  /** Nesting level (heading level, slide number, sheet index, etc.). */
  level: number
  /** Page / sheet / slide number (1-based). */
  pageIndex: number
  /** Optional children – for tables containing rows, sheets containing cells, etc. */
  children?: DocumentNode[]
  /** Extra metadata (e.g. table column headers, cell coordinates). */
  meta?: Record<string, unknown>
}

/** The complete parsed result of a single document import. */
export interface DocumentArtifact {
  /** Unique artifact id (UUID). */
  id: string
  /** Original file path on disk. */
  filePath: string
  /** Display file name. */
  fileName: string
  /** File size in bytes. */
  fileSize: number
  /** Detected document type. */
  fileType: DocumentFileType
  /** Flat text representation (for backward compat and AI prompt injection). */
  plainText: string
  /** Structured node tree – preserves document hierarchy for preview rendering. */
  nodes: DocumentNode[]
  /** Real preview metadata used by the renderer host. */
  render?: DocumentRenderPreview
  /** Import timestamp. */
  importedAt: string
}

/** A user-created selection / annotation region on a document preview. */
export interface SelectionRegion {
  /** Unique region id (UUID). */
  id: string
  /** Artifact this region belongs to. */
  artifactId: string
  /** IDs of the selected DocumentNodes (ordered). */
  nodeIds: string[]
  /** User-provided label / note for this selection. */
  label: string
  /** Hex colour tag for visual distinction. */
  color: string
  /** Exact highlighted excerpt when the tag was created from preview selection. */
  excerpt?: string
  /** Creation timestamp. */
  createdAt: string
}

/** Lightweight reference to a selection, suitable for injection into AI prompts. */
export interface SelectionRef {
  regionId: string
  artifactId: string
  fileName: string
  label: string
  /** The concatenated text of the selected nodes. */
  selectedText: string
}

/** Result returned by the document import IPC. */
export interface DocumentImportResult {
  artifact: DocumentArtifact
}

/** Binary render asset delivered to the renderer on demand. */
export interface DocumentRenderAsset {
  mimeType: string
  bytes: Uint8Array
}

/** Payload for the renderer → main IPC to create a selection. */
export interface CreateSelectionPayload {
  artifactId: string
  nodeIds: string[]
  label: string
  color: string
  excerpt?: string
}

/** Summary info sent to the renderer for the document dock list. */
export interface DocumentSummary {
  id: string
  fileName: string
  fileType: DocumentFileType
  fileSize: number
  nodeCount: number
  selectionCount: number
  importedAt: string
}
