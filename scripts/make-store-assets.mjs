// Renders the Microsoft Store (MSIX) tile and icon images into build/appx from resources/icon.svg.
// electron-builder's appx target picks them up; the scale-/targetsize- variants keep them sharp at
// every display scaling. Run with: npm run store-assets
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'resources', 'icon.svg'))
const out = join(root, 'build', 'appx')
mkdirSync(out, { recursive: true })
for (const f of readdirSync(out)) if (f.endsWith('.png')) rmSync(join(out, f))

/** The icon at `size` pixels (rendered from the SVG at that size, not scaled down from a big PNG). */
const icon = (size) => sharp(svg, { density: Math.max(72, (72 * size) / 512) * 1.5 }).resize(size, size).png().toBuffer()

/** The icon centred on a transparent w×h canvas, `fraction` of the shorter side. */
async function tile(w, h, fraction) {
  const s = Math.round(Math.min(w, h) * fraction)
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await icon(s), left: Math.round((w - s) / 2), top: Math.round((h - s) / 2) }])
    .png()
    .toBuffer()
}

const jobs = []
const save = (name, buf) => jobs.push(Promise.resolve(buf).then((b) => sharp(b).toFile(join(out, name))))

// app list, taskbar, title bar: the icon itself, at the sizes Windows asks for
for (const [scale, px] of [[100, 44], [125, 55], [150, 66], [200, 88], [400, 176]]) save(`Square44x44Logo.scale-${scale}.png`, icon(px))
for (const px of [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256]) {
  save(`Square44x44Logo.targetsize-${px}.png`, icon(px))
  save(`Square44x44Logo.targetsize-${px}_altform-unplated.png`, icon(px))
  save(`Square44x44Logo.targetsize-${px}_altform-lightunplated.png`, icon(px))
}
// Store listing and package logo
for (const [scale, px] of [[100, 50], [125, 63], [150, 75], [200, 100], [400, 200]]) save(`StoreLogo.scale-${scale}.png`, icon(px))
// Start tiles (Windows 10): the icon on a transparent tile
for (const [scale, k] of [[100, 1], [200, 2], [400, 4]]) {
  save(`Square150x150Logo.scale-${scale}.png`, tile(150 * k, 150 * k, 0.62))
  save(`Wide310x150Logo.scale-${scale}.png`, tile(310 * k, 150 * k, 0.62))
  save(`LargeTile.scale-${scale}.png`, tile(310 * k, 310 * k, 0.55))
  save(`SmallTile.scale-${scale}.png`, tile(71 * k, 71 * k, 0.7))
}
await Promise.all(jobs)
console.log(`wrote ${jobs.length} images to ${out}`)
