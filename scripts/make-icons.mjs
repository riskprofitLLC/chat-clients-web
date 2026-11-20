// Иконки PWA генерируются кодом: без графических библиотек и без
// бинарников в репозитории. Рисуем квадрат с пузырём чата, кодируем PNG
// вручную (zlib + CRC32) — этого достаточно для манифеста.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const OUT_DIR = resolve(import.meta.dirname, '../public/icons')

const ACCENT = [37, 99, 235]
const ACCENT_DARK = [23, 63, 158]
const WHITE = [255, 255, 255]

// maskable — full-bleed фон без скруглений и лого в «безопасной зоне» 80%:
// иначе Android рисует белые углы вокруг скруглённой иконки
function renderIcon(size, maskable = false) {
  const pixels = new Uint8Array(size * size * 4)
  const radius = size * 0.22
  const scale = maskable ? 0.72 : 1
  const shift = (size * (1 - scale)) / 2
  const bubble = {
    x0: shift + size * 0.24 * scale,
    x1: shift + size * 0.76 * scale,
    y0: shift + size * 0.28 * scale,
    y1: shift + size * 0.66 * scale,
    r: size * 0.1 * scale,
  }
  const tail = { x: shift + size * 0.34 * scale, y: shift + size * 0.62 * scale, w: size * 0.26 * scale }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // фон: скруглённый квадрат (обычная) или full-bleed (maskable)
      const inside = maskable || roundedSquare(x, y, size, radius)
      if (!inside) {
        pixels[i + 3] = 0
        continue
      }
      const t = y / size
      const bg = mix(ACCENT, ACCENT_DARK, t)
      let color = bg
      if (inBubble(x, y, bubble) || inTail(x, y, tail)) color = WHITE
      pixels[i] = color[0]
      pixels[i + 1] = color[1]
      pixels[i + 2] = color[2]
      pixels[i + 3] = 255
    }
  }
  return pixels
}

function mix(a, b, t) {
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t))
}

function roundedSquare(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius)
  const cy = Math.min(Math.max(y, radius), size - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

function inBubble(x, y, b) {
  if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) return false
  const cx = Math.min(Math.max(x, b.x0 + b.r), b.x1 - b.r)
  const cy = Math.min(Math.max(y, b.y0 + b.r), b.y1 - b.r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= b.r * b.r
}

function inTail(x, y, t) {
  // хвостик пузыря: треугольник, сходящий на нет вниз-вправо
  const rel = (x - t.x) / t.w
  if (rel < 0 || rel > 1) return false
  const height = t.w * (1 - rel)
  return y >= t.y && y <= t.y + height
}

// ─── PNG-энкодер ─────────────────────────────────────────────────────────

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

function encodePng(pixels, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // фильтр None
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // бит на канал
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of [192, 512]) {
  const file = resolve(OUT_DIR, `icon-${size}.png`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodePng(renderIcon(size), size))
  console.log(`иконка: ${file}`)
}
// отдельная maskable-иконка: full-bleed, лого в безопасной зоне
const maskableFile = resolve(OUT_DIR, 'maskable-512.png')
writeFileSync(maskableFile, encodePng(renderIcon(512, true), 512))
console.log(`иконка: ${maskableFile}`)
