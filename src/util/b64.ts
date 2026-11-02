// base64 (standard, с паддингом) без зависимостей.
// btoa/atob требуют промежуточной строки на весь объём — для 10-МБ медиа
// это лишние копии и риск переполнения стека на spread; таблицы дешевле.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const ENCODE = new Uint8Array(64)
for (let i = 0; i < ALPHABET.length; i++) ENCODE[i] = ALPHABET.charCodeAt(i)

const DECODE = new Int16Array(256).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i

export function toBase64(data: Uint8Array): string {
  const out = new Array<string>((data.length + 2) / 3 | 0)
  let oi = 0
  let i = 0
  for (; i + 2 < data.length; i += 3) {
    const n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    out[oi++] = String.fromCharCode(
      ENCODE[(n >> 18) & 63],
      ENCODE[(n >> 12) & 63],
      ENCODE[(n >> 6) & 63],
      ENCODE[n & 63],
    )
  }
  const rest = data.length - i
  if (rest === 1) {
    const n = data[i] << 16
    out[oi++] = String.fromCharCode(ENCODE[(n >> 18) & 63], ENCODE[(n >> 12) & 63], 61, 61)
  } else if (rest === 2) {
    const n = (data[i] << 16) | (data[i + 1] << 8)
    out[oi++] = String.fromCharCode(
      ENCODE[(n >> 18) & 63],
      ENCODE[(n >> 12) & 63],
      ENCODE[(n >> 6) & 63],
      61,
    )
  }
  return out.join('')
}

// null — невалидный base64 (как Base64.getDecoder() в Kotlin)
export function fromBase64(text: string): Uint8Array | null {
  const clean = text.trim()
  if (clean.length % 4 !== 0) return null
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  const out = new Uint8Array((clean.length / 4) * 3 - pad)
  let oi = 0
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = DECODE[clean.charCodeAt(i)]
    const c1 = DECODE[clean.charCodeAt(i + 1)]
    const ch2 = clean.charCodeAt(i + 2)
    const ch3 = clean.charCodeAt(i + 3)
    const c2 = ch2 === 61 ? 0 : DECODE[ch2]
    const c3 = ch3 === 61 ? 0 : DECODE[ch3]
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return null
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3
    if (oi < out.length) out[oi++] = (n >> 16) & 0xff
    if (oi < out.length) out[oi++] = (n >> 8) & 0xff
    if (oi < out.length) out[oi++] = n & 0xff
  }
  return out
}
