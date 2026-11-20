// Утилиты над байтами: конкатенация, сравнение, hex, потоки.
// Комментарии — по-русски, код — на английском (правило репозитория).

export function concat(...parts: Uint8Array[]): Uint8Array {
  let size = 0
  for (const p of parts) size += p.length
  const out = new Uint8Array(size)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export function equals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function toHex(data: Uint8Array): string {
  let out = ''
  for (const b of data) out += b.toString(16).padStart(2, '0')
  return out
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

export function utf8(text: string): Uint8Array {
  return utf8Encoder.encode(text)
}

export function text(data: Uint8Array): string {
  return utf8Decoder.decode(data)
}
