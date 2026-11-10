// Минимальный генератор QR (модель 2, байтовый режим, уровень коррекции M,
// версии 1..10) без сторонних зависимостей: клиент не тянет библиотеку ради
// одного кода привязки. Таблицы спецификации — по ISO/IEC 18004.

export type QrMatrix = { size: number; modules: boolean[][] }

// кодов коррекции на блок и число блоков для уровня M (индекс 0 — заглушка)
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]

const MIN_VERSION = 1
const MAX_VERSION = 10

// модули данных без функциональных — формула стандарта от номера версии
function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36 // информационные блоки версии
  }
  return result
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver]
}

// бит под счётчик символов в байтовом режиме
function charCountBits(ver: number): number {
  return ver <= 9 ? 8 : 16
}

function pickVersion(byteLen: number): number {
  for (let ver = MIN_VERSION; ver <= MAX_VERSION; ver++) {
    if (4 + charCountBits(ver) + byteLen * 8 <= dataCodewords(ver) * 8) return ver
  }
  throw new Error('код привязки слишком длинный для QR')
}

function appendBits(value: number, len: number, out: number[]): void {
  for (let i = len - 1; i >= 0; i--) out.push((value >>> i) & 1)
}

// ─── арифметика поля GF(2^8/0x11D) ───

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

// порождающий полином заданной степени (коэффициенты от старшего к младшему)
function rsDivisor(degree: number): number[] {
  const result: number[] = new Array<number>(degree).fill(0)
  result.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return result
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    divisor.forEach((coef, i) => {
      result[i] ^= gfMul(coef, factor)
    })
  }
  return result
}

// данные с добавленной коррекцией, перемешанные поблочно по стандарту
function eccAndInterleave(data: readonly number[], ver: number): number[] {
  const numBlocks = NUM_BLOCKS[ver]
  const blockEccLen = ECC_PER_BLOCK[ver]
  const rawCodewords = Math.floor(rawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)

  const blocks: number[][] = []
  const div = rsDivisor(blockEccLen)
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, div)
    if (i < numShortBlocks) dat.push(0)
    blocks.push(dat.concat(ecc))
  }

  const result: number[] = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      // байт-заглушка коротких блоков в общий поток не выходит
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i])
    })
  }
  return result
}

// позиции узоров синхронизации по осям (возрастающие)
function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return []
  const numAlign = Math.floor(version / 7) + 2
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
  const positions: number[] = [6]
  for (let pos = size - 7; positions.length < numAlign; pos -= step) positions.splice(1, 0, pos)
  return positions.sort((a, b) => a - b)
}

export function qrMatrix(text: string): QrMatrix {
  const bytes = Array.from(new TextEncoder().encode(text))
  const version = pickVersion(bytes.length)
  const size = version * 4 + 17

  // поток данных: режим + счётчик + байты + терминатор + выравнивание + заполнители
  const bits: number[] = []
  appendBits(0b0100, 4, bits) // байтовый режим
  appendBits(bytes.length, charCountBits(version), bits)
  for (const b of bytes) appendBits(b, 8, bits)
  const capacityBits = dataCodewords(version) * 8
  appendBits(0, Math.min(4, capacityBits - bits.length), bits)
  appendBits(0, (8 - (bits.length % 8)) % 8, bits)
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bits)

  const dataBytes: number[] = new Array<number>(bits.length / 8).fill(0)
  bits.forEach((b, i) => {
    dataBytes[i >>> 3] |= b << (7 - (i & 7))
  })

  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))

  const setFunction = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark
    isFunction[y][x] = true
  }

  // синхропоследовательности
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0)
    setFunction(i, 6, i % 2 === 0)
  }
  // три поисковых узора с разделителями
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, dist !== 2 && dist !== 4)
      }
    }
  }
  // узоры синхронизации — по возрастающим позициям стандарта
  const alignPositions = alignmentPositions(version, size)
  const lastIdx = alignPositions.length - 1
  for (let i = 0; i < alignPositions.length; i++) {
    for (let j = 0; j < alignPositions.length; j++) {
      // углы, занятые поисковыми узорами, пропускаем; правый нижний — нет
      const atFinder = (i === 0 && j === 0) || (i === 0 && j === lastIdx) || (i === lastIdx && j === 0)
      if (atFinder) continue
      const cx = alignPositions[i]
      const cy = alignPositions[j]
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }
  // формат: уровень M (биты 01) + маска; 15 бит с кодом БЧХ
  const drawFormat = (mask: number) => {
    const data = 0b01 << 3 | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const fmt = ((data << 10 | rem) ^ 0x5412) & 0x7fff
    const bit = (i: number) => ((fmt >>> i) & 1) !== 0
    for (let i = 0; i <= 5; i++) setFunction(8, i, bit(i))
    setFunction(8, 7, bit(6))
    setFunction(8, 8, bit(7))
    setFunction(7, 8, bit(8))
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(i))
    setFunction(8, size - 8, true) // всегда тёмный
  }
  // версия: 18 бит с кодом БЧХ, только для 7+
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const vbits = (version << 12 | rem) & 0x3ffff
    for (let i = 0; i < 18; i++) {
      const dark = ((vbits >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFunction(a, b, dark)
      setFunction(b, a, dark)
    }
  }
  drawFormat(0) // значение маски уточняется ниже

  // кодовые слова зигзагом из правого нижнего угла, столбец 6 пропускаем
  const allCodewords = eccAndInterleave(dataBytes, version)
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!isFunction[y][x] && i < allCodewords.length * 8) {
          modules[y][x] = ((allCodewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0
          i++
        }
      }
    }
  }
  // маски: выбираем по штрафу спецификации, затем перерисовываем формат
  const maskInvert = (mask: number, x: number, y: number): boolean => {
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
  const penalty = (): number => {
    let score = 0
    // длинные однотонные полосы по строкам и столбцам
    for (let y = 0; y < size; y++) {
      let run = 1
      for (let x = 1; x < size; x++) {
        if (modules[y][x] === modules[y][x - 1]) {
          run++
          if (run === 5) score += 3
          else if (run > 5) score += 1
        } else run = 1
      }
    }
    for (let x = 0; x < size; x++) {
      let run = 1
      for (let y = 1; y < size; y++) {
        if (modules[y][x] === modules[y - 1][x]) {
          run++
          if (run === 5) score += 3
          else if (run > 5) score += 1
        } else run = 1
      }
    }
    // блоки 2x2 одного цвета
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x]
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3
      }
    }
    // баланс тёмного и светлого
    let dark = 0
    for (const row of modules) for (const c of row) if (c) dark++
    const total = size * size
    score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
    return score
  }
  let bestMask = 0
  let bestPenalty = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && maskInvert(mask, x, y)) modules[y][x] = !modules[y][x]
      }
    }
    drawFormat(mask)
    const score = penalty()
    if (score < bestPenalty) {
      bestPenalty = score
      bestMask = mask
    }
    // снимаем маску обратно (XOR) — следующая итерация считает с чистого листа
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && maskInvert(mask, x, y)) modules[y][x] = !modules[y][x]
      }
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && maskInvert(bestMask, x, y)) modules[y][x] = !modules[y][x]
    }
  }
  drawFormat(bestMask)
  return { size, modules }
}
