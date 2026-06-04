/** Shared types for the drawing studio (image generation / editing). */

export type ImageStudioMode = 'generate' | 'edit'

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
  /** Number of images to generate (1-4). */
  n?: number
  /** Source images as base64 data URLs (edit mode). */
  inputImages?: string[]
}

/** A persisted library record enriched with inline data URLs for rendering. */
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
  fileName: string
  sourceImageFileNames?: string[]
  /** Generated image as a data URL. */
  dataUrl: string
  /** Source images (edit mode) as data URLs. */
  sourceDataUrls?: string[]
  /** Folder/group name for organizing images. */
  folder?: string
  /** Tags for searching/filtering images. */
  tags?: string[]
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
  /** First input image (edit mode) used as a thumbnail. */
  inputPreview?: string
  /** Generated results once the task succeeds. */
  entries: ImageLibraryEntry[]
  /** Error message when the task fails. */
  error?: string
}
