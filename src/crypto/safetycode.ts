// 6-значный код сверки двух публичных ключей (анти-MITM); порядок ключей не важен.
// Порт crypto/src/commonMain/.../SafetyCode.kt: sha256 от отсортированной пары,
// первые 4 байта big-endian, остаток от 1 000 000.
import { sha256 } from './primitives.js'

function less(a: Uint8Array, b: Uint8Array): boolean {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return a.length < b.length
}

export async function safetyCode(pubA: Uint8Array, pubB: Uint8Array): Promise<string> {
  const [a, b] = less(pubA, pubB) ? [pubA, pubB] : [pubB, pubA]
  const material = new Uint8Array(a.length + b.length)
  material.set(a, 0)
  material.set(b, a.length)
  const hash = await sha256(material)
  const value = ((hash[0] << 24) >>> 0) + (hash[1] << 16) + (hash[2] << 8) + hash[3]
  return String(value % 1_000_000).padStart(6, '0')
}
