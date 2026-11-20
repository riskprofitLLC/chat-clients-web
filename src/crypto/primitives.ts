// Платформенные криптопримитивы на WebCrypto.
// Байт-в-байт совместимы с JVM-версией (crypto/src/jvmMain/.../PrimitivesJvm.kt):
// те же SPKI/PKCS8-блобы, та же x-координата общей точки, тот же AES-GCM.

// на небезопасном контексте (plain http не на localhost) WebCrypto недоступен:
// тогда crypto.subtle === undefined и операции падают с невнятной ошибкой.
// Даём понятное сообщение один раз.
const subtle = globalThis.crypto?.subtle
if (!subtle) {
  throw new Error('WebCrypto недоступен: откройте страницу по https или с localhost — иначе ключи не сгенерировать')
}

export const SPKI_SIZE = 91 // P-256 SPKI в DER, как у JCA
export const PKCS8_SIZE = 138 // P-256 PKCS8 в DER (фиксированная длина)

// обёртка над ArrayBuffer: WebCrypto работает буферами, клиент — байтами
export function buf(bytes: Uint8Array): ArrayBuffer {
  // срез гарантирует собственный ArrayBuffer без смещения/длины
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function bytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

export function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size)
  globalThis.crypto.getRandomValues(out)
  return out
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return bytes(await subtle.digest('SHA-256', buf(data)))
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await subtle.importKey(
    'raw',
    buf(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return bytes(await subtle.sign('HMAC', cryptoKey, buf(data)))
}

// пара ключей P-256 в блобах PKCS8/SPKI — формат идентичности устройства
export interface KeyBlobs {
  secretPkcs8: Uint8Array
  publicSpki: Uint8Array
}

export async function generateKeyPair(): Promise<KeyBlobs> {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const secret = bytes(await subtle.exportKey('pkcs8', pair.privateKey))
  const publicSpki = bytes(await subtle.exportKey('spki', pair.publicKey))
  if (publicSpki.length !== SPKI_SIZE) {
    throw new Error(`неожиданный размер SPKI: ${publicSpki.length}`)
  }
  return { secretPkcs8: secret, publicSpki }
}

async function importPrivate(secretPkcs8: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('pkcs8', buf(secretPkcs8), { name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])
}

async function importPublic(publicSpki: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('spki', buf(publicSpki), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
}

// ECDH: сырой секрет — x-координата общей точки (32 байта), как generateSecret у JCA
export async function ecdh(secretPkcs8: Uint8Array, publicSpki: Uint8Array): Promise<Uint8Array> {
  const priv = await importPrivate(secretPkcs8)
  const pub = await importPublic(publicSpki)
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256)
  return bytes(bits)
}

// 16/24/32 — AES-128/192/256; схема использует 32, вектор McGrew-Viega — 16
async function aesKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new Error(`некорректная длина ключа AES-GCM: ${key.length}`)
  }
  return subtle.importKey('raw', buf(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

// WebCrypto кладёт тег в конец шифротекста — как JCA "AES/GCM/NoPadding"
export async function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const cipher = await subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad), tagLength: 128 },
    await aesKey(key),
    buf(plaintext),
  )
  return bytes(cipher)
}

export async function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad), tagLength: 128 },
    await aesKey(key),
    buf(ciphertext),
  )
  return bytes(plain)
}
