/**
 * Colour helpers for office previews: hex ⇄ RGB ⇄ HLS conversion plus the
 * luminance transforms used by Office theme colours (xlsx `tint` on style
 * colours, pptx `lumMod`/`lumOff`/`tint`/`shade` inside DrawingML).
 */

export interface Rgb { r: number; g: number; b: number }

export function normalizeHex (hex: string): string | null {
  const value = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null
  return value.toUpperCase()
}

export function hexToRgb (hex: string): Rgb {
  const value = normalizeHex(hex) ?? '000000'
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  }
}

export function rgbToHex ({ r, g, b }: Rgb): string {
  const clamp = (n: number) => Math.min(255, Math.max(0, Math.round(n)))
  return [r, g, b].map(n => clamp(n).toString(16).padStart(2, '0')).join('').toUpperCase()
}

function rgbToHls ({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, l, 0]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return [h, l, s]
}

function hlsToRgb (h: number, l: number, s: number): Rgb {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 }
  const hueToRgb = (p: number, q: number, t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: hueToRgb(p, q, h + 1 / 3) * 255,
    g: hueToRgb(p, q, h) * 255,
    b: hueToRgb(p, q, h - 1 / 3) * 255
  }
}

/**
 * Excel theme-colour tint (MS-OI29500): negative tints scale luminance down,
 * positive tints scale it up towards white.
 */
export function applyXlsxTint (hex: string, tint: number): string {
  if (!tint) return normalizeHex(hex) ?? '000000'
  const [h, l, s] = rgbToHls(hexToRgb(hex))
  const adjusted = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint
  return rgbToHex(hlsToRgb(h, Math.min(1, Math.max(0, adjusted)), s))
}

export interface PptxColorMods {
  lumMod?: number
  lumOff?: number
  tint?: number
  shade?: number
  satMod?: number
}

/**
 * DrawingML colour transforms, applied in the typical authoring order.
 * Percent values arrive as fractions of 100 (e.g. lumMod 60000 → 0.6).
 */
export function applyPptxColorMods (hex: string, mods: PptxColorMods): string {
  let [h, l, s] = rgbToHls(hexToRgb(hex))
  if (mods.lumMod !== undefined) l *= mods.lumMod
  if (mods.lumOff !== undefined) l += mods.lumOff
  if (mods.tint !== undefined) l = l * (1 - mods.tint) + mods.tint
  if (mods.shade !== undefined) l = l * (1 - mods.shade)
  if (mods.satMod !== undefined) s = Math.min(1, s * mods.satMod)
  l = Math.min(1, Math.max(0, l))
  s = Math.min(1, Math.max(0, s))
  return rgbToHex(hlsToRgb(h, l, s))
}
