/** Shared types for the drawing studio (image generation / editing). */

export type ImageStudioMode = 'generate' | 'edit'
export type ImageStudioImageQuality = 'auto' | 'low' | 'medium' | 'high'
export type ImageStudioOutputFormat = 'png' | 'jpeg' | 'webp'

/** Request payload sent from the renderer to generate or edit images. */
export interface ImageStudioGenerateRequest {
  providerId: string
  model: string
  mode: ImageStudioMode
  prompt: string
  negativePrompt?: string
  /** Aspect ratio preset label, e.g. '1:1'. */
  aspectRatio?: string
  /** Final pixel size, e.g. '1024x1024'. */
  size: string
  /** Provider image quality setting. GPT Image models support auto / low / medium / high. */
  quality?: ImageStudioImageQuality
  /** Requested output file format for providers that support it. */
  outputFormat?: ImageStudioOutputFormat
  /** Number of images to generate (1-4). */
  n?: number
  /** Source images as base64 data URLs (edit mode). */
  inputImages?: string[]
  /** Optional library folder to file the generated images under. */
  folder?: string
  /** Optional tags applied to the generated images. */
  tags?: string[]
}

/** A persisted library record returned after generation/editing. */
export interface ImageLibraryEntry {
  id: string
  createdAt: string
  mode: ImageStudioMode
  providerId: string
  model: string
  prompt: string
  negativePrompt?: string
  aspectRatio?: string
  size: string
  quality?: ImageStudioImageQuality
  outputFormat?: ImageStudioOutputFormat
  fileName: string
  sourceImageFileNames?: string[]
  width?: number
  height?: number
  /**
   * Generated image as a data URL. Optional for new records: the studio prefers
   * `fullUrl`/`thumbUrl` so large PNG bytes are streamed on demand instead of
   * being retained in renderer state.
   */
  dataUrl?: string
  /** Source images (edit mode) as data URLs, fetched only when needed. */
  sourceDataUrls?: string[]
  /** Folder/group name for organizing images. */
  folder?: string
  /** Tags for searching/filtering images. */
  tags?: string[]
  /** studio-img:// URL for the cached thumbnail (gallery rendering). */
  thumbUrl?: string
  /** studio-img:// URL for the full-resolution image. */
  fullUrl?: string
}

/**
 * Lightweight library item for the gallery: metadata + studio-img:// URLs, with
 * NO inline base64. The renderer holds thousands of these cheaply and lets the
 * custom protocol stream thumbnails/originals on demand.
 */
export interface ImageLibraryItem {
  id: string
  createdAt: string
  mode: ImageStudioMode
  providerId: string
  model: string
  prompt: string
  negativePrompt?: string
  aspectRatio?: string
  size: string
  quality?: ImageStudioImageQuality
  outputFormat?: ImageStudioOutputFormat
  folder?: string
  tags?: string[]
  width?: number
  height?: number
  /** studio-img:// URL for the cached thumbnail. */
  thumbUrl: string
  /** studio-img:// URL for the full-resolution image. */
  fullUrl: string
}

/** Filters for a paginated library query. */
export interface ImageLibraryQuery {
  /**
   * Scope. Omitted/undefined → unfiled images only (root view).
   * A folder name → that folder. '*' → all images (used during search).
   */
  folder?: string
  /** Free-text search across prompt / negative prompt / tags / folder. */
  search?: string
  /** Only items carrying all of these tags. */
  tags?: string[]
  limit?: number
  offset?: number
}

/** A page of library items plus paging metadata. */
export interface ImageLibraryPage {
  items: ImageLibraryItem[]
  /** Total matching the query (ignoring paging). */
  total: number
  /** Offset to request next, or null when exhausted. */
  nextOffset: number | null
}

/** Full image bytes fetched on demand for edit-input / save-to-file / regenerate. */
export interface ImageLibraryData {
  dataUrl: string
  sourceDataUrls?: string[]
}

/** Folder card for the root view: name, count, and up-to-4 cover thumbnail URLs. */
export interface ImageLibraryFolderCard {
  name: string
  count: number
  coverThumbUrls: string[]
}

/** Folder definition for the image library. */
export interface ImageLibraryFolder {
  name: string
  /** Number of images in this folder. */
  count: number
}

/** Request to optimize a prompt using AI. */
export interface PromptOptimizeRequest {
  providerId: string
  model: string
  prompt: string
  /** Whether this is a negative prompt. */
  isNegative?: boolean
}

/** Response from AI prompt optimization. */
export interface PromptOptimizeResponse {
  ok: boolean
  optimizedPrompt?: string
  error?: string
}

export type ImageStudioGenerateResponse =
  | { ok: true; entries: ImageLibraryEntry[] }
  | { ok: false; error: string }

/** Lifecycle status of a queued generation/edit task. */
export type ImageStudioTaskStatus = 'queued' | 'running' | 'success' | 'error'

/** A single generation/edit job tracked by the studio task queue. */
export interface ImageStudioTask {
  id: string
  status: ImageStudioTaskStatus
  /** Monotonic creation timestamp (ms) used for ordering. */
  createdAt: number
  request: ImageStudioGenerateRequest
  /** Short label derived from the request prompt for display. */
  label: string
  /** True when the task was queued by the AI agent (vs. the workbench form). */
  createdByAgent?: boolean
  /** First input image (edit mode) used as a thumbnail. */
  inputPreview?: string
  /** Generated results once the task succeeds. */
  entries: ImageLibraryEntry[]
  /** Error message when the task fails. */
  error?: string
}
