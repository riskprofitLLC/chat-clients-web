// Stateless sealed box; формат: [SPKI эфемерного ключа 91Б][IV 12Б][шифротекст||тег].
// Порт crypto/src/commonMain/.../SealedBox.kt — байт-в-байт.
import { aesGcmDecrypt, aesGcmEncrypt, ecdh, generateKeyPair, randomBytes, sha256, SPKI_SIZE } from './primitives.js'
import { derive } from './hkdf.js'

export const PUBLIC_KEY_SIZE = SPKI_SIZE
const IV_SIZE = 12
const KEY_SIZE = 32
const INFO = new TextEncoder().encode('chat/crypto v1')

// соль связывает вывод HKDF с обоими ключами: [эфемерный SPKI][SPKI получателя]
async function sessionKey(shared: Uint8Array, pubE: Uint8Array, recipient: Uint8Array): Promise<Uint8Array> {
  const material = new Uint8Array(pubE.length + recipient.length)
  material.set(pubE, 0)
  material.set(recipient, pubE.length)
  return derive(shared, await sha256(material), INFO, KEY_SIZE)
}

export async function seal(recipientSpki: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  if (recipientSpki.length !== PUBLIC_KEY_SIZE) throw new Error('некорректный публичный ключ')
  const ephemeral = await generateKeyPair()
  const shared = await ecdh(ephemeral.secretPkcs8, recipientSpki)
  const key = await sessionKey(shared, ephemeral.publicSpki, recipientSpki)
  const iv = randomBytes(IV_SIZE)
  // AAD = SPKI получателя: подмена получателя ломает расшифровку
  const ct = await aesGcmEncrypt(key, iv, plaintext, recipientSpki)
  const out = new Uint8Array(PUBLIC_KEY_SIZE + IV_SIZE + ct.length)
  out.set(ephemeral.publicSpki, 0)
  out.set(iv, PUBLIC_KEY_SIZE)
  out.set(ct, PUBLIC_KEY_SIZE + IV_SIZE)
  return out
}

export async function open(
  secretPkcs8: Uint8Array,
  ownSpki: Uint8Array,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  if (sealed.length <= PUBLIC_KEY_SIZE + IV_SIZE) throw new Error('короткое сообщение')
  const pubE = sealed.subarray(0, PUBLIC_KEY_SIZE)
  const iv = sealed.subarray(PUBLIC_KEY_SIZE, PUBLIC_KEY_SIZE + IV_SIZE)
  const ct = sealed.subarray(PUBLIC_KEY_SIZE + IV_SIZE)
  const shared = await ecdh(secretPkcs8, pubE)
  const key = await sessionKey(shared, pubE, ownSpki)
  return aesGcmDecrypt(key, iv, ct, ownSpki)
}
