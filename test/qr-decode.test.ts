// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { qrMatrix } from '../src/util/qr.js'

// Независимый разбор QR: формат → маска → снятие маски → зигзаг codewords →
// де-интерливинг блоков → байты payload. Ловит ошибки размещения модулей
// и маскировки, которые структурные тесты не видят.

const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
  const positions: number[] = [6]
  for (let pos = size - 7; positions.length < numAlign; pos -= step) positions.splice(1, 0, pos)
  return positions.sort((a, b) => a - b)
}

function decode(qr: { size: number; modules: boolean[][] }): string {
  const { size, modules } = qr
  const ver = (size - 17) / 4

  // ── формат: первая копия вокруг левого верхнего узора ──
  const fmtBits: number[] = []
  for (let i = 0; i <= 5; i++) fmtBits[i] = modules[i][8] ? 1 : 0
  fmtBits[6] = modules[7][8] ? 1 : 0
  fmtBits[7] = modules[8][8] ? 1 : 0
  fmtBits[8] = modules[8][7] ? 1 : 0
  for (let i = 9; i < 15; i++) fmtBits[i] = modules[8][14 - i] ? 1 : 0
  let raw = 0
  fmtBits.forEach((b, i) => { raw |= b << i })
  const mask = ((raw ^ 0x5412) >> 10) & 0b111

  const invert = (x: number, y: number): boolean => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0
      case 1: return y % 2 === 0
      case 2: return x % 3 === 0
      case 3: return (x + y) % 3 === 0
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    }
  }

  // ── функциональные модули: восстанавливаем набор по спецификации ──
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const mark = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) isFunction[y][x] = true
  }
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6) }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy)
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8) }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i) }
  // информационные блоки версии (7+)
  if (ver >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      mark(a, b)
      mark(b, a)
    }
  }
  // узоры синхронизации: углы с поисковыми узорами пропускаем
  const alignPositions = alignmentPositions(ver, size)
  const lastIdx = alignPositions.length - 1
  for (let i = 0; i < alignPositions.length; i++) {
    for (let j = 0; j < alignPositions.length; j++) {
      const atFinder = (i === 0 && j === 0) || (i === 0 && j === lastIdx) || (i === lastIdx && j === 0)
      if (atFinder) continue
      const cx = alignPositions[i]
      const cy = alignPositions[j]
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) mark(cx + dx, cy + dy)
      }
    }
  }

  // ── зигзаг codewords ──
  const bits: number[] = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!isFunction[y][x]) bits.push(modules[y][x] !== invert(x, y) ? 1 : 0)
      }
    }
  }
  const codewords: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    codewords.push(byte)
  }

  // ── де-интерливинг: блоки спецификации из round-robin потока ──
  const eccPerBlock = ECC_PER_BLOCK[ver]
  const numBlocks = NUM_BLOCKS[ver]
  const rawCodewords = Math.floor(rawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)

  const blocks: number[][] = Array.from({ length: numBlocks }, () => [] as number[])
  let cursor = 0
  // блоки выровнены до shortBlockLen+1: у коротких на позиции выравнивания
  // стоит байт-заглушка, которого нет в общем потоке
  for (let i = 0; i <= shortBlockLen; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i === shortBlockLen - eccPerBlock && j < numShortBlocks) continue
      blocks[j].push(codewords[cursor++] ?? 0)
    }
  }
  const dataStream: number[] = []
  for (const block of blocks) {
    for (let i = 0; i < block.length - eccPerBlock; i++) dataStream.push(block[i])
  }

  const take = (pos: number, len: number): number => {
    let value = 0
    for (let i = pos; i < pos + len; i++) {
      const byte = dataStream[i >>> 3] ?? 0
      value = (value << 1) | ((byte >>> (7 - (i & 7))) & 1)
    }
    return value
  }

  let p = 0
  expect(take(p, 4)).toBe(0b0100) // байтовый режим
  p += 4
  const countBits = ver <= 9 ? 8 : 16
  const len = take(p, countBits)
  p += countBits
  const out: number[] = []
  for (let i = 0; i < len; i++) out.push(take(p + i * 8, 8))
  return new TextDecoder().decode(new Uint8Array(out))
}

describe('qrMatrix: payload читается обратно независимым разбором', () => {
  it('короткая строка', () => {
    expect(decode(qrMatrix('hello'))).toBe('hello')
  })

  it('код привязки nonce|secret', () => {
    const code = `${'0f1e2d3c4b5a6978'.repeat(4)}|${'a1b2c3d4e5f6a7b8'.repeat(4)}`
    expect(decode(qrMatrix(code))).toBe(code)
  })

  it('строка с разделителями и смешанным регистром', () => {
    const code = 'AbCd-1234|EfGh-5678'
    expect(decode(qrMatrix(code))).toBe(code)
  })

  it('длина кода на границу версии', () => {
    const code = `${'a'.repeat(60)}|${'b'.repeat(60)}`
    expect(decode(qrMatrix(code))).toBe(code)
  })
})
