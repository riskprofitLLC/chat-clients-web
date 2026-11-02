// Локальные секреты: ключ данных, PKCS8 идентичности, токен, логин, deviceId.
//
// Потолок web-платформы: аппаратного хранилища (AndroidKeyStore/Keychain)
// в браузере нет, поэтому ключ данных лежит в IndexedDB рядом с шифротекстом.
// Это защищает от «прочитал файлы профиля», но не от XSS на нашем же домене.
// Клиент честно предупреждает об этом в настройках безопасности.
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes } from '../crypto/primitives.js'
import { concat, equals, text, utf8 } from '../util/bytes.js'
import { newDataKey } from '../crypto/identity.js'
import type { Kv } from './kv.js'

const DATA_KEY = 'secrets:dataKey'
const IDENTITY = 'secrets:identity'
const TOKEN = 'secrets:token'
const LOGIN = 'secrets:login'
const DEVICE = 'secrets:deviceId'
const EMAIL = 'secrets:email'
const IV_SIZE = 12

export interface LocalIdentity {
  secretPkcs8: Uint8Array
  publicSpki: Uint8Array
}

export class SecretsStore {
  private dataKeyCache: Uint8Array | null = null

  constructor(private readonly kv: Kv) {}

  // ключ данных создаётся при первой регистрации и живёт до wipe
  async dataKey(): Promise<Uint8Array | null> {
    if (this.dataKeyCache) return this.dataKeyCache
    const raw = await this.kv.get(DATA_KEY)
    if (!raw) return null
    this.dataKeyCache = raw
    return raw
  }

  async ensureDataKey(): Promise<Uint8Array> {
    const existing = await this.dataKey()
    if (existing) return existing
    const key = newDataKey()
    await this.kv.put(DATA_KEY, key)
    this.dataKeyCache = key
    return key
  }

  async hasIdentity(): Promise<boolean> {
    return (await this.kv.get(IDENTITY)) !== null
  }

  private async seal(plain: Uint8Array): Promise<Uint8Array> {
    const key = await this.ensureDataKey()
    const iv = randomBytes(IV_SIZE)
    return concat(iv, await aesGcmEncrypt(key, iv, plain, new Uint8Array(0)))
  }

  private async openSealed(blob: Uint8Array | null): Promise<Uint8Array | null> {
    if (!blob || blob.length < IV_SIZE + 16) return null
    const key = await this.dataKey()
    if (!key) return null
    try {
      return await aesGcmDecrypt(key, blob.subarray(0, IV_SIZE), blob.subarray(IV_SIZE), new Uint8Array(0))
    } catch {
      return null
    }
  }

  async saveIdentity(identity: LocalIdentity): Promise<void> {
    // SPKI публичен, но лежит рядом с PKCS8: одна запись — одно место правды
    await this.kv.put(IDENTITY, concat(identity.secretPkcs8, identity.publicSpki))
  }

  async loadIdentity(): Promise<LocalIdentity | null> {
    const raw = await this.kv.get(IDENTITY)
    if (!raw) return null
    const publicSpki = raw.subarray(raw.length - 91)
    const secretPkcs8 = raw.subarray(0, raw.length - 91)
    if (secretPkcs8.length === 0) return null
    return { secretPkcs8: secretPkcs8.slice(), publicSpki: publicSpki.slice() }
  }

  async saveToken(token: string): Promise<void> {
    await this.kv.put(TOKEN, await this.seal(utf8(token)))
  }

  async token(): Promise<string | null> {
    const plain = await this.openSealed(await this.kv.get(TOKEN))
    return plain ? text(plain) : null
  }

  async saveLogin(login: string): Promise<void> {
    await this.kv.put(LOGIN, await this.seal(utf8(login)))
  }

  async login(): Promise<string | null> {
    const plain = await this.openSealed(await this.kv.get(LOGIN))
    return plain ? text(plain) : null
  }

  async saveEmail(email: string): Promise<void> {
    await this.kv.put(EMAIL, await this.seal(utf8(email)))
  }

  async email(): Promise<string | null> {
    const plain = await this.openSealed(await this.kv.get(EMAIL))
    return plain ? text(plain) : null
  }

  async saveDeviceId(deviceId: string): Promise<void> {
    await this.kv.put(DEVICE, utf8(deviceId))
  }

  async deviceId(): Promise<string> {
    const raw = await this.kv.get(DEVICE)
    if (raw) return text(raw)
    // идентификатор устройства — не секрет, но обязан быть стабильным
    const generated = `web${[...randomBytes(4)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
    await this.saveDeviceId(generated)
    return generated
  }

  // выход из аккаунта: токен и логин уходят, ключи и история остаются
  // для повторного входа (как Session.logout в Android)
  async logout(): Promise<void> {
    await this.kv.delete(TOKEN)
    await this.kv.delete(LOGIN)
    await this.kv.delete(EMAIL)
  }

  // «выйти и удалить данные»: полная очистка устройства
  async wipe(): Promise<void> {
    await this.kv.deletePrefix('secrets:')
    await this.kv.deletePrefix('j:')
    await this.kv.deletePrefix('jm:')
    await this.kv.deletePrefix('tofu:')
    await this.kv.deletePrefix('contact:')
    await this.kv.deletePrefix('outbox:')
    await this.kv.deletePrefix('draft:')
    await this.kv.deletePrefix('pin:')
    await this.kv.deletePrefix('read:')
    await this.kv.deletePrefix('media:')
    await this.kv.deletePrefix('call:')
    await this.kv.delete('prefs')
    this.dataKeyCache = null
  }
}

// сверка «тот же ли секрет» — для тестов и проверок целостности
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return equals(a, b)
}
