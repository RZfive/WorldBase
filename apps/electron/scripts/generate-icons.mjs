// Regenerate the packaged-app icons (public/icon-mac.png, public/icon.png,
// public/icon.ico) from the WorldBase mascot artwork in build/icon-src.svg.
//
// macOS gets the Big Sur treatment: the artwork masked into an 824px squircle
// on a 1024px canvas with a baked soft shadow and transparent corners. Windows
// / Linux use the full-bleed square. Usage: node scripts/generate-icons.mjs
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const electronDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const srcSvgPath = path.join(electronDir, 'build', 'icon-src.svg')
const publicDir = path.join(electronDir, 'public')

const svgBuffer = fs.readFileSync(srcSvgPath)

// macOS icon grid (Big Sur template): 824px rounded square on a 1024px
// canvas, corner radius ≈ 185, ~100px margins.
const MAC_CANVAS = 1024
const MAC_BOX = 824
const MAC_MARGIN = (MAC_CANVAS - MAC_BOX) / 2
const MAC_RADIUS = 185

function roundedRect ({ inset = 0, offsetY = 0, fill = '#000000', opacity = 1 } = {}) {
  const x = MAC_MARGIN + inset
  const y = MAC_MARGIN + offsetY + inset
  const size = MAC_BOX - inset * 2
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${MAC_RADIUS - inset}" fill="${fill}" fill-opacity="${opacity}"/>`
}

async function macIcon () {
  // Artwork scaled below the squircle box so the mascot keeps breathing room
  // inside the rounded corners instead of bleeding off them.
  const ART_SIZE = 860
  const artOffset = Math.round((MAC_CANVAS - ART_SIZE) / 2)
  const artwork = await sharp(svgBuffer, { density: 96 })
    .resize(ART_SIZE, ART_SIZE)
    .png()
    .toBuffer()
  const squircleFill = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MAC_CANVAS}" height="${MAC_CANVAS}">${roundedRect({ fill: '#FCF2E5' })}</svg>`
  )
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MAC_CANVAS}" height="${MAC_CANVAS}">${roundedRect()}</svg>`
  )
  // Baked soft drop shadow, as shipped in real Big Sur+ .icns assets.
  const shadow = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${MAC_CANVAS}" height="${MAC_CANVAS}">${roundedRect({ offsetY: 14, opacity: 0.28 })}</svg>`
    )
  ).blur(22).png().toBuffer()
  const composed = await sharp({ create: { width: MAC_CANVAS, height: MAC_CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: squircleFill },
      { input: artwork, left: artOffset, top: artOffset }
    ])
    .png()
    .toBuffer()
  const masked = await sharp(composed)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer()
  return sharp({ create: { width: MAC_CANVAS, height: MAC_CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: shadow }, { input: masked }])
    .png()
    .toBuffer()
}

// Minimal ICO container around PNG blobs (PNG-embedded entries, Vista+).
function buildIco (pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + pngs.length * 16
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0) // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1) // height
    entry.writeUInt8(0, 2) // palette
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(entry)
  }
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)])
}

const macPng = await macIcon()
const smallPng = await sharp(svgBuffer, { density: 96 }).resize(256, 256).png().toBuffer()

fs.writeFileSync(path.join(publicDir, 'icon-mac.png'), macPng)
fs.writeFileSync(path.join(publicDir, 'icon.png'), smallPng)

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoPngs = []
for (const size of icoSizes) {
  const data = await sharp(svgBuffer, { density: 96 }).resize(size, size).png().toBuffer()
  icoPngs.push({ size, data })
}
fs.writeFileSync(path.join(publicDir, 'icon.ico'), buildIco(icoPngs))

console.log('[generate-icons] wrote icon-mac.png (1024), icon.png (256), icon.ico (' + icoSizes.join('/') + ')')
