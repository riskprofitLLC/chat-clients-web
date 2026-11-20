// HKDF по RFC 5869 (extract-then-expand) поверх HMAC-SHA256.
// Порт crypto/src/commonMain/.../Hkdf.kt: тот же порядок salt/ikm.
import { hmacSha256 } from './primitives.js'

export async function extract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(salt, ikm)
}

export async function expand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  if (length < 1 || length > 255 * 32) throw new Error(`некорректная длина OKM: ${length}`)
  const out = new Uint8Array(length)
  let filled = 0
  let counter = 1
  let prev: Uint8Array = new Uint8Array(0)
  while (filled < length) {
    const block = new Uint8Array(prev.length + info.length + 1)
    block.set(prev, 0)
    block.set(info, prev.length)
    block[block.length - 1] = counter
    prev = await hmacSha256(prk, block)
    const take = Math.min(prev.length, length - filled)
    out.set(prev.subarray(0, take), filled)
    filled += take
    counter++
  }
  return out
}

export async function derive(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  return expand(await extract(salt, ikm), info, length)
}
