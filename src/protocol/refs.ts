// Стабильная ссылка на сообщение: sha256(content)[:8 байт] в hex.
// Байты content идентичны у обеих сторон (sealed-блоб передаётся как есть),
// поэтому ref совпадает у отправителя и получателя — в отличие от ts.
import { sha256 } from '../crypto/primitives.js'
import { toHex } from '../util/bytes.js'

export async function refOf(content: Uint8Array): Promise<string> {
  const hash = await sha256(content)
  return toHex(hash.subarray(0, 8))
}

// сопоставление ссылки с содержимым: старые 8-hex ссылки — по префиксу
export async function refMatches(ref: string, content: Uint8Array): Promise<boolean> {
  const current = await refOf(content)
  return ref.length === 8 ? current.startsWith(ref) : current === ref
}

export function sameRef(a: string, b: string): boolean {
  return a === b || (a.length === 8 && b.startsWith(a)) || (b.length === 8 && a.startsWith(b))
}

export function fullRef(author: string, ref: string): string {
  return `${author}/${ref}`
}
