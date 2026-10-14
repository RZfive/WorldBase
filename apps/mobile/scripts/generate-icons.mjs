// Regenerate the mobile app icons from the same WorldBase mascot artwork as
// the Electron desktop build (apps/electron/build/icon-src.svg), so the
// installed app icon matches the desktop icon everywhere.
//
// - iOS AppIcon.appiconset: full-bleed square (the OS masks the corners).
// - Android legacy mipmaps: full-bleed square ic_launcher.png per density.
// - Android 8+ adaptive icon: cream background color + the bare artwork
//   (SVG background rect stripped) centered in the foreground safe zone.
// - macOS Runner: reuses the desktop Big Sur squircle render icon-mac.png.
//
// Usage: node scripts/generate-icons.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const mobileDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const repoDir = path.resolve(mobileDir, '..', '..')
const srcSvgPath = path.join(repoDir, 'apps', 'electron', 'build', 'icon-src.svg')
const macSquirclePath = path.join(repoDir, 'apps', 'electron', 'public', 'icon-mac.png')

// sharp is a dependency of the electron app; resolve it from there.
const requireFromElectron = createRequire(path.join(repoDir, 'apps', 'electron', 'package.json'))
const sharp = requireFromElectron('sharp')

const svgBuffer = fs.readFileSync(srcSvgPath)
// The artwork ships with a full-bleed cream rect; strip it for the adaptive
// icon foreground layer, which sits on the cream background color instead.
const artSvg = Buffer.from(
  svgBuffer.toString().replace(/<rect\s+width="1024"\s+height="1024"[^>]*\/>/, '')
)
const ADAPTIVE_BG = '#FCF2E5'
// Adaptive-icon viewport shows the central ~72/108dp; keep the artwork inside
// it (with margin) so no launcher mask or parallax crop clips the mascot.
const FG_ART_RATIO = 0.6

async function renderSquare (svg, size) {
  return sharp(svg, { density: 96 }).resize(size, size).png().toBuffer()
}

async function renderForeground (canvas) {
  const art = Math.round(canvas * FG_ART_RATIO)
  const artPng = await renderSquare(artSvg, art)
  return sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: artPng, gravity: 'centre' }])
    .png()
    .toBuffer()
}

async function generateIosIcons () {
  const dir = path.join(mobileDir, 'ios', 'Runner', 'Assets.xcassets', 'AppIcon.appiconset')
  const contents = JSON.parse(fs.readFileSync(path.join(dir, 'Contents.json'), 'utf8'))
  for (const image of contents.images) {
    const size = Math.round(parseFloat(image.size) * parseInt(image.scale, 10))
    fs.writeFileSync(path.join(dir, image.filename), await renderSquare(svgBuffer, size))
  }
  console.log(`iOS AppIcon: ${contents.images.length} entries updated`)
}

async function generateAndroidIcons () {
  const resDir = path.join(mobileDir, 'android', 'app', 'src', 'main', 'res')
  const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }
  for (const [density, size] of Object.entries(densities)) {
    const dir = path.join(resDir, `mipmap-${density}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), await renderSquare(svgBuffer, size))
    // Adaptive foreground canvas is 108dp regardless of launcher icon size.
    const fgCanvas = size * (108 / 48)
    fs.writeFileSync(
      path.join(dir, 'ic_launcher_foreground.png'),
      await renderForeground(fgCanvas)
    )
  }

  const anydpiDir = path.join(resDir, 'mipmap-anydpi-v26')
  fs.mkdirSync(anydpiDir, { recursive: true })
  fs.writeFileSync(
    path.join(anydpiDir, 'ic_launcher.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`
  )

  const colorsPath = path.join(resDir, 'values', 'colors.xml')
  const colorEntry = '    <color name="ic_launcher_background">#FCF2E5</color>'
  if (fs.existsSync(colorsPath)) {
    const xml = fs.readFileSync(colorsPath, 'utf8')
    if (!xml.includes('ic_launcher_background')) {
      fs.writeFileSync(colorsPath, xml.replace('</resources>', `${colorEntry}\n</resources>`))
    }
  } else {
    fs.writeFileSync(
      colorsPath,
      `<?xml version="1.0" encoding="utf-8"?>
<resources>
${colorEntry}
</resources>
`
    )
  }
  console.log('Android mipmaps + adaptive icon updated')
}

async function generateMacosIcons () {
  const dir = path.join(mobileDir, 'macos', 'Runner', 'Assets.xcassets', 'AppIcon.appiconset')
  const contents = JSON.parse(fs.readFileSync(path.join(dir, 'Contents.json'), 'utf8'))
  const squircle = sharp(macSquirclePath)
  const filenames = [...new Set(contents.images.map((image) => image.filename))]
  for (const filename of filenames) {
    const size = parseInt(filename.match(/app_icon_(\d+)\.png/)[1], 10)
    fs.writeFileSync(path.join(dir, filename), await squircle.clone().resize(size, size).png().toBuffer())
  }
  console.log(`macOS AppIcon: ${filenames.length} sizes updated`)
}

await generateIosIcons()
await generateAndroidIcons()
await generateMacosIcons()
