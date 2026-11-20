// PBKDF2-HMAC-SHA256 на WebCrypto: та же схема и те же 600k итераций,
// что в Android (domain/Pbkdf2.kt + PinCrypto) — PIN и бэкап совместимы.
import { toBase64, fromBase64 } from '../util/b64.js'

export const PIN_ITERATIONS = 600_000
const SALT_BYTES = 16
const KEY_BYTES = 32

function subtleOrThrow(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('WebCrypto недоступен: откройте страницу по https или с localhost')
  return subtle
}

// своя копия байтов: WebCrypto принимает только ArrayBuffer-backed view
function bufBytes(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy.buffer
}

// вывод ключа; iterations/bits параметризуем для векторов в тестах
export async function derivePbkdf2(
  password: Uint8Array,
  salt: Uint8Array,
  iterations = PIN_ITERATIONS,
  keyBytes = KEY_BYTES,
): Promise<Uint8Array> {
  if (iterations < 1) throw new Error('некорректное число итераций')
  if (keyBytes < 1) throw new Error('некорректная длина ключа')
  const key = await subtleOrThrow().importKey('raw', bufBytes(password), 'PBKDF2', false, ['deriveBits'])
  // WebCrypto принимает длину в БИТАХ, а вызывающий код — в байтах
  const out = await subtleOrThrow().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bufBytes(salt), iterations }, key, keyBytes * 8)
  return new Uint8Array(out)
}

export function newSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_BYTES)
  globalThis.crypto.getRandomValues(salt)
  return salt
}

// хэш PIN в base64 — как PinCrypto.pbkdf2 на Android
export async function pinHash(pin: string, saltB64: string): Promise<string> {
  const salt = fromBase64(saltB64)
  if (!salt || salt.length === 0) throw new Error('некорректная соль PIN')
  return toBase64(await derivePbkdf2(new TextEncoder().encode(pin), salt))
}

export function newPinSalt(): string {
  return toBase64(newSalt())
}