import type { Directive } from 'vue'

/**
 * Images inside chat messages (markdown `<img>` rendered via v-html, and the inline
 * image cards) have no intrinsic box until their bytes decode. In the virtual message
 * list a row is measured the moment it mounts, so an unsized image is measured at ~0px
 * and then jumps to its natural height on load — shifting every offset below it and
 * making the list jump while scrolling.
 *
 * We cache each image's natural size by URL and reserve the correct box up-front, so a
 * recycled row mounts at its final height and the list never has to re-measure it.
 */

interface ImageSize {
  width: number
  height: number
}

const IMAGE_SIZE_CACHE_LIMIT = 600
const imageSizeCache = new Map<string, ImageSize>()

function sourceKey (img: HTMLImageElement): string {
  return img.currentSrc || img.getAttribute('src') || ''
}

function rememberImageSize (url: string, width: number, height: number): void {
  if (!url || !width || !height) return
  if (imageSizeCache.has(url)) imageSizeCache.delete(url)
  imageSizeCache.set(url, { width, height })
  while (imageSizeCache.size > IMAGE_SIZE_CACHE_LIMIT) {
    const oldest = imageSizeCache.keys().next().value
    if (oldest === undefined) break
    imageSizeCache.delete(oldest)
  }
}

/**
 * Reserve layout for a single image.
 *
 * - `reserveWidth: false` (image cards): the element already has a definite width via
 *   CSS, so only an `aspect-ratio` is needed to lock in the height.
 * - `reserveWidth: true` (markdown images): width is `auto`, so an unloaded image has no
 *   definite dimension for `aspect-ratio` to act on. Pin a responsive width too.
 */
function stabilizeImage (img: HTMLImageElement, reserveWidth: boolean): void {
  const url = sourceKey(img)

  const applySize = (width: number, height: number): void => {
    if (!width || !height) return
    img.style.aspectRatio = `${width} / ${height}`
    if (reserveWidth) {
      img.style.width = `min(${width}px, 100%)`
      img.style.height = 'auto'
    }
  }

  // Already decoded (memory/HTTP cache): record and size immediately.
  if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
    rememberImageSize(url, img.naturalWidth, img.naturalHeight)
    applySize(img.naturalWidth, img.naturalHeight)
    return
  }

  const cached = imageSizeCache.get(url)
  if (cached) applySize(cached.width, cached.height)

  if (img.dataset.stableBound === '1') return
  img.dataset.stableBound = '1'
  img.addEventListener(
    'load',
    () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        rememberImageSize(sourceKey(img), img.naturalWidth, img.naturalHeight)
        applySize(img.naturalWidth, img.naturalHeight)
      }
    },
    { once: true }
  )
}

function stabilizeAll (root: HTMLElement, reserveWidth: boolean): void {
  if (root.tagName === 'IMG') {
    stabilizeImage(root as HTMLImageElement, reserveWidth)
    return
  }
  root.querySelectorAll('img').forEach(img => stabilizeImage(img, reserveWidth))
}

/** For containers whose HTML is set via v-html (markdown bodies). */
export const vStableImages: Directive<HTMLElement> = {
  mounted (el) {
    stabilizeAll(el, true)
  },
  updated (el) {
    stabilizeAll(el, true)
  }
}

/** For a single image element with a CSS-defined width (image cards). */
export const vStableImage: Directive<HTMLImageElement> = {
  mounted (el) {
    stabilizeImage(el, false)
  },
  updated (el) {
    stabilizeImage(el, false)
  }
}
