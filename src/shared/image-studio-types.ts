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
}

export type ImageStudioGenerateResponse =
  | { ok: true; entries: ImageLibraryEntry[] }
  | { ok: false; error: string }
