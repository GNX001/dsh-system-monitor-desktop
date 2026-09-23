/**
 * Generate the app and tray icons.
 *
 * Written by hand rather than pulled from an image library: a PNG is a handful
 * of zlib chunks and an ICO is a small directory in front of one — cheaper than
 * another dependency for two small drawings, and it keeps the build reproducible
 * from a clean checkout.
 *
 *   node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'assets')

// --- minimal PNG/ICO writer ---------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Encode straight RGBA bytes as a PNG. */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Wrap one PNG as a single-entry ICO (PNG-in-ICO is valid for every size). */
function encodeIco(png, size) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // one image
  const entry = Buffer.alloc(16)
  entry[0] = size >= 256 ? 0 : size
  entry[1] = size >= 256 ? 0 : size
  entry[2] = 0 // palette
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // colour planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(6 + 16, 12)
  return Buffer.concat([header, entry, png])
}

// --- drawing ------------------------------------------------------------------

/** A tiny canvas with anti-aliased rounded rectangles. */
function createCanvas(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const blend = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return
    const at = (y * size + x) * 4
    const alpha = a / 255
    pixels[at] = Math.round(pixels[at] * (1 - alpha) + r * alpha)
    pixels[at + 1] = Math.round(pixels[at + 1] * (1 - alpha) + g * alpha)
    pixels[at + 2] = Math.round(pixels[at + 2] * (1 - alpha) + b * alpha)
    pixels[at + 3] = Math.max(pixels[at + 3], a)
  }
  return {
    pixels,
    /** Rounded rectangle covering `[x, x+w) × [y, y+h)`. */
    roundRect(x0, y0, w, h, radius, color) {
      const x1 = x0 + w
      const y1 = y0 + h
      for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y += 1) {
        for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x += 1) {
          // Sample 3×3 to soften the corners.
          let hits = 0
          for (const dy of [0.17, 0.5, 0.83]) {
            for (const dx of [0.17, 0.5, 0.83]) {
              const px = x + dx
              const py = y + dy
              const cx = Math.min(Math.max(px, x0 + radius), x1 - radius)
              const cy = Math.min(Math.max(py, y0 + radius), y1 - radius)
              const inside = px >= x0 && px <= x1 && py >= y0 && py <= y1
              if (!inside) continue
              const distance = (px - cx) ** 2 + (py - cy) ** 2
              if (distance <= radius * radius) hits += 1
            }
          }
          if (hits === 0) continue
          blend(x, y, [color[0], color[1], color[2], Math.round((color[3] * hits) / 9)])
        }
      }
    },
  }
}

const ACCENT = [77, 107, 254, 255]
const ACCENT_SOFT = [143, 165, 255, 255]
const INK = [22, 24, 30, 255]

/**
 * The mark: a capsule (the bar itself) with four metric dots on it, on a dark
 * rounded tile. Drawn from the same idea as the UI, so the icon is recognisable
 * at 32px in the tray.
 */
function drawIcon(size, { background }) {
  const canvas = createCanvas(size)
  const unit = size / 32

  if (background) {
    canvas.roundRect(0, 0, size, size, size * 0.22, INK)
  }
  // The capsule.
  const barHeight = 9 * unit
  const barTop = (size - barHeight) / 2
  const inset = 5 * unit
  canvas.roundRect(inset, barTop, size - inset * 2, barHeight, barHeight / 2, ACCENT)
  // Four dots on it — the metrics.
  const dotRadius = 1.35 * unit
  const dotY = barTop + barHeight / 2
  for (const fraction of [0.18, 0.39, 0.6, 0.81]) {
    const dotX = inset + (size - inset * 2) * fraction
    canvas.roundRect(dotX - dotRadius, dotY - dotRadius, dotRadius * 2, dotRadius * 2, dotRadius, ACCENT_SOFT)
  }
  return canvas.pixels
}

await mkdir(assets, { recursive: true })

const iconSize = 256
const iconPng = encodePng(iconSize, iconSize, drawIcon(iconSize, { background: true }))
await writeFile(join(assets, 'icon.png'), iconPng)
await writeFile(join(assets, 'icon.ico'), encodeIco(iconPng, iconSize))

const traySize = 32
const trayPng = encodePng(traySize, traySize, drawIcon(traySize, { background: false }))
await writeFile(join(assets, 'tray.png'), trayPng)

console.log(`[icons] icon.png  ${iconSize}x${iconSize} (${iconPng.length} B)`)
console.log(`[icons] icon.ico  ${iconSize}x${iconSize} (${iconPng.length + 22} B)`)
console.log(`[icons] tray.png  ${traySize}x${traySize} (${trayPng.length} B)`)
