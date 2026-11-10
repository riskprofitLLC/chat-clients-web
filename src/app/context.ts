// Сборка приложения: хранилище, ключи, сеть, мессенджер, звонки.
// Аналог data/AppContainer.kt — одно место, где всё связано.
import { RelayApi } from '../net/api.js'
import { defaultKv, IdbKv, type Kv } from '../store/kv.js'
import { DEFAULT_SERVER } from '../store/prefs.js'
import { Journal } from '../store/journal.js'
import { SecretsStore } from '../store/secrets.js'
import { PrefsStore, type Prefs } from '../store/prefs.js'
import { KeysStore } from '../store/keys.js'
import { ContactsStore } from '../store/contacts.js'
import { GroupsStore } from '../store/groups.js'
import { ProfilesStore } from '../store/profiles.js'
import { CallLogStore, DraftsStore, MarksStore, MediaCache, PinsStore } from '../store/chat-state.js'
import { Messenger } from '../domain/messenger.js'
import { CallManager } from '../calls/manager.js'
import { SessionInfo } from './session.js'
import { generateIdentity, identityFromKeys, type E2E } from '../crypto/identity.js'
import { toBase64 } from '../util/b64.js'

export interface LoginResult {
  token: string
  userId: string
}

// dev-параметр ?server= принимаем только как http(s)-URL: иначе ссылка
// на dev-стенд уводила бы Bearer-токен и сообщения на произвольный хост
// (javascript:/data: и прочие схемы отсекаются)
export function devServerOverride(raw: string | null): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? raw : null
  } catch {
    return null
  }
}

export class AppContext {
  readonly kv: Kv
  readonly api: RelayApi
  readonly secrets: SecretsStore
  readonly prefsStore: PrefsStore
  readonly journal: Journal
  readonly keys: KeysStore
  readonly contacts: ContactsStore
  readonly groups: GroupsStore
  readonly profiles: ProfilesStore
  readonly drafts: DraftsStore
  readonly pins: PinsStore
  readonly marks: MarksStore
  readonly media: MediaCache
  readonly callLog: CallLogStore
  prefs: Prefs
  session: SessionInfo | null = null
  messenger: Messenger | null = null
  calls: CallManager | null = null

  private constructor(kv: Kv, prefs: Prefs) {
    this.kv = kv
    this.prefs = prefs
    this.api = new RelayApi(prefs.serverUrl)
    this.secrets = new SecretsStore(kv)
    this.prefsStore = new PrefsStore(kv)
    this.keys = new KeysStore(kv)
    this.contacts = new ContactsStore(kv)
    this.groups = new GroupsStore(kv)
    this.profiles = new ProfilesStore(kv)
    this.drafts = new DraftsStore(kv)
    this.pins = new PinsStore(kv)
    this.marks = new MarksStore(kv)
    this.media = new MediaCache(kv)
    this.callLog = new CallLogStore(kv)
    // до входа ключа данных нет, поэтому журнал заблокирован: операции с
    // историей падают с внятной ошибкой вместо «шифрования нулевым ключом»
    this.journal = new Journal(kv, null)
  }

  static async create(kv: Kv = defaultKv()): Promise<AppContext> {
    const prefsStore = new PrefsStore(kv)
    let prefs = await prefsStore.load()
    if (import.meta.env.DEV) {
      // dev: пока адрес не выбран, бьём в свой origin — vite проксирует /v1
      // на локальный релей, поэтому CSP connect-src 'self' не мешает
      const fromUrl = devServerOverride(new URLSearchParams(location.search).get('server'))
      const unset = !prefs.serverUrl || prefs.serverUrl === DEFAULT_SERVER
      if (fromUrl) prefs = await prefsStore.patch({ serverUrl: fromUrl })
      else if (unset) prefs = await prefsStore.patch({ serverUrl: location.origin })
    }
    const context = new AppContext(kv, prefs)
    void context.requestPersistence()
    return context
  }

  // «постоянное» хранилище: браузер не должен вычищать IndexedDB под давлением
  async requestPersistence(): Promise<boolean> {
    try {
      if (!navigator.storage?.persist) return false
      if (await navigator.storage.persisted?.()) return (this.storagePersisted = true)
      this.storagePersisted = await navigator.storage.persist()
    } catch {
      this.storagePersisted = false
    }
    return this.storagePersisted
  }

  storagePersisted = false

  // журнал получает ключ данных — до этого момента истории нет
  private rewireJournal(dataKey: Uint8Array): Journal {
    this.journal.unlock(dataKey)
    return this.journal
  }

  async savePrefs(changes: Partial<Prefs>): Promise<void> {
    this.prefs = await this.prefsStore.patch(changes)
    this.api.setBaseUrl(this.prefs.serverUrl)
  }

  async serverUrl(): Promise<string> {
    return this.prefs.serverUrl
  }

  // ─── вход и регистрация ────────────────────────────────────────────────

  // регистрация: email → код на почту → пароль; устройство привязывается сразу
  async register(email: string, code: string, password: string): Promise<LoginResult> {
    const dataKey = await this.secrets.ensureDataKey()
    this.rewireJournal(dataKey)
    const identity = await generateIdentity()
    const deviceId = await this.secrets.deviceId()
    const result = await this.api.register(email, code, password, deviceId, toBase64(identity.publicKey()))
    await this.secrets.saveIdentity(identity.keyBlobs())
    await this.secrets.saveToken(result.token)
    await this.secrets.saveLogin(result.userId)
    await this.secrets.saveEmail(email)
    await this.openSession(identity, result)
    return result
  }

  // вход: работает только для устройства, уже привязанного к аккаунту
  // (регистрацией или линковкой) — иначе сервер отвечает «устройство не привязано»
  async login(identifier: string, password: string, cloudPassword = ''): Promise<LoginResult> {
    const blobs = await this.secrets.loadIdentity()
    if (!blobs) throw new Error('на этом устройстве нет ключей: используйте привязку нового устройства')
    // без этого журнал остался бы на нулевом ключе: старая история нечитаема,
    // а новые записи шифровались бы мусором
    this.rewireJournal(await this.secrets.ensureDataKey())
    const deviceId = await this.secrets.deviceId()
    const result = await this.api.login(identifier, password, deviceId, cloudPassword)
    await this.secrets.saveToken(result.token)
    await this.secrets.saveLogin(result.userId)
    await this.openSession(identityFromKeys(blobs.secretPkcs8, blobs.publicSpki), result)
    return result
  }

  // ─── привязка нового устройства ────────────────────────────────────────
  // QR показывает НОВОЕ устройство: оно публикует свой ключ под одноразовым
  // кодом, ранее подключённое сканирует код и подтверждает.

  // шаг 1 нового устройства: генерация ключей в памяти + публикация.
  // На диск ключи попадут ТОЛЬКО после выдачи токена.
  async linkStart(): Promise<{ nonce: string; pollSecret: string; code: string; fingerprint: string }> {
    const dataKey = await this.secrets.ensureDataKey()
    this.rewireJournal(dataKey)
    const identity = await generateIdentity()
    const deviceId = await this.secrets.deviceId()
    const init = await this.api.linkInit(deviceId, toBase64(identity.publicKey()))
    const { sha256 } = await import('../crypto/primitives.js')
    const { toHex } = await import('../util/bytes.js')
    this.pendingIdentity = identity
    // QR несёт адрес сервера: подтверждающее устройство из любой сети
    // обратится именно к нему
    const server = this.api.serverUrl()
    return {
      nonce: init.nonce,
      pollSecret: init.pollSecret,
      code: `${init.nonce}|${toBase64(identity.publicKey())}|${deviceId}|${server}`,
      fingerprint: toHex(await sha256(identity.publicKey())).slice(0, 32),
    }
  }

  private pendingIdentity: E2E | null = null

  // шаг 2 нового устройства: опрос токена до подтверждения
  async linkPoll(nonce: string, pollSecret: string): Promise<LoginResult | null> {
    const result = await this.api.linkPoll(nonce, pollSecret)
    if (!result) return null
    const identity = this.pendingIdentity
    if (!identity) throw new Error('ключ привязки потерян: начните заново')
    await this.secrets.saveIdentity(identity.keyBlobs())
    await this.secrets.saveToken(result.token)
    await this.secrets.saveLogin(result.userId)
    await this.openSession(identity, result)
    this.pendingIdentity = null
    return result
  }

  // разбор кода с QR «nonce|pubB64|deviceId|server» на подтверждающем устройстве
  parseLinkOffer(code: string): { nonce: string; pubB64: string; deviceId?: string; server?: string } | null {
    const parts = code.trim().split('|')
    if (parts.length < 2) return null
    const [nonce, pubB64] = parts
    if (!/^[0-9a-f]{16,64}$/.test(nonce)) return null
    if (pubB64.length < 32) return null
    const deviceId = parts[2]?.trim() || undefined
    const server = parts[3]?.trim() || undefined
    // адрес без схемы невалиден: клиент обязан знать http/https
    if (server && !server.startsWith('http://') && !server.startsWith('https://')) return null
    return deviceId || server ? { nonce, pubB64, deviceId, server } : { nonce, pubB64 }
  }

  // шаг 3 ранее подключённого устройства: подтверждение по отпечатку.
  // Запрос уходит на сервер из QR — подтверждающее устройство могло
  // оказаться в другой сети.
  async linkConfirm(nonce: string, newDevicePub: string, server?: string): Promise<void> {
    if (!this.session) throw new Error('сначала войдите на этом устройстве')
    if (server) this.api.setBaseUrl(server)
    await this.api.linkConfirm(this.session.token, nonce.trim(), newDevicePub)
  }

  // ─── выход ─────────────────────────────────────────────────────────────

  async logout(): Promise<void> {
    // выход локальный: сервер запрещает отзыв ТЕКУЩЕГО устройства
    // (409 current_device) — чужой токен гасится только из списка устройств
    // в настройках. Как в Android-клиенте.
    this.messenger?.stop()
    this.messenger = null
    this.calls = null
    this.session = null
    await this.secrets.logout()
  }

  // полная очистка устройства: история, ключи, настройки, кэши, service worker
  async wipe(): Promise<void> {
    this.messenger?.stop()
    this.messenger = null
    this.calls = null
    this.session = null
    await this.secrets.wipe()
    // стираем саму базу, а не только записи: иначе остаются структуры и мета
    this.kv.close()
    await IdbKv.destroy()
    if (typeof caches !== 'undefined') {
      for (const key of await caches.keys()) await caches.delete(key)
    }
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      for (const registration of await navigator.serviceWorker.getRegistrations()) {
        await registration.unregister().catch(() => undefined)
      }
    }
    this.prefs = await this.prefsStore.load()
  }

  // ─── активная сессия ───────────────────────────────────────────────────

  async restore(): Promise<boolean> {
    const blobs = await this.secrets.loadIdentity()
    const token = await this.secrets.token()
    const login = await this.secrets.login()
    if (!blobs || !token || !login) return false
    const dataKey = await this.secrets.dataKey()
    if (dataKey) this.rewireJournal(dataKey)
    const identity = identityFromKeys(blobs.secretPkcs8, blobs.publicSpki)
    await this.openSession(identity, { token, userId: login })
    return true
  }

  private async openSession(identity: E2E, result: LoginResult): Promise<void> {
    const deviceId = await this.secrets.deviceId()
    const session = new SessionInfo(result.userId, result.token, deviceId, identity, this.api)
    this.session = session
    // ключ публикуем заново: после переустановки сервер мог знать старый
    try {
      await this.api.putKey(session.token, deviceId, toBase64(identity.publicKey()))
    } catch {
      // 409 «ключ уже закреплён» — норма для повторного входа
    }
    const messenger = new Messenger({
      kv: this.kv,
      api: this.api,
      session,
      journal: this.journal,
      prefs: this.prefsStore,
      keys: this.keys,
      contacts: this.contacts,
      groups: this.groups,
      profiles: this.profiles,
      drafts: this.drafts,
      pins: this.pins,
      marks: this.marks,
      media: this.media,
      callLog: this.callLog,
    })
    this.messenger = messenger
    this.calls = new CallManager(messenger, async () => this.prefs)
    await messenger.start()
  }
}
