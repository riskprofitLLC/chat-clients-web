// Идентичность устройства: пара ключей P-256 в блобах PKCS8/SPKI.
// Интерфейс повторяет crypto/src/commonMain/.../E2E.kt.
// ponytail: нет форвард-секреции (как в v1 Android); менять реализацию, не интерфейс.
import { generateKeyPair, type KeyBlobs } from './primitives.js'
import { open, seal } from './sealedbox.js'

export interface E2E {
  publicKey(): Uint8Array
  seal(recipientPub: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>
  open(ciphertext: Uint8Array): Promise<Uint8Array>
  // блобы ключа: нужны, чтобы положить идентичность в хранилище устройства
  // и пережить перезапуск (в Android это делает KeyVault)
  keyBlobs(): KeyBlobs
}

class CryptoIdentity implements E2E {
  constructor(private readonly blobs: KeyBlobs) {}

  publicKey(): Uint8Array {
    return this.blobs.publicSpki
  }

  seal(recipientPub: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    return seal(recipientPub, plaintext)
  }

  open(ciphertext: Uint8Array): Promise<Uint8Array> {
    return open(this.blobs.secretPkcs8, this.blobs.publicSpki, ciphertext)
  }

  keyBlobs(): KeyBlobs {
    return this.blobs
  }
}

export async function generateIdentity(): Promise<E2E> {
  return new CryptoIdentity(await generateKeyPair())
}

export function identityFromKeys(secretPkcs8: Uint8Array, publicSpki: Uint8Array): E2E {
  return new CryptoIdentity({ secretPkcs8, publicSpki })
}

// ключ данных: им шифруются записи журнала и локальные секреты (токен, PKCS8).
// В Android это AndroidKeyStore; в браузере аппаратного хранилища нет —
// ключ лежит в IndexedDB, поэтому веб-клиент честно предупреждает об этом.
export function newDataKey(): Uint8Array {
  const key = new Uint8Array(32)
  globalThis.crypto.getRandomValues(key)
  return key
}
